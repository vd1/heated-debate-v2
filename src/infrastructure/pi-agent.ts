import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  AuthCheck,
  Model,
  ModelThinkingLevel,
  ProviderResponse,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  normalizeUsage,
  type AgentPort,
  type AgentReply,
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

export type ModelStream = StreamFn;

export interface PiModelRuntime {
  getModel(providerId: string, modelId: string): Model<Api> | undefined;
  checkAuth(providerId: string): Promise<AuthCheck | undefined>;
  streamSimple: ModelStream;
}

export interface PiAgentOptions {
  model: Model<Api>;
  modelStream: ModelStream;
  usageEvidence: UsageEvidence;
  tools?: readonly AgentTool[];
  now?: () => number;
}

export interface CreatePiAgentFromRuntimeOptions {
  runtime: PiModelRuntime;
  model: ModelIdentity;
  usageEvidence?: UsageEvidence;
  tools?: readonly AgentTool[];
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
  private readonly toolsByName: ReadonlyMap<string, AgentTool>;
  private readonly now: () => number;
  private activeResponses: ProviderResponse[] | undefined;
  private activeReply: Promise<AgentReply> | undefined;
  private isDisposed = false;

  constructor(options: PiAgentOptions) {
    this.model = options.model;
    this.usageEvidence = structuredClone(options.usageEvidence);
    this.toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));
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

  reply(request: TurnRequest): Promise<AgentReply> {
    if (this.isDisposed) return Promise.reject(new Error("Pi agent is disposed"));
    if (this.activeReply) return Promise.reject(new Error("Pi agent is already processing a turn"));

    const operation = this.runReply(request);
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

  private async runReply(request: TurnRequest): Promise<AgentReply> {
    const controls = resolveControls(this.model, request.controls);
    const tools = request.capabilities.toolNames.map((name) => {
      const tool = this.toolsByName.get(name);
      if (!tool) throw new Error(`unknown or unavailable tool: ${name}`);
      return tool;
    });

    this.agent.state.systemPrompt = request.role.systemPrompt;
    this.agent.state.model = this.model;
    this.agent.state.thinkingLevel = controls.thinkingLevel;
    this.agent.state.tools = tools;
    const prompt = this.synchronizeContext(request.context);

    this.activeResponses = [];
    const startedAt = this.now();
    this.agent.streamFn = this.wrapControls(this.baseStream, controls);
    try {
      await this.agent.prompt(prompt);
    } catch (error) {
      this.activeResponses = undefined;
      throw error;
    }
    const durationMs = Math.max(0, this.now() - startedAt);
    const responses = this.activeResponses;
    this.activeResponses = undefined;

    const message = findLastAssistantMessage(this.agent.state.messages);
    if (!message) throw new Error("Pi Agent completed without an assistant message");

    const usage = normalizeUsage(toUsageObservation(message, this.usageEvidence));
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
      trace: buildTrace(responses, message, usage, this.usageEvidence),
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

function buildTrace(
  responses: readonly ProviderResponse[],
  message: AssistantMessage,
  usage: NormalizedUsage,
  evidence: UsageEvidence,
): AgentTrace {
  const messageSucceeded = message.stopReason !== "error" && message.stopReason !== "aborted";
  const observedResponses = responses.length > 0
    ? responses
    : [{ status: messageSucceeded ? 200 : 0, headers: {} }];
  const finalIndex = observedResponses.length - 1;

  return {
    attempts: observedResponses.map((response, index) => {
      const isFinal = index === finalIndex;
      const httpSucceeded = response.status >= 200 && response.status < 300;
      const status = isFinal && message.stopReason === "aborted"
        ? "aborted" as const
        : isFinal && messageSucceeded && httpSucceeded
          ? "succeeded" as const
          : "failed" as const;
      return {
        attempt: index + 1,
        status,
        ...(response.status === 0 ? {} : { httpStatus: response.status }),
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
