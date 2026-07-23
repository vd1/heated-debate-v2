import { createHash } from "node:crypto";

import type { AgentPort, ModelIdentity, RequestedControls, ThinkingLevel } from "./agent";
import type { DebateBudget, RunDebateInput } from "./debate";
import {
  definePricingSnapshot,
  findPricingEntry,
  scaledCurrencyAmount,
  type PricingSnapshot,
} from "./pricing";
import { defineRole, PROPOSER_ROLE, REVIEWER_ROLE, type RoleDefinition } from "./roles";
import { resolveToolPolicy, type ToolCapabilityPolicy, type ToolProtocolPhase } from "./tool-policy";

export const DEFAULT_MODEL: ModelIdentity = Object.freeze({
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
});
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "high";

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh", "max",
]);

export interface RoleAssignment {
  role: RoleDefinition;
  controls: RequestedControls;
  capabilities?: ToolCapabilityPolicy;
}

export interface ExperimentMonetaryBudget {
  maxAmount: number;
  snapshot: PricingSnapshot;
  permitTokenOnlyAccounting?: boolean;
}

export interface ExperimentConfig {
  configVersion: "1";
  /** The validated untrusted input verbatim; canonical identity derives from it,
   * so omitted optional controls stay distinct from explicit defaults. */
  source: Readonly<Record<string, unknown>>;
  runId: string;
  topic: string;
  caseId?: string;
  roundCount: number;
  contextPolicy: { policyId: "last-exchange"; policyVersion: "1" };
  protocol: { protocolId: "proposer-reviewer"; protocolVersion: "1" };
  creativitySchedule: { scheduleId: "linear-cooling"; scheduleVersion: "1" };
  proposer: RoleAssignment;
  reviewer: RoleAssignment;
  turnTimeoutMs?: number;
  wholeRunTimeoutMs?: number;
  budget?: DebateBudget & { monetary?: ExperimentMonetaryBudget };
}

/** Parses untrusted JSON into a validated, frozen experiment configuration. */
export function parseExperimentConfig(value: unknown): ExperimentConfig {
  const raw = asRecord(value, "config", "config must be a JSON object");
  assertKnownFields(raw, [
    "configVersion", "runId", "topic", "caseId", "roundCount", "contextPolicy",
    "protocol", "creativitySchedule",
    "controls", "proposer", "reviewer", "turnTimeoutMs", "wholeRunTimeoutMs", "budget",
  ], "config");
  if (raw.configVersion !== "1") {
    throw new Error(`unsupported configVersion: ${String(raw.configVersion)}`);
  }
  const runId = requireString(raw.runId, "runId");
  const topic = requireString(raw.topic, "topic");
  const caseId = raw.caseId === undefined ? undefined : requireString(raw.caseId, "caseId");
  if (!Number.isSafeInteger(raw.roundCount) || (raw.roundCount as number) <= 0) {
    throw new Error("roundCount must be a positive integer");
  }
  const roundCount = raw.roundCount as number;

  if (raw.contextPolicy !== undefined) {
    const policy = asRecord(raw.contextPolicy, "config.contextPolicy");
    assertKnownFields(policy, ["policyId", "policyVersion"], "config.contextPolicy");
    if (policy.policyId !== "last-exchange" || policy.policyVersion !== "1") {
      throw new Error("contextPolicy must be last-exchange@1");
    }
  }

  if (raw.protocol !== undefined) {
    const protocol = asRecord(raw.protocol, "config.protocol");
    assertKnownFields(protocol, ["protocolId", "protocolVersion"], "config.protocol");
    if (protocol.protocolId !== "proposer-reviewer" || protocol.protocolVersion !== "1") {
      throw new Error("protocol must be proposer-reviewer@1");
    }
  }
  if (raw.creativitySchedule !== undefined) {
    const schedule = asRecord(raw.creativitySchedule, "config.creativitySchedule");
    assertKnownFields(schedule, ["scheduleId", "scheduleVersion"], "config.creativitySchedule");
    if (schedule.scheduleId !== "linear-cooling" || schedule.scheduleVersion !== "1") {
      throw new Error("creativitySchedule must be linear-cooling@1");
    }
  }

  const sharedControls = raw.controls === undefined
    ? {}
    : parseControls(raw.controls, "config.controls");
  const proposer = parseAssignment(raw.proposer, "config.proposer", PROPOSER_ROLE, "proposal", sharedControls);
  const reviewer = parseAssignment(raw.reviewer, "config.reviewer", REVIEWER_ROLE, "review", sharedControls);

  const turnTimeoutMs = raw.turnTimeoutMs === undefined
    ? undefined
    : requirePositiveNumber(raw.turnTimeoutMs, "turnTimeoutMs");
  const wholeRunTimeoutMs = raw.wholeRunTimeoutMs === undefined
    ? undefined
    : requirePositiveNumber(raw.wholeRunTimeoutMs, "wholeRunTimeoutMs");
  if (turnTimeoutMs !== undefined && wholeRunTimeoutMs !== undefined
    && wholeRunTimeoutMs < turnTimeoutMs) {
    throw new Error("wholeRunTimeoutMs must not be smaller than turnTimeoutMs");
  }

  const budget = raw.budget === undefined
    ? undefined
    : parseBudget(raw.budget, [proposer.controls.model, reviewer.controls.model]);

  return deepFreeze({
    configVersion: "1",
    source: structuredClone(raw),
    runId,
    topic,
    ...(caseId === undefined ? {} : { caseId }),
    roundCount,
    contextPolicy: { policyId: "last-exchange", policyVersion: "1" },
    protocol: { protocolId: "proposer-reviewer", protocolVersion: "1" },
    creativitySchedule: { scheduleId: "linear-cooling", scheduleVersion: "1" },
    proposer,
    reviewer,
    ...(turnTimeoutMs === undefined ? {} : { turnTimeoutMs }),
    ...(wholeRunTimeoutMs === undefined ? {} : { wholeRunTimeoutMs }),
    ...(budget === undefined ? {} : { budget }),
  });
}

