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
import type { ToolCallRecord } from "./tool-loop";
import {
  assertToolCapabilityPolicy,
  type UnrecordedToolCapabilityPolicy,
} from "./tool-policy";

export const CANONICAL_SCHEMA_VERSION = 7 as const;

export interface CanonicalMonetaryBudget {
  maxAmount: number;
  currency: string;
  snapshotId: string;
  snapshotVersion: string;
  snapshotHash: string;
  permitTokenOnlyAccounting: boolean;
}

export type CanonicalRunControls =
  | {
      policyId: "run-controls";
      policyVersion: "1";
      evidence: "recorded";
      turnTimeoutMs: number | null;
      wholeRunTimeoutMs: number | null;
      budget: { maxTurns: number; maxTokens: number } | null;
      monetary: CanonicalMonetaryBudget | null;
    }
  | {
      policyId: "run-controls";
      policyVersion: "1";
      evidence: "unrecorded";
    };

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
      data: {
        debateId: string;
        topic: string;
        roundCount: number;
        controls: CanonicalRunControls;
        experiment: { configHash: string; caseId: string | null } | null;
      };
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
      type: "turn.tool_call";
      data: { turnId: string; record: ToolCallRecord };
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
  "turn.tool_call",
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

export function serializeCanonicalEvent(
  event: CanonicalEvent,
  options: { secrets: readonly string[] },
): string {
  assertCanonicalEvent(event);
  const snapshot = structuredClone(event);
  redactFailureSecrets(snapshot, options.secrets);
  assertCanonicalEvent(snapshot);
  const serialized = JSON.stringify(snapshot);
  assertCanonicalEvent(JSON.parse(serialized) as unknown);
  return serialized;
}

export function parseCanonicalEvent(serialized: string): CanonicalEvent {
  const parsed: unknown = JSON.parse(serialized);
  const value = migrateHistoricalEvent(parsed);
  assertCanonicalEvent(value);
  return value;
}

export function validateCanonicalSequence(events: readonly CanonicalEvent[]): void {
  let runId: string | undefined;
  const turnEvidence = new Map<string, { annotated: number[]; total: number }>();
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
    if (event.type === "adapter.attempt" || event.type === "turn.tool_call") {
      const evidence = turnEvidence.get(event.data.turnId) ?? { annotated: [], total: 0 };
      evidence.total += 1;
      const turnSequence = event.type === "adapter.attempt"
        ? event.data.attempt.turnSequence
        : event.data.record.turnSequence;
      if (turnSequence !== undefined) evidence.annotated.push(turnSequence);
      turnEvidence.set(event.data.turnId, evidence);
    }
  }
  for (const [turnId, evidence] of turnEvidence) {
    if (evidence.annotated.length === 0) continue;
    if (evidence.annotated.length !== evidence.total) {
      throw new Error(`turn ${turnId} mixes sequenced and unsequenced evidence`);
    }
    evidence.annotated.forEach((turnSequence, position) => {
      if (turnSequence !== position + 1) {
        throw new Error(
          `turn ${turnId} shared turn sequence expected ${String(position + 1)}, `
          + `received ${String(turnSequence)}`,
        );
      }
    });
  }
}

export function sanitizeFailure(
  error: unknown,
  options: { code: string; secrets?: readonly string[] },
): SanitizedFailure {
  const message = redactSecrets(
    error instanceof Error ? error.message : String(error),
    options.secrets ?? [],
  );
  return { code: redactSecrets(options.code, options.secrets ?? []), message };
}

function migrateHistoricalEvent(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const event = value as Record<string, unknown>;
  if (typeof event.schemaVersion !== "number"
    || !Number.isInteger(event.schemaVersion)
    || event.schemaVersion < 1
    || event.schemaVersion >= CANONICAL_SCHEMA_VERSION) {
    return value;
  }
  const migrated = structuredClone(event);
  migrated.schemaVersion = CANONICAL_SCHEMA_VERSION;
  if (event.schemaVersion >= 3) {
    migrateHistoricalMonetary(migrated);
    migrateHistoricalExperiment(migrated);
    return migrated;
  }
  if (migrated.type === "run.started"
    && typeof migrated.data === "object"
    && migrated.data !== null
    && !Array.isArray(migrated.data)) {
    const data = migrated.data as Record<string, unknown>;
    if (!hasOwn(data, "controls")) {
      data.controls = {
        policyId: "run-controls",
        policyVersion: "1",
        evidence: "unrecorded",
      } satisfies CanonicalRunControls;
    } else if (typeof data.controls === "object"
      && data.controls !== null
      && !Array.isArray(data.controls)) {
      const controls = data.controls as Record<string, unknown>;
      if (!hasOwn(controls, "evidence")) controls.evidence = "recorded";
      if (!hasOwn(controls, "wholeRunTimeoutMs")) controls.wholeRunTimeoutMs = null;
    }
  }
  migrateHistoricalMonetary(migrated);
  migrateHistoricalExperiment(migrated);
  migrateHistoricalCapabilities(migrated);
  return migrated;
}

