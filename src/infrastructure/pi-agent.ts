import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AuthCheck,
  type Message,
  type Model,
  type ModelThinkingLevel,
  type ProviderResponse,
  type SimpleStreamOptions,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { validateToolArguments } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  AgentFailure,
  normalizeUsage,
  type AgentPort,
  type AgentReply,
  type AgentReplyOptions,
  type AgentTrace,
  type AttemptTrace,
  type ControlReport,
  type ControlTrace,
  type ModelIdentity,
  type NormalizedUsage,
  type RequestedControls,
  type ThinkingLevel,
  type TurnRequest,
  type UsageEvidence,
  type UsageObservation,
} from "../domain/agent";
import type { ModelInputMessage } from "../domain/context";
import {
  createToolDispatcher,
  ToolExecutorError,
  type ToolCallRecord,
  type ToolDispatcher,
  type ToolExecutor,
} from "../domain/tool-loop";
import { resolveToolPolicy, type ToolCapabilityPolicy } from "../domain/tool-policy";

export type ModelStream = StreamFn;

export interface PiToolRegistration {
  toolId: string;
  schemaVersion: string;
  tool: AgentTool;
}

export interface PiModelRuntime {
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  streamSimple: ModelStream;
}

export interface PiAgentOptions {
  model: Model<Api>;
  modelStream: ModelStream;
  usageEvidence: UsageEvidence;
  tools?: readonly PiToolRegistration[];
  secrets?: readonly string[];
  now?: () => number;
}

export interface CreatePiAgentFromRuntimeOptions {
  runtime: PiModelRuntime;
  model: ModelIdentity;
  usageEvidence?: UsageEvidence;
  tools?: readonly PiToolRegistration[];
  now?: () => number;
}

interface ObservedResponse {
  response: ProviderResponse;
  turnSequence: number;
}

interface ModelStep {
  responses: readonly ObservedResponse[];
  message: AssistantMessage;
  /** Sequence reserved at completion for a step with no observed response. */
  fallbackSequence?: number;
}

interface ResolvedControls {
  report: ControlReport;
  thinkingLevel: ModelThinkingLevel;
  temperature?: number;
  maxTokens?: number;
}

export function streamFromModelRuntime(runtime: Pick<ModelRuntime, "streamSimple">): ModelStream {
  return (model, context, options) => runtime.streamSimple(model, context, options);
}