export function canonicalExperimentConfigJson(config: ExperimentConfig): string {
  return canonicalJson(config.source);
}

export function experimentConfigHash(config: ExperimentConfig): string {
  return createHash("sha256").update(canonicalExperimentConfigJson(config)).digest("hex");
}

export interface ExperimentAgents {
  proposer: AgentPort;
  reviewer: AgentPort;
}

/**
 * Maps a validated configuration onto a runnable debate input. Budget token
 * limits are retry-inclusive: enforcement sums every observed attempt.
 */
export function experimentDebateInput(
  config: ExperimentConfig,
  agents: ExperimentAgents,
): RunDebateInput {
  return {
    debateId: config.runId,
    topic: config.topic,
    roundCount: config.roundCount,
    creativitySchedule: structuredClone(config.creativitySchedule),
    experiment: {
      configHash: experimentConfigHash(config),
      ...(config.caseId === undefined ? {} : { caseId: config.caseId }),
    },
    proposer: {
      agent: agents.proposer,
      role: config.proposer.role,
      controls: structuredClone(config.proposer.controls),
      ...(config.proposer.capabilities === undefined
        ? {}
        : { capabilities: config.proposer.capabilities }),
    },
    reviewer: {
      agent: agents.reviewer,
      role: config.reviewer.role,
      controls: structuredClone(config.reviewer.controls),
      ...(config.reviewer.capabilities === undefined
        ? {}
        : { capabilities: config.reviewer.capabilities }),
    },
    ...(config.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: config.turnTimeoutMs }),
    ...(config.wholeRunTimeoutMs === undefined
      ? {}
      : { wholeRunTimeoutMs: config.wholeRunTimeoutMs }),
    ...(config.budget === undefined ? {} : { budget: structuredClone(config.budget) }),
  };
}

interface ParsedControls {
  model?: ModelIdentity;
  thinkingLevel?: ThinkingLevel;
  temperature?: number;
  maxOutputTokens?: number;
}