function migrateHistoricalExperiment(event: Record<string, unknown>): void {
  if (event.type !== "run.started"
    || typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) return;
  const data = event.data as Record<string, unknown>;
  // Experiment identity did not exist before schema v7; none was recorded.
  if (!hasOwn(data, "experiment")) data.experiment = null;
}

function migrateHistoricalMonetary(event: Record<string, unknown>): void {
  if (event.type !== "run.started"
    || typeof event.data !== "object"
    || event.data === null
    || Array.isArray(event.data)) return;
  const data = event.data as Record<string, unknown>;
  if (typeof data.controls !== "object"
    || data.controls === null
    || Array.isArray(data.controls)) return;
  const controls = data.controls as Record<string, unknown>;
  if (controls.evidence !== "recorded") return;
  // Monetary budgets did not exist before schema v6; none was configured.
  if (!hasOwn(controls, "monetary")) controls.monetary = null;
}

function migrateHistoricalCapabilities(event: Record<string, unknown>): void {
  if (event.type !== "turn.requested"
    || typeof event.data !== "object"
    || event.data === null
    || Array.isArray(event.data)) return;
  const data = event.data as Record<string, unknown>;
  if (typeof data.request !== "object"
    || data.request === null
    || Array.isArray(data.request)) return;
  const request = data.request as Record<string, unknown>;
  if (typeof request.capabilities !== "object"
    || request.capabilities === null
    || Array.isArray(request.capabilities)) return;
  const capabilities = request.capabilities as Record<string, unknown>;
  if (!hasOwn(capabilities, "toolNames")) return;
  request.capabilities = {
    policyId: "legacy-tool-names",
    policyVersion: "1",
    evidence: "unrecorded",
    toolNames: structuredClone(capabilities.toolNames) as readonly string[],
  } satisfies UnrecordedToolCapabilityPolicy;
}

function redactFailureSecrets(event: CanonicalEvent, secrets: readonly string[]): void {
  if (event.type === "turn.tool_call") {
    const outcome = event.data.record.outcome;
    if (outcome !== null && outcome.status === "failed") {
      outcome.error.code = redactSecrets(outcome.error.code, secrets);
      outcome.error.message = redactSecrets(outcome.error.message, secrets);
    }
    return;
  }
  if (event.type !== "turn.failed" && event.type !== "run.failed") return;
  event.data.failure.code = redactSecrets(event.data.failure.code, secrets);
  event.data.failure.message = redactSecrets(event.data.failure.message, secrets);
}

function redactSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
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
    case "turn.tool_call":
      validateTurnToolCall(event.data);
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
  assertExactFields(
    data,
    ["debateId", "topic", "roundCount", "controls", "experiment"],
    [],
    "run.started.data",
  );
  if (data.experiment !== null) {
    const experiment = assertRecord(data.experiment, "run.started.data.experiment");
    assertExactFields(experiment, ["configHash", "caseId"], [], "run.started.data.experiment");
    if (typeof experiment.configHash !== "string" || !/^[0-9a-f]{64}$/.test(experiment.configHash)) {
      throw new Error("experiment.configHash must be a sha256 hex digest");
    }
    if (experiment.caseId !== null) assertNonEmptyString(experiment.caseId, "experiment.caseId");
  }
  assertNonEmptyString(data.debateId, "run.started.data.debateId");
  assertString(data.topic, "run.started.data.topic");
  assertPositiveInteger(data.roundCount, "run.started.data.roundCount");
  validateRunControls(data.controls);
}

