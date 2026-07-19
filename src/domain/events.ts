import type {
  AgentReply,
  AttemptTrace,
  CapabilityPolicy,
  ControlReport,
  ControlTrace,
  ModelIdentity,
  NormalizedUsage,
  RequestedControls,
  ThinkingLevel,
  TurnRequest,
  UsageEvidence,
  UsageKind,
} from "./agent";
import type { ContextDecision } from "./context";
import type { CreativitySelection } from "./dial";
import type { RoleDefinition } from "./roles";

export const CANONICAL_SCHEMA_VERSION = 1 as const;

export interface SanitizedFailure {
  code: string;
  message: string;
}

export type CanonicalTurnReply = Pick<
  AgentReply,
  "text" | "durationMs" | "model" | "controls"
>;

interface EventEnvelope {
  schemaVersion: typeof CANONICAL_SCHEMA_VERSION;
  runId: string;
  sequence: number;
}

export type CanonicalEvent =
  | (EventEnvelope & {
      type: "run.started";
      data: { debateId: string; topic: string; roundCount: number };
    })
  | (EventEnvelope & {
      type: "turn.requested";
      data: { roundNumber: number; request: TurnRequest };
    })
  | (EventEnvelope & {
      type: "adapter.attempt";
      data: { turnId: string; attempt: AttemptTrace };
    })
  | (EventEnvelope & {
      type: "turn.completed";
      data: { turnId: string; reply: CanonicalTurnReply };
    })
  | (EventEnvelope & {
      type: "turn.failed";
      data: { turnId: string; failure: SanitizedFailure };
    })
  | (EventEnvelope & {
      type: "run.completed";
      data: { turnCount: number };
    })
  | (EventEnvelope & {
      type: "run.failed";
      data: { failure: SanitizedFailure };
    });

const EVENT_TYPES = new Set<CanonicalEvent["type"]>([
  "run.started",
  "turn.requested",
  "adapter.attempt",
  "turn.completed",
  "turn.failed",
  "run.completed",
  "run.failed",
]);

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

const USAGE_KINDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const satisfies readonly UsageKind[];

export function serializeCanonicalEvent(event: CanonicalEvent): string {
  assertCanonicalEvent(event);
  return JSON.stringify(event);
}

export function parseCanonicalEvent(serialized: string): CanonicalEvent {
  const value: unknown = JSON.parse(serialized);
  assertCanonicalEvent(value);
  return value;
}

export function validateCanonicalSequence(events: readonly CanonicalEvent[]): void {
  let runId: string | undefined;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    assertCanonicalEvent(event);
    runId ??= event.runId;
    if (event.runId !== runId) {
      throw new Error(`event runId ${event.runId} does not match ${runId}`);
    }
    if (event.sequence !== index) {
      throw new Error(`expected sequence ${String(index)}, received ${String(event.sequence)}`);
    }
  }
}

export function sanitizeFailure(
  error: unknown,
  options: { code: string; secrets?: readonly string[] },
): SanitizedFailure {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of options.secrets ?? []) {
    if (secret.length > 0) message = message.split(secret).join("[REDACTED]");
  }
  return { code: options.code, message };
}

export function assertCanonicalEvent(value: unknown): asserts value is CanonicalEvent {
  const event = assertRecord(value, "event");
  assertExactFields(event, ["schemaVersion", "runId", "sequence", "type", "data"], [], "event");

  if (event.schemaVersion !== CANONICAL_SCHEMA_VERSION) {
    throw new Error(`unsupported schema version: ${String(event.schemaVersion)}`);
  }
  assertNonEmptyString(event.runId, "event.runId");
  assertNonNegativeInteger(event.sequence, "event.sequence");
  if (typeof event.type !== "string" || !EVENT_TYPES.has(event.type as CanonicalEvent["type"])) {
    throw new Error(`unknown event type: ${String(event.type)}`);
  }

  switch (event.type as CanonicalEvent["type"]) {
    case "run.started":
      validateRunStarted(event.data);
      break;
    case "turn.requested":
      validateTurnRequested(event.data);
      break;
    case "adapter.attempt":
      validateAdapterAttempt(event.data);
      break;
    case "turn.completed":
      validateTurnCompleted(event.data);
      break;
    case "turn.failed":
      validateTurnFailed(event.data);
      break;
    case "run.completed":
      validateRunCompleted(event.data);
      break;
    case "run.failed":
      validateRunFailed(event.data);
      break;
  }
}