function parseAssignment(
  value: unknown,
  path: string,
  defaultRole: RoleDefinition,
  phase: ToolProtocolPhase,
  shared: ParsedControls,
): RoleAssignment {
  const raw = value === undefined ? {} : asRecord(value, path);
  assertKnownFields(raw, ["role", "controls", "capabilities"], path);

  const role = raw.role === undefined ? defaultRole : parseRole(raw.role, `${path}.role`);
  const overrides = raw.controls === undefined
    ? {}
    : parseControls(raw.controls, `${path}.controls`);
  const merged: ParsedControls = { ...shared, ...overrides };
  const controls: RequestedControls = {
    model: merged.model ?? structuredClone(DEFAULT_MODEL),
    thinkingLevel: merged.thinkingLevel ?? DEFAULT_THINKING_LEVEL,
    ...(merged.temperature === undefined ? {} : { temperature: merged.temperature }),
    ...(merged.maxOutputTokens === undefined ? {} : { maxOutputTokens: merged.maxOutputTokens }),
  };
  const capabilities = raw.capabilities === undefined
    ? undefined
    : resolveToolPolicy(raw.capabilities as ToolCapabilityPolicy, {
        role: { id: role.id, version: role.version },
        phase,
      });
  return {
    role,
    controls,
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

function parseRole(value: unknown, path: string): RoleDefinition {
  const raw = asRecord(value, path);
  assertKnownFields(raw, ["id", "version", "systemPrompt"], path);
  return defineRole({
    id: requireString(raw.id, `${path}.id`),
    version: requireString(raw.version, `${path}.version`),
    systemPrompt: requireString(raw.systemPrompt, `${path}.systemPrompt`),
  });
}

function parseControls(value: unknown, path: string): ParsedControls {
  const raw = asRecord(value, path);
  assertKnownFields(raw, ["model", "thinkingLevel", "temperature", "maxOutputTokens"], path);
  const parsed: ParsedControls = {};
  if (raw.model !== undefined) {
    const model = asRecord(raw.model, `${path}.model`);
    assertKnownFields(model, ["providerId", "modelId"], `${path}.model`);
    parsed.model = {
      providerId: requireString(model.providerId, `${path}.model.providerId`),
      modelId: requireString(model.modelId, `${path}.model.modelId`),
    };
  }
  if (raw.thinkingLevel !== undefined) {
    if (typeof raw.thinkingLevel !== "string"
      || !THINKING_LEVELS.has(raw.thinkingLevel as ThinkingLevel)) {
      throw new Error(`${path}.thinkingLevel is invalid`);
    }
    parsed.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
  }
  if (raw.temperature !== undefined) {
    if (typeof raw.temperature !== "number" || !Number.isFinite(raw.temperature)
      || raw.temperature < 0 || raw.temperature > 2) {
      throw new Error("temperature must be between 0 and 2");
    }
    parsed.temperature = raw.temperature;
  }
  if (raw.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(raw.maxOutputTokens) || (raw.maxOutputTokens as number) <= 0) {
      throw new Error(`${path}.maxOutputTokens must be a positive integer`);
    }
    parsed.maxOutputTokens = raw.maxOutputTokens as number;
  }
  return parsed;
}

function parseBudget(
  value: unknown,
  models: readonly ModelIdentity[],
): DebateBudget & { monetary?: ExperimentMonetaryBudget } {
  const raw = asRecord(value, "config.budget");
  assertKnownFields(raw, ["maxTurns", "maxTokens", "monetary"], "config.budget");
  if (!Number.isSafeInteger(raw.maxTurns) || (raw.maxTurns as number) < 0) {
    throw new Error("budget.maxTurns must be a non-negative integer");
  }
  if (!Number.isSafeInteger(raw.maxTokens) || (raw.maxTokens as number) < 0) {
    throw new Error("budget.maxTokens must be a non-negative safe integer");
  }
  if (raw.monetary === undefined) {
    return { maxTurns: raw.maxTurns as number, maxTokens: raw.maxTokens as number };
  }
  const monetary = asRecord(raw.monetary, "config.budget.monetary");
  assertKnownFields(
    monetary,
    ["maxAmount", "snapshot", "permitTokenOnlyAccounting"],
    "config.budget.monetary",
  );
  if (typeof monetary.maxAmount !== "number") {
    throw new Error("budget.monetary.maxAmount must be a finite non-negative number");
  }
  scaledCurrencyAmount(monetary.maxAmount, "budget.monetary.maxAmount");
  if (monetary.permitTokenOnlyAccounting !== undefined
    && typeof monetary.permitTokenOnlyAccounting !== "boolean") {
    throw new Error("budget.monetary.permitTokenOnlyAccounting must be a boolean");
  }
  const snapshot = definePricingSnapshot(monetary.snapshot as PricingSnapshot);
  for (const model of models) {
    if (!findPricingEntry(snapshot, model)) {
      throw new Error(`no pricing entry for ${model.providerId}/${model.modelId}`);
    }
  }
  return {
    maxTurns: raw.maxTurns as number,
    maxTokens: raw.maxTokens as number,
    monetary: {
      maxAmount: monetary.maxAmount,
      snapshot,
      ...(monetary.permitTokenOnlyAccounting === undefined
        ? {}
        : { permitTokenOnlyAccounting: monetary.permitTokenOnlyAccounting }),
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
  ).join(",")}}`;
}

function asRecord(value: unknown, path: string, message?: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(message ?? `${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownFields(
  value: Record<string, unknown>,
  known: readonly string[],
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new Error(`unknown field at ${path}: ${key}`);
  }
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requirePositiveNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a finite positive number`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