function validateRunControls(value: unknown): asserts value is CanonicalRunControls {
  const controls = assertRecord(value, "run.started.data.controls");
  if (controls.policyId !== "run-controls" || controls.policyVersion !== "1") {
    throw new Error("canonical run controls must be run-controls@1");
  }
  if (controls.evidence === "unrecorded") {
    assertExactFields(
      controls,
      ["policyId", "policyVersion", "evidence"],
      [],
      "run.started.data.controls",
    );
    return;
  }
  if (controls.evidence !== "recorded") {
    throw new Error("run control evidence must be recorded or unrecorded");
  }
  assertExactFields(
    controls,
    ["policyId", "policyVersion", "evidence", "turnTimeoutMs", "wholeRunTimeoutMs", "budget", "monetary"],
    [],
    "run.started.data.controls",
  );
  if (controls.monetary !== null) {
    const monetary = assertRecord(controls.monetary, "run.started.data.controls.monetary");
    assertExactFields(
      monetary,
      ["maxAmount", "currency", "snapshotId", "snapshotVersion", "snapshotHash", "permitTokenOnlyAccounting"],
      [],
      "run.started.data.controls.monetary",
    );
    assertNonNegativeNumber(monetary.maxAmount, "controls.monetary.maxAmount");
    assertNonEmptyString(monetary.currency, "controls.monetary.currency");
    assertNonEmptyString(monetary.snapshotId, "controls.monetary.snapshotId");
    assertNonEmptyString(monetary.snapshotVersion, "controls.monetary.snapshotVersion");
    if (typeof monetary.snapshotHash !== "string" || !/^[0-9a-f]{64}$/.test(monetary.snapshotHash)) {
      throw new Error("controls.monetary.snapshotHash must be a sha256 hex digest");
    }
    if (typeof monetary.permitTokenOnlyAccounting !== "boolean") {
      throw new Error("controls.monetary.permitTokenOnlyAccounting must be a boolean");
    }
  }
  if (controls.turnTimeoutMs !== null) {
    assertPositiveNumber(controls.turnTimeoutMs, "run.started.data.controls.turnTimeoutMs");
  }
  if (controls.wholeRunTimeoutMs !== null) {
    assertPositiveNumber(controls.wholeRunTimeoutMs, "run.started.data.controls.wholeRunTimeoutMs");
  }
  if (controls.budget !== null) {
    const budget = assertRecord(controls.budget, "run.started.data.controls.budget");
    assertExactFields(
      budget,
      ["maxTurns", "maxTokens"],
      [],
      "run.started.data.controls.budget",
    );
    assertNonNegativeInteger(budget.maxTurns, "run.started.data.controls.budget.maxTurns");
    assertNonNegativeNumber(budget.maxTokens, "run.started.data.controls.budget.maxTokens");
  }
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

const TOOL_DENIAL_REASONS = new Set([
  "tool_not_allowed",
  "schema_version_not_allowed",
  "aggregate_call_limit_exhausted",
  "tool_call_limit_exhausted",
]);

function validateTurnToolCall(value: unknown): void {
  const data = assertRecord(value, "turn.tool_call.data");
  assertExactFields(data, ["turnId", "record"], [], "turn.tool_call.data");
  assertNonEmptyString(data.turnId, "turn.tool_call.data.turnId");
  validateToolCallRecord(data.record);
}

export function validateToolCallRecord(value: unknown): asserts value is ToolCallRecord {
  const record = assertRecord(value, "record");
  assertExactFields(
    record,
    ["callId", "ordinal", "toolId", "schemaVersion", "arguments", "disposition", "outcome", "durationMs"],
    ["turnSequence"],
    "record",
  );
  if (hasOwn(record, "turnSequence")) {
    assertPositiveInteger(record.turnSequence, "record.turnSequence");
  }
  assertNonEmptyString(record.callId, "record.callId");
  assertPositiveInteger(record.ordinal, "record.ordinal");
  assertNonEmptyString(record.toolId, "record.toolId");
  assertNonEmptyString(record.schemaVersion, "record.schemaVersion");
  assertJsonValue(record.arguments, "record.arguments");
  assertNonNegativeNumber(record.durationMs, "record.durationMs");

  const disposition = assertRecord(record.disposition, "record.disposition");
  if (disposition.status === "accepted") {
    assertExactFields(disposition, ["status"], [], "record.disposition");
    if (record.outcome === null) {
      throw new Error("accepted tool call must record an outcome");
    }
    validateToolCallOutcome(record.outcome);
    return;
  }
  if (disposition.status !== "denied") {
    throw new Error("record.disposition.status must be accepted or denied");
  }
  assertExactFields(disposition, ["status", "reason"], [], "record.disposition");
  if (typeof disposition.reason !== "string" || !TOOL_DENIAL_REASONS.has(disposition.reason)) {
    throw new Error("record.disposition.reason is invalid");
  }
  if (record.outcome !== null) {
    throw new Error("denied tool call cannot record an outcome");
  }
}

function validateToolCallOutcome(value: unknown): void {
  const outcome = assertRecord(value, "record.outcome");
  if (outcome.status === "succeeded") {
    assertExactFields(
      outcome,
      ["status", "output", "outputBytes", "truncation"],
      [],
      "record.outcome",
    );
    assertString(outcome.output, "record.outcome.output");
    assertNonNegativeInteger(outcome.outputBytes, "record.outcome.outputBytes");
    if (outcome.outputBytes !== new TextEncoder().encode(outcome.output).byteLength) {
      throw new Error("output bytes must equal the UTF-8 length of output");
    }
    if (outcome.truncation === null) return;
    const truncation = assertRecord(outcome.truncation, "record.outcome.truncation");
    assertExactFields(truncation, ["originalBytes", "retainedBytes"], [], "record.outcome.truncation");
    assertNonNegativeInteger(truncation.originalBytes, "record.outcome.truncation.originalBytes");
    assertNonNegativeInteger(truncation.retainedBytes, "record.outcome.truncation.retainedBytes");
    if (truncation.retainedBytes >= truncation.originalBytes) {
      throw new Error("truncation must retain fewer bytes than the original");
    }
    if (outcome.outputBytes !== truncation.retainedBytes) {
      throw new Error("truncated output bytes must equal retained bytes");
    }
    return;
  }
  if (outcome.status !== "failed") {
    throw new Error("record.outcome.status must be succeeded or failed");
  }
  assertExactFields(outcome, ["status", "error"], [], "record.outcome");
  validateFailure(outcome.error, "record.outcome.error");
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a JSON value`);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, path);
    return;
  }
  if (typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must be a JSON value`);
    }
    for (const item of Object.values(value)) assertJsonValue(item, path);
    return;
  }
  throw new Error(`${path} must be a JSON value`);
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
  if (request.capabilities.evidence === "recorded"
    && (request.capabilities.role.id !== request.role.id
      || request.capabilities.role.version !== request.role.version)) {
    throw new Error("tool policy role does not match turn request role");
  }
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
  if (creativity.scheduleId !== "linear-cooling" || creativity.scheduleVersion !== "1") {
    throw new Error("canonical creativity schedule must be linear-cooling@1");
  }
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
  if (hasOwn(controls, "temperature")) assertNonNegativeNumber(controls.temperature, "requestedControls.temperature");
  if (hasOwn(controls, "maxOutputTokens")) assertPositiveInteger(controls.maxOutputTokens, "requestedControls.maxOutputTokens");
}