function validateRunStarted(value: unknown): void {
  const data = assertRecord(value, "run.started.data");
  assertExactFields(data, ["debateId", "topic", "roundCount"], [], "run.started.data");
  assertNonEmptyString(data.debateId, "run.started.data.debateId");
  assertString(data.topic, "run.started.data.topic");
  assertPositiveInteger(data.roundCount, "run.started.data.roundCount");
}

function validateTurnRequested(value: unknown): void {
  const data = assertRecord(value, "turn.requested.data");
  assertExactFields(data, ["roundNumber", "request"], [], "turn.requested.data");
  assertPositiveInteger(data.roundNumber, "turn.requested.data.roundNumber");
  validateTurnRequest(data.request);
}

function validateAdapterAttempt(value: unknown): void {
  const data = assertRecord(value, "adapter.attempt.data");
  assertExactFields(data, ["turnId", "attempt"], [], "adapter.attempt.data");
  assertNonEmptyString(data.turnId, "adapter.attempt.data.turnId");
  validateAttempt(data.attempt);
}

function validateTurnCompleted(value: unknown): void {
  const data = assertRecord(value, "turn.completed.data");
  assertExactFields(data, ["turnId", "reply"], [], "turn.completed.data");
  assertNonEmptyString(data.turnId, "turn.completed.data.turnId");
  validateCanonicalReply(data.reply);
}

function validateTurnFailed(value: unknown): void {
  const data = assertRecord(value, "turn.failed.data");
  assertExactFields(data, ["turnId", "failure"], [], "turn.failed.data");
  assertNonEmptyString(data.turnId, "turn.failed.data.turnId");
  validateFailure(data.failure, "turn.failed.data.failure");
}

function validateRunCompleted(value: unknown): void {
  const data = assertRecord(value, "run.completed.data");
  assertExactFields(data, ["turnCount"], [], "run.completed.data");
  assertNonNegativeInteger(data.turnCount, "run.completed.data.turnCount");
}

function validateRunFailed(value: unknown): void {
  const data = assertRecord(value, "run.failed.data");
  assertExactFields(data, ["failure"], [], "run.failed.data");
  validateFailure(data.failure, "run.failed.data.failure");
}

function validateTurnRequest(value: unknown): asserts value is TurnRequest {
  const request = assertRecord(value, "turn.requested.data.request");
  assertExactFields(
    request,
    ["turnId", "role", "creativity", "context", "controls", "capabilities"],
    [],
    "turn.requested.data.request",
  );
  assertNonEmptyString(request.turnId, "turn.requested.data.request.turnId");
  validateRole(request.role);
  validateCreativity(request.creativity);
  validateContext(request.context);
  validateRequestedControls(request.controls);
  validateCapabilities(request.capabilities);
}

function validateRole(value: unknown): asserts value is RoleDefinition {
  const role = assertRecord(value, "role");
  assertExactFields(role, ["id", "version", "systemPrompt"], [], "role");
  assertNonEmptyString(role.id, "role.id");
  assertNonEmptyString(role.version, "role.version");
  assertString(role.systemPrompt, "role.systemPrompt");
}

function validateCreativity(value: unknown): asserts value is CreativitySelection {
  const creativity = assertRecord(value, "creativity");
  assertExactFields(
    creativity,
    ["scheduleId", "scheduleVersion", "level", "instruction"],
    [],
    "creativity",
  );
  assertNonEmptyString(creativity.scheduleId, "creativity.scheduleId");
  assertNonEmptyString(creativity.scheduleVersion, "creativity.scheduleVersion");
  if (!Number.isInteger(creativity.level) || Number(creativity.level) < 1 || Number(creativity.level) > 5) {
    throw new Error("creativity.level must be an integer from 1 to 5");
  }
  assertString(creativity.instruction, "creativity.instruction");
}

