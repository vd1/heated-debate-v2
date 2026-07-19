import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Model,
  ModelThinkingLevel,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

export type ModelStream = StreamFn;

export interface ProbeControls {
  thinkingLevel: ModelThinkingLevel;
  temperature?: number;
  maxTokens?: number;
}

export interface ControlIssue {
  control: keyof ProbeControls;
  kind: "unsupported" | "adjusted";
  reason: string;
}

export interface ControlReport {
  requested: ProbeControls;
  forwarded: ProbeControls;
  issues: ControlIssue[];
  verification: "request-only";
}

export interface ProbeTurn {
  text: string;
  stopReason: AssistantMessage["stopReason"];
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning?: number;
  };
  controls: ControlReport;
}

interface PiAgentProbeOptions {
  model: Model<Api>;
  modelStream: ModelStream;
  systemPrompt: string;
  tools: AgentTool[];
  controls: ProbeControls;
}

export function streamFromModelRuntime(runtime: ModelRuntime): ModelStream {
  return (model, context, options) => runtime.streamSimple(model, context, options);
}

export class PiAgentProbe {
  readonly textDeltas: string[] = [];

  private readonly agent: Agent;
  private readonly unsubscribe: () => void;
  private readonly controlReport: ControlReport;
  private isDisposed = false;

  constructor(options: PiAgentProbeOptions) {
    this.controlReport = resolveControls(options.model, options.controls);
    this.agent = new Agent({
      initialState: {
        systemPrompt: options.systemPrompt,
        model: options.model,
        thinkingLevel: this.controlReport.forwarded.thinkingLevel,
        tools: options.tools,
      },
      streamFn: (model, context, streamOptions) => options.modelStream(
        model,
        context,
        mergeControls(streamOptions, this.controlReport.forwarded),
      ),
    });
    this.unsubscribe = this.agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.textDeltas.push(event.assistantMessageEvent.delta);
      }
    });
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  get messageCount(): number {
    return this.agent.state.messages.length;
  }

  async prompt(text: string): Promise<ProbeTurn> {
    if (this.isDisposed) throw new Error("probe is disposed");

    await this.agent.prompt(text);
    const message = findLastAssistantMessage(this.agent.state.messages);
    if (!message) throw new Error("Pi Agent completed without an assistant message");

    const reasoning = message.usage.reasoning;
    return {
      text: message.content
        .filter((content) => content.type === "text")
        .map((content) => content.text)
        .join(""),
      stopReason: message.stopReason,
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        ...(reasoning === undefined ? {} : { reasoning }),
      },
      controls: this.controlReport,
    };
  }

  abort(): void {
    this.agent.abort();
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) return;
    this.agent.abort();
    await this.agent.waitForIdle();
    this.unsubscribe();
    this.agent.reset();
    this.isDisposed = true;
  }
}

function mergeControls(options: SimpleStreamOptions | undefined, controls: ProbeControls): SimpleStreamOptions {
  return {
    ...options,
    ...(controls.temperature === undefined ? {} : { temperature: controls.temperature }),
    ...(controls.maxTokens === undefined ? {} : { maxTokens: controls.maxTokens }),
  };
}

function resolveControls(model: Model<Api>, requested: ProbeControls): ControlReport {
  const issues: ControlIssue[] = [];
  let thinkingLevel = requested.thinkingLevel;

  if (thinkingLevel !== "off" && !model.reasoning) {
    thinkingLevel = "off";
    issues.push({
      control: "thinkingLevel",
      kind: "unsupported",
      reason: "model does not support reasoning",
    });
  } else if (thinkingLevel !== "off" && model.thinkingLevelMap?.[thinkingLevel] === null) {
    thinkingLevel = "off";
    issues.push({
      control: "thinkingLevel",
      kind: "unsupported",
      reason: `model metadata disables thinking level ${requested.thinkingLevel}`,
    });
  }

  const temperatureSupported = !(
    model.api === "anthropic-messages"
    && (model.compat as { supportsTemperature?: boolean } | undefined)?.supportsTemperature === false
  );
  if (requested.temperature !== undefined && !temperatureSupported) {
    issues.push({
      control: "temperature",
      kind: "unsupported",
      reason: "model metadata disables temperature",
    });
  }

  const maxTokens = requested.maxTokens === undefined
    ? undefined
    : Math.min(requested.maxTokens, model.maxTokens);
  if (requested.maxTokens !== undefined && maxTokens !== requested.maxTokens) {
    issues.push({
      control: "maxTokens",
      kind: "adjusted",
      reason: `clamped to model maximum ${String(model.maxTokens)}`,
    });
  }

  return {
    requested: { ...requested },
    forwarded: {
      thinkingLevel,
      ...(requested.temperature === undefined || !temperatureSupported
        ? {}
        : { temperature: requested.temperature }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    },
    issues,
    verification: "request-only",
  };
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
