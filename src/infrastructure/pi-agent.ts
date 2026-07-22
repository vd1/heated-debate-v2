import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  type AuthCheck,
  type Model,
  type ModelThinkingLevel,
  type ProviderResponse,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  AgentFailure,
  normalizeUsage,
  type AgentPort,
  type AgentReply,
  type AgentReplyOptions,
  type AgentTrace,
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
import type { ContextDecision, ModelInputMessage } from "../domain/context";
import { resolveToolPolicy } from "../domain/tool-policy";

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
  now?: () => number;
}

export interface CreatePiAgentFromRuntimeOptions {
  runtime: PiModelRuntime;
  model: ModelIdentity;
  usageEvidence?: UsageEvidence;
  tools?: readonly PiToolRegistration[];
  now?: () => number;
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
  private activeResponses: ProviderResponse[] | undefined;
  private activeReply: Promise<AgentReply> | undefined;
  private isDisposed = false;

  constructor(options: PiAgentOptions) {
    this.model = options.model;
    this.usageEvidence = structuredClone(options.usageEvidence);
    this.toolsByIdentity = toolRegistrationMap(options.tools ?? []);
    this.now = options.now ?? Date.now;
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
    const allowedTools = request.capabilities.evidence === "recorded"
      ? resolveToolPolicy(request.capabilities, {
          role: { id: request.role.id, version: request.role.version },
          phase: request.capabilities.phase,
        }).allowedTools
      : [];
    const tools = allowedTools.map(({ toolId, schemaVersion }) => {
      const tool = this.toolsByIdentity.get(toolIdentityKey(toolId, schemaVersion));
      if (!tool) {
        throw new Error(`tool is unavailable in environment: ${toolId}@${schemaVersion}`);
      }
      return tool;
    });
    if (tools.length > 0) {
      throw new Error("tool-enabled policies require the project dispatcher");
    }

    this.agent.state.systemPrompt = request.role.systemPrompt;
    this.agent.state.model = this.model;
    this.agent.state.thinkingLevel = controls.thinkingLevel;
    this.agent.state.tools = tools;
    const prompt = this.synchronizeContext(request.context);

    this.activeResponses = [];
    const startedAt = this.now();
    this.agent.streamFn = this.wrapControls(this.baseStream, controls);
    const onAbort = (): void => {
      this.agent.abort();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.agent.prompt(prompt);
    } catch (error) {
      const responses = this.activeResponses;
      this.activeResponses = undefined;
      throw new AgentFailure({
        code: options.signal?.aborted ? "cancelled" : "provider_failure",
        message: toError(error).message,
        trace: buildFailureTrace(
          responses,
          this.usageEvidence,
          options.signal?.aborted ? "aborted" : "failed",
        ),
      });
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    const durationMs = Math.max(0, this.now() - startedAt);
    const responses = this.activeResponses;
    this.activeResponses = undefined;

    const message = findLastAssistantMessage(this.agent.state.messages);
    if (!message) throw new Error("Pi Agent completed without an assistant message");

    const usage = normalizeUsage(toUsageObservation(message, this.usageEvidence));
    const trace = buildTrace(responses, message, usage, this.usageEvidence);
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      throw new AgentFailure({
        code: message.stopReason === "aborted" ? "cancelled" : "provider_failure",
        message: message.errorMessage ?? `provider stopped with ${message.stopReason}`,
        trace,
      });
    }
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
      toolCalls: [],
    };
  }

  private synchronizeContext(context: ContextDecision): string {
    const messages = context.messages;
    const finalMessage = messages[messages.length - 1];
    if (!finalMessage) throw new Error("selected model input must contain at least one message");
    if (finalMessage.role !== "user") {
      throw new Error("selected model input must end with a user message");
    }

    this.agent.state.messages = messages
      .slice(0, -1)
      .map((message) => toAgentMessage(message, this.model));
    return finalMessage.content;
  }

  private withAttemptObservation(options: SimpleStreamOptions | undefined): SimpleStreamOptions {
    const existingOnResponse = options?.onResponse;
    return {
      ...options,
      onResponse: async (response, model) => {
        this.activeResponses?.push(response);
        await existingOnResponse?.(response, model);
      },
    };
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

function buildFailureTrace(
  responses: readonly ProviderResponse[],
  evidence: UsageEvidence,
  finalStatus: "failed" | "aborted",
): AgentTrace {
  const observations = responses.length > 0
    ? responses.map((response) => ({ response, observed: true }))
    : [{ response: { status: 0, headers: {} }, observed: false }];
  return {
    attempts: observations.map(({ response, observed }, index) => ({
      attempt: index + 1,
      status: index === observations.length - 1 ? finalStatus : "failed",
      ...(observed ? { httpStatus: response.status } : {}),
      usage: {},
      usageEvidence: structuredClone(evidence),
    })),
  };
}

function buildTrace(
  responses: readonly ProviderResponse[],
  message: AssistantMessage,
  usage: NormalizedUsage,
  evidence: UsageEvidence,
): AgentTrace {
  const messageSucceeded = message.stopReason !== "error" && message.stopReason !== "aborted";
  const responseObservations = responses.length > 0
    ? responses.map((response) => ({ response, observed: true }))
    : [{ response: { status: 0, headers: {} }, observed: false }];
  const finalIndex = responseObservations.length - 1;

  return {
    attempts: responseObservations.map(({ response, observed }, index) => {
      const isFinal = index === finalIndex;
      const httpSucceeded = !observed || (response.status >= 200 && response.status < 300);
      const status = isFinal && message.stopReason === "aborted"
        ? "aborted" as const
        : isFinal && messageSucceeded && httpSucceeded
          ? "succeeded" as const
          : "failed" as const;
      return {
        attempt: index + 1,
        status,
        ...(observed ? { httpStatus: response.status } : {}),
        usage: isFinal ? usage : {},
        usageEvidence: structuredClone(evidence),
      };
    }),
  };
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

function toAgentMessage(message: ModelInputMessage, model: Model<Api>): AgentMessage {
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

function findLastAssistantMessage(messages: readonly unknown[]): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) return message;
  }
  return undefined;
}

function isAssistantMessage(value: unknown): value is AssistantMessage {
  return typeof value === "object" && value !== null && "role" in value && value.role === "assistant";
}