function validateContext(value: unknown): asserts value is ContextDecision {
  const context = assertRecord(value, "context");
  assertExactFields(context, ["policyId", "policyVersion", "messages"], [], "context");
  assertNonEmptyString(context.policyId, "context.policyId");
  assertNonEmptyString(context.policyVersion, "context.policyVersion");
  if (!Array.isArray(context.messages) || context.messages.length === 0) {
    throw new Error("context.messages must be a non-empty array");
  }
  for (const messageValue of context.messages) {
    const message = assertRecord(messageValue, "context.message");
    assertExactFields(message, ["role", "content"], [], "context.message");
    if (message.role !== "user" && message.role !== "assistant") {
      throw new Error("context.message.role must be user or assistant");
    }
    assertString(message.content, "context.message.content");
  }
}

function validateRequestedControls(value: unknown): asserts value is RequestedControls {
  const controls = assertRecord(value, "requestedControls");
  assertExactFields(
    controls,
    ["model", "thinkingLevel"],
    ["temperature", "maxOutputTokens"],
    "requestedControls",
  );
  validateModelIdentity(controls.model, "requestedControls.model");
  if (typeof controls.thinkingLevel !== "string" || !THINKING_LEVELS.has(controls.thinkingLevel as ThinkingLevel)) {
    throw new Error("requestedControls.thinkingLevel is invalid");
  }
  if ("temperature" in controls) assertNonNegativeNumber(controls.temperature, "requestedControls.temperature");
  if ("maxOutputTokens" in controls) assertPositiveInteger(controls.maxOutputTokens, "requestedControls.maxOutputTokens");
}

function validateCapabilities(value: unknown): asserts value is CapabilityPolicy {
  const capabilities = assertRecord(value, "capabilities");
  assertExactFields(capabilities, ["toolNames"], [], "capabilities");
  if (!Array.isArray(capabilities.toolNames) || !capabilities.toolNames.every((name) => typeof name === "string")) {
    throw new Error("capabilities.toolNames must be a string array");
  }
}

function validateCanonicalReply(value: unknown): asserts value is CanonicalTurnReply {
  const reply = assertRecord(value, "turn.completed.data.reply");
  assertExactFields(reply, ["text", "durationMs", "model", "controls"], [], "turn.completed.data.reply");
  assertString(reply.text, "turn.completed.data.reply.text");
  assertNonNegativeNumber(reply.durationMs, "turn.completed.data.reply.durationMs");
  validateModelIdentity(reply.model, "turn.completed.data.reply.model");
  validateControlReport(reply.controls);
}

function validateControlReport(value: unknown): asserts value is ControlReport {
  const controls = assertRecord(value, "controlReport");
  assertExactFields(
    controls,
    ["model", "thinkingLevel"],
    ["temperature", "maxOutputTokens"],
    "controlReport",
  );
  validateControlTrace(controls.model, (item) => {
    validateModelIdentity(item, "control.model");
  });
  validateControlTrace(controls.thinkingLevel, (item) => {
    if (typeof item !== "string" || !THINKING_LEVELS.has(item as ThinkingLevel)) {
      throw new Error("control thinking level is invalid");
    }
  });
  if ("temperature" in controls) {
    validateControlTrace(controls.temperature, (item) => {
      assertNonNegativeNumber(item, "control.temperature");
    });
  }
  if ("maxOutputTokens" in controls) {
    validateControlTrace(controls.maxOutputTokens, (item) => {
      assertPositiveInteger(item, "control.maxOutputTokens");
    });
  }
}

function validateControlTrace<T>(
  value: unknown,
  validateValue: (item: unknown) => void,
): asserts value is ControlTrace<T> {
  const trace = assertRecord(value, "controlTrace");
  assertExactFields(
    trace,
    ["requested"],
    ["forwarded", "adjusted", "unsupported", "providerVerified"],
    "controlTrace",
  );
  validateValue(trace.requested);
  if ("forwarded" in trace) validateValue(trace.forwarded);
  if ("providerVerified" in trace) validateValue(trace.providerVerified);

  if ("adjusted" in trace) {
    const adjusted = assertRecord(trace.adjusted, "controlTrace.adjusted");
    assertExactFields(adjusted, ["value", "reason"], [], "controlTrace.adjusted");
    validateValue(adjusted.value);
    assertNonEmptyString(adjusted.reason, "controlTrace.adjusted.reason");
  }
  if ("unsupported" in trace) {
    const unsupported = assertRecord(trace.unsupported, "controlTrace.unsupported");
    assertExactFields(unsupported, ["reason"], [], "controlTrace.unsupported");
    assertNonEmptyString(unsupported.reason, "controlTrace.unsupported.reason");
    if ("forwarded" in trace || "adjusted" in trace || "providerVerified" in trace) {
      throw new Error("unsupported control cannot be forwarded, adjusted, or provider-verified");
    }
    return;
  }
  if (!("forwarded" in trace)) throw new Error("supported control must be forwarded");
  if ("adjusted" in trace) {
    const adjusted = trace.adjusted as Record<string, unknown>;
    if (!deepEqual(trace.forwarded, adjusted.value)) {
      throw new Error("adjusted control must forward the adjusted value");
    }
  } else if (!deepEqual(trace.forwarded, trace.requested)) {
    throw new Error("changed forwarded control requires an adjustment");
  }
}