export async function createPiAgentFromRuntime(
  options: CreatePiAgentFromRuntimeOptions,
): Promise<PiAgent> {
  const model = options.runtime.getModel(options.model.providerId, options.model.modelId);
  if (!model) {
    throw new Error(`model is unavailable: ${options.model.providerId}/${options.model.modelId}`);
  }

  const auth = await options.runtime.checkAuth(options.model.providerId);
  if (!auth) {
    throw new Error(`authentication is unavailable for provider: ${options.model.providerId}`);
  }

  return new PiAgent({
    model,
    modelStream: (requestModel, context, streamOptions) => options.runtime.streamSimple(
      requestModel,
      context,
      streamOptions,
    ),
    usageEvidence: structuredClone(options.usageEvidence ?? {
      explicitlyReported: [],
      source: "pi-ai-fields-without-provider-reporting-evidence",
    }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export class PiAgent implements AgentPort {
  private readonly agent: Agent;
  private readonly baseStream: ModelStream;
  private readonly unsubscribe: () => void;
  private readonly model: Model<Api>;
  private readonly usageEvidence: UsageEvidence;
  private readonly toolsByIdentity: ReadonlyMap<string, AgentTool>;
  private readonly now: () => number;
  private readonly secrets: readonly string[];
  private activeResponses: ObservedResponse[] | undefined;
  private turnSequenceCounter = 0;
  private activeReply: Promise<AgentReply> | undefined;
  private turnAbort: AbortController | undefined;
  private isDisposed = false;

  constructor(options: PiAgentOptions) {
    this.model = options.model;
    this.usageEvidence = structuredClone(options.usageEvidence);
    this.toolsByIdentity = toolRegistrationMap(options.tools ?? []);
    this.now = options.now ?? Date.now;
    this.secrets = [...(options.secrets ?? [])];
    this.baseStream = (model, context, streamOptions) => options.modelStream(
      model,
      context,
      this.withAttemptObservation(streamOptions),
    );
    this.agent = new Agent({
      initialState: {
        model: options.model,
        systemPrompt: "",
        thinkingLevel: "off",
        tools: [],
      },
      streamFn: this.baseStream,
    });
    this.unsubscribe = this.agent.subscribe(() => {});
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  get messageCount(): number {
    return this.agent.state.messages.length;
  }

  reply(request: TurnRequest, options: AgentReplyOptions = {}): Promise<AgentReply> {
    if (this.isDisposed) return Promise.reject(new Error("Pi agent is disposed"));
    if (this.activeReply) return Promise.reject(new Error("Pi agent is already processing a turn"));
    if (options.signal?.aborted) {
      return Promise.reject(new AgentFailure({
        code: "cancelled",
        message: "Pi agent reply was cancelled",
        trace: { attempts: [] },
      }));
    }

    const operation = this.runReply(request, options);
    this.activeReply = operation;
    void operation.then(
      () => {
        if (this.activeReply === operation) this.activeReply = undefined;
      },
      () => {
        if (this.activeReply === operation) this.activeReply = undefined;
      },
    );
    return operation;
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.turnAbort?.abort();
    this.agent.abort();
    if (this.activeReply) {
      try {
        await this.activeReply;
      } catch {
        // The caller receives the original reply error; disposal still completes.
      }
    }
    await this.agent.waitForIdle();
    this.unsubscribe();
    this.agent.reset();
    this.isDisposed = true;
  }

  private async runReply(request: TurnRequest, options: AgentReplyOptions): Promise<AgentReply> {
    const controls = resolveControls(this.model, request.controls);
    if (request.capabilities.evidence === "unrecorded") {
      if (request.capabilities.toolNames.length > 0) {
        throw new Error("cannot execute unrecorded tool capabilities");
      }
    }
    const resolvedPolicy = request.capabilities.evidence === "recorded"
      ? resolveToolPolicy(request.capabilities, {
          role: { id: request.role.id, version: request.role.version },
          phase: request.capabilities.phase,
        })
      : undefined;
    const { definitions, dispatcher, schemaVersions } = this.buildTurnTools(
      request.turnId,
      resolvedPolicy,
    );

    const contextMessages = request.context.messages;
    const finalContextMessage = contextMessages[contextMessages.length - 1];
    if (!finalContextMessage) throw new Error("selected model input must contain at least one message");
    if (finalContextMessage.role !== "user") {
      throw new Error("selected model input must end with a user message");
    }
    const messages: Message[] = contextMessages.map(
      (message) => toAgentMessage(message, this.model),
    );

    this.agent.state.systemPrompt = request.role.systemPrompt;
    this.agent.state.model = this.model;
    this.agent.state.thinkingLevel = controls.thinkingLevel;

    const observedResponses: ObservedResponse[] = [];
    this.activeResponses = observedResponses;
    this.turnSequenceCounter = 0;
    const startedAt = this.now();
    const stream = this.wrapControls(this.baseStream, controls);
    const controller = new AbortController();
    this.turnAbort = controller;
    const onAbort = (): void => {
      controller.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const failureToolCalls = (): { toolCalls?: readonly ToolCallRecord[] } =>
      dispatcher === undefined ? {} : { toolCalls: dispatcher.trace() };

    let message: AssistantMessage;
    const steps: ModelStep[] = [];
    try {
      // The project owns the tool loop: Pi core never executes tools, so every
      // model tool call reaches the dispatcher and its canonical trace.
      const maxIterations = resolvedPolicy === undefined
        ? 1
        : resolvedPolicy.aggregateCallLimit + 2;
      let iteration = 0;
      for (;;) {
        iteration += 1;
        const responsesBefore = observedResponses.length;
        const events = await stream(this.model, {
          systemPrompt: request.role.systemPrompt,
          messages: [...messages],
          ...(definitions.length === 0 ? {} : { tools: definitions }),
        }, {
          ...(controls.thinkingLevel === "off" ? {} : { reasoning: controls.thinkingLevel }),
          signal: controller.signal,
        });
        message = await events.result();
        const stepResponses = observedResponses.slice(responsesBefore);
        steps.push({
          responses: stepResponses,
          message,
          // Reserve the shared position now so later tool calls sequence after it.
          ...(stepResponses.length === 0 ? { fallbackSequence: this.nextTurnSequence() } : {}),
        });
        messages.push(message);
        if (message.stopReason === "error" || message.stopReason === "aborted") break;

        const toolCalls = message.content.filter(
          (content): content is ToolCall => content.type === "toolCall",
        );
        if (toolCalls.length === 0) break;
        if (dispatcher === undefined) {
          throw new PiProtocolError(
            "model returned tool calls for a turn without a recorded tool policy",
          );
        }
        // Dispatch before any guard so every model-returned call is recorded.
        for (const toolCall of toolCalls) {
          const record = await dispatcher.dispatch({
            toolId: toolCall.name,
            schemaVersion: schemaVersions.get(toolCall.name) ?? "unspecified",
            arguments: toolCall.arguments,
          }, { signal: controller.signal, turnSequence: this.nextTurnSequence() });
          messages.push(toToolResultMessage(toolCall, record));
        }
        if (iteration >= maxIterations) {
          throw new PiProtocolError("tool loop exceeded the policy call budget");
        }
      }
    } catch (error) {
      this.activeResponses = undefined;
      const pending = observedResponses.slice(
        steps.reduce((count, step) => count + step.responses.length, 0),
      );
      const isProtocolFailure = error instanceof PiProtocolError;
      throw new AgentFailure({
        code: options.signal?.aborted
          ? "cancelled"
          : isProtocolFailure
            ? "protocol_failure"
            : "provider_failure",
        message: toError(error).message,
        trace: buildFailureTrace(
          steps,
          pending,
          this.usageEvidence,
          options.signal?.aborted ? "aborted" : "failed",
          () => this.nextTurnSequence(),
          // A local protocol failure ends the loop between model steps; no
          // additional adapter attempt occurred, so none is synthesized.
          !isProtocolFailure,
        ),
        ...failureToolCalls(),
      });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      if (this.turnAbort === controller) this.turnAbort = undefined;
    }
    const durationMs = Math.max(0, this.now() - startedAt);
    this.activeResponses = undefined;

    const usage = sumNormalizedUsage(steps.map(
      (step) => normalizeUsage(toUsageObservation(step.message, this.usageEvidence)),
    ));
    const trace = buildSteppedTrace(steps, this.usageEvidence, () => this.nextTurnSequence());
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new AgentFailure({
        code: message.stopReason === "aborted" ? "cancelled" : "provider_failure",
        message: message.errorMessage ?? `provider stopped with ${message.stopReason}`,
        trace,
        ...failureToolCalls(),
      });
    }
    this.agent.state.messages = messages;
    const model = responseModelIdentity(message);
    const report = withVerifiedModel(controls.report, providerVerifiedModelIdentity(message));

    return {
      text: message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join(""),
      durationMs,
      model,
      controls: report,
      usage,
      trace,
      toolCalls: dispatcher === undefined ? [] : structuredClone(dispatcher.trace()),
    };
  }

  private buildTurnTools(
    turnId: string,
    policy: ToolCapabilityPolicy | undefined,
  ): {
    definitions: AgentTool[];
    dispatcher: ToolDispatcher | undefined;
    schemaVersions: ReadonlyMap<string, string>;
  } {
    if (!policy) {
      return { definitions: [], dispatcher: undefined, schemaVersions: new Map() };
    }
    const registrations = policy.allowedTools.map(({ toolId, schemaVersion }) => {
      const tool = this.toolsByIdentity.get(toolIdentityKey(toolId, schemaVersion));
      if (!tool) {
        throw new Error(`tool is unavailable in environment: ${toolId}@${schemaVersion}`);
      }
      return { toolId, schemaVersion, tool };
    });
    const executors: ToolExecutor[] = registrations.map(({ toolId, schemaVersion, tool }) => ({
      toolId,
      schemaVersion,
      execute: async (args, context) => {
        let validated: unknown;
        try {
          validated = validateToolArguments(tool, {
            type: "toolCall",
            id: context.callId,
            name: toolId,
            arguments: args as Record<string, unknown>,
          });
        } catch {
          throw new ToolExecutorError({
            code: "malformed_arguments",
            message: "tool call arguments do not match the tool schema",
          });
        }
        const result = await tool.execute(context.callId, validated, context.signal);
        const unsupported = result.content.find((content) => content.type !== "text");
        if (unsupported) {
          throw new ToolExecutorError({
            code: "unsupported_result_content",
            message: `tool returned unsupported non-text content: ${unsupported.type}`,
          });
        }
        return result.content
          .filter((content) => content.type === "text")
          .map((content) => content.text)
          .join("");
      },
    }));
    return {
      definitions: registrations.map(({ tool }) => tool),
      dispatcher: createToolDispatcher({
        dispatchId: turnId,
        policy,
        executors,
        secrets: this.secrets,
        now: this.now,
      }),
      schemaVersions: new Map(
        registrations.map(({ toolId, schemaVersion }) => [toolId, schemaVersion]),
      ),
    };
  }

  private withAttemptObservation(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
    const existingOnResponse = options?.onResponse;
    return {
      ...options,
      onResponse: async (response, model) => {
        this.activeResponses?.push({
          response,
          turnSequence: this.nextTurnSequence(),
        });
        await existingOnResponse?.(response, model);
      },
    };
  }

  private nextTurnSequence(): number {
    this.turnSequenceCounter += 1;
    return this.turnSequenceCounter;
  }

  private wrapControls(stream: ModelStream, controls: ResolvedControls): ModelStream {
    return (model, context, options) => stream(model, context, {
      ...options,
      ...(controls.temperature === undefined ? {} : { temperature: controls.temperature }),
      ...(controls.maxTokens === undefined ? {} : { maxTokens: controls.maxTokens }),
    });
  }
}

function toolRegistrationMap(
  registrations: readonly PiToolRegistration[],
): ReadonlyMap<string, AgentTool> {
  const tools = new Map<string, AgentTool>();
  for (const registration of registrations) {
    if (registration.toolId.trim().length === 0 || registration.schemaVersion.trim().length === 0) {
      throw new Error("tool registration identity must be non-empty");
    }
    if (registration.tool.name !== registration.toolId) {
      throw new Error(`registered tool name must match tool ID: ${registration.toolId}`);
    }
    const key = toolIdentityKey(registration.toolId, registration.schemaVersion);
    if (tools.has(key)) {
      throw new Error(`duplicate tool registration: ${registration.toolId}@${registration.schemaVersion}`);
    }
    tools.set(key, registration.tool);
  }
  return tools;
}

function toolIdentityKey(toolId: string, schemaVersion: string): string {
  return JSON.stringify([toolId, schemaVersion]);
}

function toToolResultMessage(toolCall: ToolCall, record: ToolCallRecord): ToolResultMessage {
  const text = record.disposition.status === "denied"
    ? `tool call denied: ${record.disposition.reason}`
    : record.outcome === null
      ? "tool call recorded no outcome"
      : record.outcome.status === "succeeded"
        ? record.outcome.output
        : `${record.outcome.error.code}: ${record.outcome.error.message}`;
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    details: {},
    isError: record.disposition.status !== "accepted"
      || record.outcome === null
      || record.outcome.status !== "succeeded",
    timestamp: 0,
  };
}

function resolveControls(model: Model<Api>, requested: RequestedControls): ResolvedControls {
  const selectedModel = modelIdentity(model);
  if (!sameModel(requested.model, selectedModel)) {
    throw new Error(
      `requested model ${requested.model.providerId}/${requested.model.modelId} does not match adapter model ${selectedModel.providerId}/${selectedModel.modelId}`,
    );
  }

  const report: ControlReport = {
    model: { requested: structuredClone(requested.model), forwarded: selectedModel },
    thinkingLevel: resolveThinkingLevel(model, requested.thinkingLevel),
    ...(requested.temperature === undefined
      ? {}
      : { temperature: resolveTemperature(model, requested.temperature) }),
    ...(requested.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: resolveMaxTokens(model, requested.maxOutputTokens) }),
  };

  return {
    report,
    thinkingLevel: report.thinkingLevel.forwarded ?? "off",
    ...(report.temperature?.forwarded === undefined
      ? {}
      : { temperature: report.temperature.forwarded }),
    ...(report.maxOutputTokens?.forwarded === undefined
      ? {}
      : { maxTokens: report.maxOutputTokens.forwarded }),
  };
}

function resolveThinkingLevel(model: Model<Api>, requested: ThinkingLevel): ControlTrace<ThinkingLevel> {
  if (requested !== "off" && !model.reasoning) {
    return {
      requested,
      unsupported: { reason: "model does not support reasoning" },
    };
  }
  if (requested !== "off" && model.thinkingLevelMap?.[requested] === null) {
    return {
      requested,
      unsupported: { reason: `model metadata disables thinking level ${requested}` },
    };
  }
  return { requested, forwarded: requested };
}

function resolveTemperature(model: Model<Api>, requested: number): ControlTrace<number> {
  const unsupported = model.api === "anthropic-messages"
    && (model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature === false;
  return unsupported
    ? { requested, unsupported: { reason: "model metadata disables temperature" } }
    : { requested, forwarded: requested };
}

function resolveMaxTokens(model: Model<Api>, requested: number): ControlTrace<number> {
  if (model.api === "openai-codex-responses") {
    return {
      requested,
      unsupported: {
        reason: "Codex route does not support a provider-enforced output token cap",
      },
    };
  }
  if (requested <= model.maxTokens) return { requested, forwarded: requested };
  return {
    requested,
    adjusted: {
      value: model.maxTokens,
      reason: `clamped to model maximum ${String(model.maxTokens)}`,
    },
    forwarded: model.maxTokens,
  };
}

function withVerifiedModel(report: ControlReport, verified: ModelIdentity | undefined): ControlReport {
  if (!verified) return report;
  return {
    ...report,
    model: {
      ...report.model,
      providerVerified: verified,
    },
  };
}

function toUsageObservation(message: AssistantMessage, evidence: UsageEvidence): UsageObservation {
  return {
    values: {
      inputTokens: message.usage.input,
      outputTokens: message.usage.output,
      cacheReadTokens: message.usage.cacheRead,
      cacheWriteTokens: message.usage.cacheWrite,
      ...(message.usage.reasoning === undefined ? {} : { reasoningTokens: message.usage.reasoning }),
    },
    explicitlyReported: evidence.explicitlyReported,
  };
}

function buildSteppedTrace(
  steps: readonly ModelStep[],
  evidence: UsageEvidence,
  nextTurnSequence: () => number,
): AgentTrace {
  const attempts: AttemptTrace[] = [];
  for (const step of steps) {
    appendStepAttempts(attempts, step, evidence, nextTurnSequence);
  }
  return { attempts };
}

class PiProtocolError extends Error {
  readonly name = "PiProtocolError";
}

function buildFailureTrace(
  steps: readonly ModelStep[],
  pending: readonly ObservedResponse[],
  evidence: UsageEvidence,
  finalStatus: "failed" | "aborted",
  nextTurnSequence: () => number,
  appendSyntheticFailure = true,
): AgentTrace {
  const attempts: AttemptTrace[] = [];
  for (const step of steps) {
    appendStepAttempts(attempts, step, evidence, nextTurnSequence);
  }
  if (pending.length > 0) {
    pending.forEach(({ response, turnSequence }, index) => {
      attempts.push({
        attempt: attempts.length + 1,
        status: index === pending.length - 1 ? finalStatus : "failed",
        httpStatus: response.status,
        usage: {},
        usageEvidence: structuredClone(evidence),
        turnSequence,
      });
    });
  } else if (appendSyntheticFailure
    && (attempts.length === 0 || attempts.every((attempt) => attempt.status === "succeeded"))) {
    // The failing model step produced no observable response; record it explicitly.
    attempts.push({
      attempt: attempts.length + 1,
      status: finalStatus,
      usage: {},
      usageEvidence: structuredClone(evidence),
      turnSequence: nextTurnSequence(),
    });
  }
  return { attempts };
}

function appendStepAttempts(
  attempts: AttemptTrace[],
  step: ModelStep,
  evidence: UsageEvidence,
  nextTurnSequence: () => number,
): void {
  const stepUsage = normalizeUsage(toUsageObservation(step.message, evidence));
  const terminalStatus = step.message.stopReason === "aborted"
    ? "aborted" as const
    : step.message.stopReason === "error"
      ? "failed" as const
      : "succeeded" as const;
  if (step.responses.length === 0) {
    // The project invoked this model step even though no response hook fired.
    attempts.push({
      attempt: attempts.length + 1,
      status: terminalStatus,
      usage: stepUsage,
      usageEvidence: structuredClone(evidence),
      turnSequence: step.fallbackSequence ?? nextTurnSequence(),
    });
    return;
  }
  step.responses.forEach(({ response, turnSequence }, index) => {
    const isTerminal = index === step.responses.length - 1;
    const httpSucceeded = response.status >= 200 && response.status < 300;
    attempts.push({
      attempt: attempts.length + 1,
      status: isTerminal
        ? (terminalStatus === "succeeded" && !httpSucceeded ? "failed" : terminalStatus)
        : "failed",
      httpStatus: response.status,
      usage: isTerminal ? stepUsage : {},
      usageEvidence: structuredClone(evidence),
      turnSequence,
    });
  });
}

function sumNormalizedUsage(usages: readonly NormalizedUsage[]): NormalizedUsage {
  const sum: NormalizedUsage = {};
  for (const usage of usages) {
    for (const kind of Object.keys(usage) as (keyof NormalizedUsage)[]) {
      const value = usage[kind];
      if (value === undefined) continue;
      sum[kind] = (sum[kind] ?? 0) + value;
    }
  }
  return sum;
}


function responseModelIdentity(message: AssistantMessage): ModelIdentity {
  return {
    providerId: message.provider,
    modelId: message.responseModel ?? message.model,
  };
}

function providerVerifiedModelIdentity(message: AssistantMessage): ModelIdentity | undefined {
  return message.responseModel === undefined
    ? undefined
    : { providerId: message.provider, modelId: message.responseModel };
}

function toAgentMessage(message: ModelInputMessage, model: Model<Api>): Message {
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content,
      timestamp: 0,
    };
  }
  return {
    role: "assistant",
    content: [{ type: "text", text: message.content }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function modelIdentity(model: Model<Api>): ModelIdentity {
  return { providerId: model.provider, modelId: model.id };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function sameModel(left: ModelIdentity, right: ModelIdentity): boolean {
  return left.providerId === right.providerId && left.modelId === right.modelId;
}


