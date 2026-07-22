import type { RoleDefinition } from "./roles";

export type ToolProtocolPhase = "proposal" | "review";
export type DeniedCallCharge = "none" | "aggregate";

export interface ToolPolicyBinding {
  role: Pick<RoleDefinition, "id" | "version">;
  phase: ToolProtocolPhase;
}

export interface AllowedToolPolicy {
  toolId: string;
  schemaVersion: string;
  maxCalls: number;
}

export interface ToolCapabilityPolicy {
  policyId: string;
  policyVersion: string;
  evidence: "recorded";
  role: Pick<RoleDefinition, "id" | "version">;
  phase: ToolProtocolPhase;
  allowedTools: readonly AllowedToolPolicy[];
  aggregateCallLimit: number;
  callTimeoutMs: number;
  maxResultBytes: number;
  deniedCallCharge: DeniedCallCharge;
}

export interface UnrecordedToolCapabilityPolicy {
  policyId: "legacy-tool-names";
  policyVersion: "1";
  evidence: "unrecorded";
  toolNames: readonly string[];
}

export type TurnCapabilityPolicy = ToolCapabilityPolicy | UnrecordedToolCapabilityPolicy;

export interface ToolCallIdentity {
  toolId: string;
  schemaVersion: string;
}

export interface AggregateToolCallAccounting {
  acceptedCalls: number;
  deniedCalls: number;
  consumedCalls: number;
}

export interface PerToolCallAccounting extends ToolCallIdentity {
  acceptedCalls: number;
  deniedCalls: number;
}

export interface ToolCallAccounting {
  policyId: string;
  policyVersion: string;
  role: Pick<RoleDefinition, "id" | "version">;
  phase: ToolProtocolPhase;
  aggregate: AggregateToolCallAccounting;
  tools: readonly PerToolCallAccounting[];
}

export type ToolAuthorizationDecision =
  | {
      status: "accepted";
      tool: ToolCallIdentity;
    }
  | {
      status: "denied";
      reason:
        | "tool_not_allowed"
        | "schema_version_not_allowed"
        | "aggregate_call_limit_exhausted"
        | "tool_call_limit_exhausted";
    };

export interface ToolAuthorizationResult {
  decision: ToolAuthorizationDecision;
  accounting: ToolCallAccounting;
}

export function resolveToolPolicy(
  input: ToolCapabilityPolicy,
  binding: ToolPolicyBinding,
): ToolCapabilityPolicy {
  validateBinding(binding);
  validatePolicy(input);
  if (input.role.id !== binding.role.id || input.role.version !== binding.role.version) {
    throw new Error(`tool policy role must match ${binding.role.id}@${binding.role.version}`);
  }
  if (input.phase !== binding.phase) {
    throw new Error(`tool policy phase must match ${binding.phase}`);
  }
  return deepFreeze(structuredClone(input));
}

export function createDenyAllToolPolicy(
  binding: ToolPolicyBinding,
): ToolCapabilityPolicy {
  return resolveToolPolicy({
    policyId: "deny-all-tools",
    policyVersion: "1",
    evidence: "recorded",
    role: structuredClone(binding.role),
    phase: binding.phase,
    allowedTools: [],
    aggregateCallLimit: 0,
    callTimeoutMs: 30_000,
    maxResultBytes: 65_536,
    deniedCallCharge: "none",
  }, binding);
}

export function createToolCallAccounting(
  policy: ToolCapabilityPolicy,
): ToolCallAccounting {
  validatePolicy(policy);
  return deepFreeze({
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
    role: structuredClone(policy.role),
    phase: policy.phase,
    aggregate: {
      acceptedCalls: 0,
      deniedCalls: 0,
      consumedCalls: 0,
    },
    tools: policy.allowedTools.map((tool) => ({
      toolId: tool.toolId,
      schemaVersion: tool.schemaVersion,
      acceptedCalls: 0,
      deniedCalls: 0,
    })),
  });
}

