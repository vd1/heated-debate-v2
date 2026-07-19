import type { ContextDecision } from "./context";
import type { CreativitySelection } from "./dial";
import type { RoleDefinition } from "./roles";

export interface ModelIdentity {
  providerId: string;
  modelId: string;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RequestedControls {
  model: ModelIdentity;
  thinkingLevel: ThinkingLevel;
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ControlTrace<T> {
  requested: T;
  forwarded?: T;
  adjusted?: {
    value: T;
    reason: string;
  };
  unsupported?: {
    reason: string;
  };
  providerVerified?: T;
}

export interface ControlReport {
  model: ControlTrace<ModelIdentity>;
  thinkingLevel: ControlTrace<ThinkingLevel>;
  temperature?: ControlTrace<number>;
  maxOutputTokens?: ControlTrace<number>;
}

export interface CapabilityPolicy {
  toolNames: readonly string[];
}

export interface TurnRequest {
  turnId: string;
  role: RoleDefinition;
  creativity: CreativitySelection;
  context: ContextDecision;
  controls: RequestedControls;
  capabilities: CapabilityPolicy;
}

export interface NormalizedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export type UsageKind = keyof NormalizedUsage;

export interface UsageObservation {
  values: Partial<Record<UsageKind, number>>;
  explicitlyReported: readonly UsageKind[];
}

export interface UsageEvidence {
  explicitlyReported: readonly UsageKind[];
  source: string;
}

export interface AttemptTrace {
  attempt: number;
  status: "succeeded" | "failed" | "aborted";
  httpStatus?: number;
  usage: NormalizedUsage;
  usageEvidence: UsageEvidence;
}

export interface AgentTrace {
  attempts: readonly AttemptTrace[];
}

export interface AgentReply {
  text: string;
  durationMs: number;
  model: ModelIdentity;
  controls: ControlReport;
  usage: NormalizedUsage;
  trace: AgentTrace;
}

export interface AgentPort {
  reply(request: TurnRequest): Promise<AgentReply>;
  dispose(): Promise<void>;
}

export interface ScriptedReply {
  text: string;
  durationMs: number;
  model: ModelIdentity;
  controls: ControlReport;
  usage: UsageObservation;
  trace: AgentTrace;
}

const USAGE_KINDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly UsageKind[];

export function normalizeUsage(observation: UsageObservation): NormalizedUsage {
  const explicitlyReported = new Set(observation.explicitlyReported);
  const normalized: NormalizedUsage = {};

  for (const kind of USAGE_KINDS) {
    const value = observation.values[kind];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`invalid ${kind}: expected a finite non-negative number`);
    }
    if (value > 0 || explicitlyReported.has(kind)) {
      normalized[kind] = value;
    }
  }

  return normalized;
}

export class ScriptedAgent implements AgentPort {
  readonly requests: TurnRequest[] = [];

  private nextReplyIndex = 0;
  private isDisposed = false;

  constructor(private readonly script: readonly ScriptedReply[]) {}

  get disposed(): boolean {
    return this.isDisposed;
  }

  reply(request: TurnRequest): Promise<AgentReply> {
    if (this.isDisposed) return Promise.reject(new Error("scripted agent is disposed"));

    const scripted = this.script[this.nextReplyIndex];
    if (!scripted) return Promise.reject(new Error("scripted agent has no reply remaining"));

    this.nextReplyIndex += 1;
    this.requests.push(structuredClone(request));

    return Promise.resolve({
      text: scripted.text,
      durationMs: scripted.durationMs,
      model: scripted.model,
      controls: scripted.controls,
      usage: normalizeUsage(scripted.usage),
      trace: structuredClone(scripted.trace),
    });
  }

  dispose(): Promise<void> {
    this.isDisposed = true;
    return Promise.resolve();
  }
}