function validateAttempt(value: unknown): asserts value is AttemptTrace {
  const attempt = assertRecord(value, "attempt");
  assertExactFields(
    attempt,
    ["attempt", "status", "usage", "usageEvidence"],
    ["httpStatus"],
    "attempt",
  );
  assertPositiveInteger(attempt.attempt, "attempt.attempt");
  if (attempt.status !== "succeeded" && attempt.status !== "failed" && attempt.status !== "aborted") {
    throw new Error("attempt.status is invalid");
  }
  if ("httpStatus" in attempt) {
    assertPositiveInteger(attempt.httpStatus, "attempt.httpStatus");
    if (attempt.httpStatus > 599) throw new Error("attempt.httpStatus must not exceed 599");
  }
  const evidence = validateUsageEvidence(attempt.usageEvidence);
  validateUsage(attempt.usage, evidence);
}

function validateUsageEvidence(value: unknown): UsageEvidence {
  const evidence = assertRecord(value, "usageEvidence");
  assertExactFields(evidence, ["explicitlyReported", "source"], [], "usageEvidence");
  if (!Array.isArray(evidence.explicitlyReported)) {
    throw new Error("usageEvidence.explicitlyReported must be an array");
  }
  const seen = new Set<string>();
  for (const kind of evidence.explicitlyReported) {
    if (typeof kind !== "string" || !USAGE_KINDS.includes(kind as UsageKind)) {
      throw new Error(`unknown usage kind: ${String(kind)}`);
    }
    if (seen.has(kind)) throw new Error(`duplicate usage kind: ${kind}`);
    seen.add(kind);
  }
  assertNonEmptyString(evidence.source, "usageEvidence.source");
  return evidence as unknown as UsageEvidence;
}

function validateUsage(value: unknown, evidence: UsageEvidence): asserts value is NormalizedUsage {
  const usage = assertRecord(value, "usage");
  assertExactFields(usage, [], [...USAGE_KINDS], "usage");
  for (const kind of USAGE_KINDS) {
    if (!(kind in usage)) continue;
    assertNonNegativeNumber(usage[kind], `usage.${kind}`);
    if (usage[kind] === 0 && !evidence.explicitlyReported.includes(kind)) {
      throw new Error(`zero ${kind} requires explicit reporting evidence`);
    }
  }
}

function validateFailure(value: unknown, path: string): asserts value is SanitizedFailure {
  const failure = assertRecord(value, path);
  assertExactFields(failure, ["code", "message"], [], path);
  assertNonEmptyString(failure.code, `${path}.code`);
  assertString(failure.message, `${path}.message`);
}

function validateModelIdentity(value: unknown, path: string): asserts value is ModelIdentity {
  const model = assertRecord(value, path);
  assertExactFields(model, ["providerId", "modelId"], [], path);
  assertNonEmptyString(model.providerId, `${path}.providerId`);
  assertNonEmptyString(model.modelId, `${path}.modelId`);
}

function assertRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function assertExactFields(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  path: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`unknown field at ${path}: ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`missing field at ${path}: ${key}`);
  }
}

function assertString(value: unknown, path: string): asserts value is string {
  if (typeof value !== "string") throw new Error(`${path} must be a string`);
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  assertString(value, path);
  if (value.length === 0) throw new Error(`${path} must not be empty`);
}

function assertNonNegativeNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number`);
  }
}

function assertNonNegativeInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${path} must be a non-negative integer`);
  }
}

function assertPositiveInteger(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${path} must be a positive integer`);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return deepEqual(leftKeys, rightKeys)
    && leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}