export function authorizeToolCall(
  policy: ToolCapabilityPolicy,
  accounting: ToolCallAccounting,
  request: ToolCallIdentity,
): ToolAuthorizationResult {
  validatePolicy(policy);
  validateAccounting(policy, accounting);
  assertNonEmpty(request.toolId, "toolId");
  assertNonEmpty(request.schemaVersion, "schemaVersion");

  const allowedIdentity = policy.allowedTools.find((tool) => tool.toolId === request.toolId);
  if (!allowedIdentity) {
    return denied(policy, accounting, request, "tool_not_allowed");
  }
  if (allowedIdentity.schemaVersion !== request.schemaVersion) {
    return denied(policy, accounting, request, "schema_version_not_allowed");
  }
  if (accounting.aggregate.consumedCalls >= policy.aggregateCallLimit) {
    return denied(policy, accounting, request, "aggregate_call_limit_exhausted");
  }
  const toolAccounting = findToolAccounting(accounting, request);
  if (toolAccounting.acceptedCalls >= allowedIdentity.maxCalls) {
    return denied(policy, accounting, request, "tool_call_limit_exhausted");
  }

  return deepFreeze({
    decision: {
      status: "accepted",
      tool: structuredClone(request),
    },
    accounting: updateAccounting(accounting, request, {
      acceptedDelta: 1,
      deniedDelta: 0,
      consumedDelta: 1,
    }),
  });
}

function denied(
  policy: ToolCapabilityPolicy,
  accounting: ToolCallAccounting,
  request: ToolCallIdentity,
  reason: Extract<ToolAuthorizationDecision, { status: "denied" }>["reason"],
): ToolAuthorizationResult {
  const canCharge = policy.deniedCallCharge === "aggregate"
    && accounting.aggregate.consumedCalls < policy.aggregateCallLimit;
  return deepFreeze({
    decision: { status: "denied", reason },
    accounting: updateAccounting(accounting, request, {
      acceptedDelta: 0,
      deniedDelta: 1,
      consumedDelta: canCharge ? 1 : 0,
    }),
  });
}

function updateAccounting(
  accounting: ToolCallAccounting,
  request: ToolCallIdentity,
  deltas: { acceptedDelta: number; deniedDelta: number; consumedDelta: number },
): ToolCallAccounting {
  const tools = accounting.tools.map((tool) => structuredClone(tool));
  let entry = tools.find(
    (tool) => tool.toolId === request.toolId && tool.schemaVersion === request.schemaVersion,
  );
  if (!entry) {
    entry = {
      toolId: request.toolId,
      schemaVersion: request.schemaVersion,
      acceptedCalls: 0,
      deniedCalls: 0,
    };
    tools.push(entry);
  }
  entry.acceptedCalls += deltas.acceptedDelta;
  entry.deniedCalls += deltas.deniedDelta;

  return deepFreeze({
    policyId: accounting.policyId,
    policyVersion: accounting.policyVersion,
    role: structuredClone(accounting.role),
    phase: accounting.phase,
    aggregate: {
      acceptedCalls: accounting.aggregate.acceptedCalls + deltas.acceptedDelta,
      deniedCalls: accounting.aggregate.deniedCalls + deltas.deniedDelta,
      consumedCalls: accounting.aggregate.consumedCalls + deltas.consumedDelta,
    },
    tools,
  });
}

export function assertToolCapabilityPolicy(
  value: unknown,
): asserts value is ToolCapabilityPolicy {
  validatePolicy(value);
}