function validateCapabilities(value: unknown): asserts value is CapabilityPolicy {
  const capabilities = assertRecord(value, "capabilities");
  if (capabilities.evidence === "unrecorded") {
    assertExactFields(
      capabilities,
      ["policyId", "policyVersion", "evidence", "toolNames"],
      [],
      "capabilities",
    );
    if (capabilities.policyId !== "legacy-tool-names" || capabilities.policyVersion !== "1") {
      throw new Error("unrecorded capabilities must use legacy-tool-names@1");
    }
    if (!Array.isArray(capabilities.toolNames)
      || !capabilities.toolNames.every((name) => typeof name === "string")) {
      throw new Error("capabilities.toolNames must be a string array");
    }
    return;
  }
  assertToolCapabilityPolicy(value);
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
  if (hasOwn(controls, "temperature")) {
    validateControlTrace(controls.temperature, (item) => {
      assertNonNegativeNumber(item, "control.temperature");
    });
  }
  if (hasOwn(controls, "maxOutputTokens")) {
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
  if (hasOwn(trace, "forwarded")) validateValue(trace.forwarded);
  if (hasOwn(trace, "providerVerified")) validateValue(trace.providerVerified);

  if (hasOwn(trace, "adjusted")) {
    const adjusted = assertRecord(trace.adjusted, "controlTrace.adjusted");
    assertExactFields(adjusted, ["value", "reason"], [], "controlTrace.adjusted");
    validateValue(adjusted.value);
    assertNonEmptyString(adjusted.reason, "controlTrace.adjusted.reason");
  }
  if (hasOwn(trace, "unsupported")) {
    const unsupported = assertRecord(trace.unsupported, "controlTrace.unsupported");
    assertExactFields(unsupported, ["reason"], [], "controlTrace.unsupported");
    assertNonEmptyString(unsupported.reason, "controlTrace.unsupported.reason");
    if (hasOwn(trace, "forwarded") || hasOwn(trace, "adjusted") || hasOwn(trace, "providerVerified")) {
      throw new Error("unsupported control cannot be forwarded, adjusted, or provider-verified");
    }
    return;
  }
  if (!hasOwn(trace, "forwarded")) throw new Error("supported control must be forwarded");
  if (hasOwn(trace, "adjusted")) {
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
    ["httpStatus", "turnSequence"],
    "attempt",
  );
  if (hasOwn(attempt, "turnSequence")) {
    assertPositiveInteger(attempt.turnSequence, "attempt.turnSequence");
  }
  assertPositiveInteger(attempt.attempt, "attempt.attempt");
  if (attempt.status !== "succeeded" && attempt.status !== "failed" && attempt.status !== "aborted") {
    throw new Error("attempt.status is invalid");
  }
  if (hasOwn(attempt, "httpStatus")) {
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
    if (!hasOwn(usage, kind)) continue;
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
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain object`);
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
    if (!hasOwn(value, key)) throw new Error(`missing field at ${path}: ${key}`);
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
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

function assertPositiveNumber(value: unknown, path: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${path} must be a finite positive number`);
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