function validatePolicy(value: unknown): asserts value is ToolCapabilityPolicy {
  assertPlainRecord(value, "tool policy");
  assertExactKeys(value, [
    "policyId",
    "policyVersion",
    "evidence",
    "role",
    "phase",
    "allowedTools",
    "aggregateCallLimit",
    "callTimeoutMs",
    "maxResultBytes",
    "deniedCallCharge",
  ], "tool policy");
  assertNonEmpty(value.policyId, "policyId");
  assertNonEmpty(value.policyVersion, "policyVersion");
  if (value.evidence !== "recorded") throw new Error("evidence must be recorded");
  validateRoleReference(value.role, "role");
  if (value.phase !== "proposal" && value.phase !== "review") {
    throw new Error("phase must be proposal or review");
  }
  if (!Array.isArray(value.allowedTools)) throw new Error("allowedTools must be an array");
  const toolIds = new Set<string>();
  for (const [index, tool] of (value.allowedTools as unknown[]).entries()) {
    assertPlainRecord(tool, `allowedTools[${String(index)}]`);
    assertExactKeys(
      tool,
      ["toolId", "schemaVersion", "maxCalls"],
      `allowedTools[${String(index)}]`,
    );
    assertNonEmpty(tool.toolId, "toolId");
    assertNonEmpty(tool.schemaVersion, "schemaVersion");
    assertNonNegativeInteger(tool.maxCalls, `allowedTools[${String(index)}].maxCalls`);
    if (toolIds.has(tool.toolId)) throw new Error(`duplicate allowed tool ID: ${tool.toolId}`);
    toolIds.add(tool.toolId);
  }
  assertNonNegativeInteger(value.aggregateCallLimit, "aggregateCallLimit");
  assertPositiveInteger(value.callTimeoutMs, "callTimeoutMs");
  assertPositiveInteger(value.maxResultBytes, "maxResultBytes");
  if (value.deniedCallCharge !== "none" && value.deniedCallCharge !== "aggregate") {
    throw new Error("deniedCallCharge must be none or aggregate");
  }
}

function validateBinding(binding: unknown): asserts binding is ToolPolicyBinding {
  assertPlainRecord(binding, "tool policy binding");
  assertExactKeys(binding, ["role", "phase"], "tool policy binding");
  validateRoleReference(binding.role, "binding.role");
  if (binding.phase !== "proposal" && binding.phase !== "review") {
    throw new Error("binding.phase must be proposal or review");
  }
}

function validateRoleReference(
  role: unknown,
  path: string,
): asserts role is Pick<RoleDefinition, "id" | "version"> {
  assertPlainRecord(role, path);
  assertExactKeys(role, ["id", "version"], path);
  assertNonEmpty(role.id, `${path}.id`);
  assertNonEmpty(role.version, `${path}.version`);
}

function validateAccounting(
  policy: ToolCapabilityPolicy,
  accounting: ToolCallAccounting,
): void {
  assertPlainRecord(accounting, "tool call accounting");
  if (accounting.policyId !== policy.policyId || accounting.policyVersion !== policy.policyVersion) {
    throw new Error("tool call accounting policy identity does not match");
  }
  if (accounting.role.id !== policy.role.id
    || accounting.role.version !== policy.role.version
    || accounting.phase !== policy.phase) {
    throw new Error("tool call accounting binding does not match");
  }
  assertNonNegativeInteger(accounting.aggregate.acceptedCalls, "aggregate.acceptedCalls");
  assertNonNegativeInteger(accounting.aggregate.deniedCalls, "aggregate.deniedCalls");
  assertNonNegativeInteger(accounting.aggregate.consumedCalls, "aggregate.consumedCalls");
  for (const [index, tool] of accounting.tools.entries()) {
    assertNonEmpty(tool.toolId, `tools[${String(index)}].toolId`);
    assertNonEmpty(tool.schemaVersion, `tools[${String(index)}].schemaVersion`);
    assertNonNegativeInteger(tool.acceptedCalls, `tools[${String(index)}].acceptedCalls`);
    assertNonNegativeInteger(tool.deniedCalls, `tools[${String(index)}].deniedCalls`);
  }
}

function findToolAccounting(
  accounting: ToolCallAccounting,
  identity: ToolCallIdentity,
): PerToolCallAccounting {
  const entry = accounting.tools.find(
    (tool) => tool.toolId === identity.toolId && tool.schemaVersion === identity.schemaVersion,
  );
  if (!entry) throw new Error(`missing accounting entry for ${identity.toolId}@${identity.schemaVersion}`);
  return entry;
}

function assertPlainRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a plain object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
  }
}

function assertExactKeys(value: object, expected: readonly string[], path: string): void {
  const keys = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (keys.length !== sortedExpected.length
    || keys.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${path} fields are invalid`);
  }
}

function assertNonEmpty(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be non-empty`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
