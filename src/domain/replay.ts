import type {
  AgentReply,
  RequestedControls,
  TurnRequest,
} from "./agent";
import type { DebateBudget } from "./debate";
import type { DeepReadonly } from "./exchange";
import {
  validateCanonicalSequence,
  type CanonicalEvent,
  type CanonicalRunControls,
  type CanonicalTurnReply,
} from "./events";
import { pricingSnapshotHash } from "./pricing";
import type { RoleDefinition } from "./roles";
import { DebateScheduler } from "./scheduler";
import {
  runToolLoop,
  type ToolCallRecord,
  type ToolDispatcher,
  type ToolLoopDriver,
  type ToolLoopResult,
} from "./tool-loop";
import {
  authorizeToolCall,
  createToolCallAccounting,
  type ToolCapabilityPolicy,
} from "./tool-policy";

export interface ReplayParticipantConfiguration {
  role: RoleDefinition;
  controls: RequestedControls;
  capabilities?: ToolCapabilityPolicy;
}

export interface ReplayConfiguration {
  /** Expected experiment identity; compared against recorded evidence when set. */
  experiment?: { configHash: string; caseId?: string };
  /** Explicitly skip experiment-identity verification for a recorded identity. */
  allowUnverifiedExperiment?: boolean;
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ReplayParticipantConfiguration;
  reviewer: ReplayParticipantConfiguration;
  turnTimeoutMs?: number;
  wholeRunTimeoutMs?: number;
  budget?: DebateBudget;
}

export interface ReplayCanonicalRunInput {
  events: readonly CanonicalEvent[];
  configuration: ReplayConfiguration;
  /**
   * Independent scripted tool-loop drivers keyed by turn ID. When provided for
   * a turn, replay drives that script against the recorded records and rejects
   * request, count, disposition, and final-text drift. Without one, replay
   * still re-authorizes recorded dispositions but cannot independently verify
   * requests or the final response.
   */
  toolLoopDrivers?: (turnId: string) => ToolLoopDriver | undefined;
  /** Fail closed when a recorded tool turn has no independent driver. */
  requireIndependentToolReplay?: boolean;
}

export type ToolReplayGuarantee = "no-tool-calls" | "independent" | "reauthorization-only";

export interface ReplayResult {
  readonly requests: readonly DeepReadonly<TurnRequest>[];
  /**
   * Weakest tool-loop guarantee achieved across the run's turns.
   * "reauthorization-only" means recorded requests and final text were only
   * self-compared; supply toolLoopDrivers for independent verification.
   */
  readonly toolReplayGuarantee: ToolReplayGuarantee;
}

export class ReplayDriftError extends Error {
  readonly name = "ReplayDriftError";

  constructor(
    readonly turnId: string,
    readonly path: string,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(`replay drift for ${turnId} at ${path}`);
  }
}

interface RecordedTurn {
  roundNumber: number;
  request: TurnRequest;
  reply: CanonicalTurnReply;
  toolCalls: readonly ToolCallRecord[];
}

export async function replayCanonicalRun(input: ReplayCanonicalRunInput): Promise<ReplayResult> {
  return replayCanonicalRunInternal(input);
}

async function replayCanonicalRunInternal(input: ReplayCanonicalRunInput): Promise<ReplayResult> {
  validateCanonicalSequence(input.events);
  const trace = readSuccessfulTrace(input.events);
  const configuration = structuredClone(input.configuration);

  assertNoDrift(trace.runId, {
    debateId: trace.debateId,
    topic: trace.topic,
    roundCount: trace.roundCount,
  }, {
    debateId: configuration.debateId,
    topic: configuration.topic,
    roundCount: configuration.roundCount,
  });
  if (trace.controls.evidence === "recorded") {
    assertNoDrift(trace.runId, {
      turnTimeoutMs: trace.controls.turnTimeoutMs,
      wholeRunTimeoutMs: trace.controls.wholeRunTimeoutMs,
      budget: trace.controls.budget,
      monetary: trace.controls.monetary,
    }, {
      turnTimeoutMs: configuration.turnTimeoutMs ?? null,
      wholeRunTimeoutMs: configuration.wholeRunTimeoutMs ?? null,
      budget: configuration.budget === undefined
        ? null
        : { maxTurns: configuration.budget.maxTurns, maxTokens: configuration.budget.maxTokens },
      monetary: configuration.budget?.monetary === undefined
        ? null
        : {
            maxAmount: configuration.budget.monetary.maxAmount,
            currency: configuration.budget.monetary.snapshot.currency,
            snapshotId: configuration.budget.monetary.snapshot.snapshotId,
            snapshotVersion: configuration.budget.monetary.snapshot.snapshotVersion,
            snapshotHash: pricingSnapshotHash(configuration.budget.monetary.snapshot),
            permitTokenOnlyAccounting:
              configuration.budget.monetary.permitTokenOnlyAccounting ?? false,
          },
    });
  }

  if (configuration.experiment !== undefined) {
    assertNoDrift(trace.runId, trace.experiment, {
      configHash: configuration.experiment.configHash,
      caseId: configuration.experiment.caseId ?? null,
    }, "experiment");
  } else if (trace.experiment !== null && configuration.allowUnverifiedExperiment !== true) {
    throw new Error(
      "recorded experiment identity requires an expected identity or allowUnverifiedExperiment",
    );
  }
  const scheduler = new DebateScheduler(configuration);
  const reconstructed: DeepReadonly<TurnRequest>[] = [];
  let guarantee: ToolReplayGuarantee = "no-tool-calls";

  for (const recorded of trace.turns) {
    const replayed = scheduler.nextTurn();
    if (!replayed) {
      throw new Error(
        `recorded ${String(trace.turns.length)} turns but scheduler ended after ${String(reconstructed.length)}`,
      );
    }
    assertNoDrift(recorded.request.turnId, recorded.roundNumber, replayed.roundNumber, "roundNumber");
    assertTurnRequestNoDrift(recorded.request, replayed.request);
    const driver = input.toolLoopDrivers?.(recorded.request.turnId);
    if (recorded.toolCalls.length > 0) {
      if (driver === undefined && input.requireIndependentToolReplay === true) {
        throw new Error(
          `independent tool replay required but no driver was supplied for ${recorded.request.turnId}`,
        );
      }
      if (driver === undefined) guarantee = "reauthorization-only";
      else if (guarantee === "no-tool-calls") guarantee = "independent";
    }
    await replayRecordedToolLoop(recorded, driver);
    reconstructed.push(replayed.request);
    scheduler.acceptReply(toReplayReply(recorded.reply, recorded.toolCalls));
  }
  if (scheduler.nextTurn() !== undefined) {
    throw new Error(`recorded ${String(trace.turns.length)} turns but scheduler has more turns`);
  }
  scheduler.result();

  return Object.freeze({
    requests: Object.freeze(reconstructed),
    toolReplayGuarantee: guarantee,
  });
}

async function replayRecordedToolLoop(
  recorded: RecordedTurn,
  independentDriver: ToolLoopDriver | undefined,
): Promise<void> {
  if (recorded.toolCalls.length === 0 && independentDriver === undefined) return;
  if (recorded.request.capabilities.evidence !== "recorded") {
    throw new Error(
      `cannot deterministically replay tool calls without recorded policy evidence for ${recorded.request.turnId}`,
    );
  }
  if (independentDriver) {
    await replayToolLoop({
      driver: independentDriver,
      policy: recorded.request.capabilities,
      records: recorded.toolCalls,
      finalText: recorded.reply.text,
      id: recorded.request.turnId,
    });
    return;
  }
  const steps = [
    ...recorded.toolCalls.map((record) => ({
      kind: "tool_call" as const,
      request: {
        toolId: record.toolId,
        schemaVersion: record.schemaVersion,
        arguments: structuredClone(record.arguments),
      },
    })),
    { kind: "final" as const, text: recorded.reply.text },
  ];
  let step = 0;
  await replayToolLoop({
    driver: {
      nextStep: () => {
        const next = steps[step];
        step += 1;
        if (!next) throw new Error(`recorded tool loop overran for ${recorded.request.turnId}`);
        return Promise.resolve(next);
      },
    },
    policy: recorded.request.capabilities,
    records: recorded.toolCalls,
    finalText: recorded.reply.text,
    id: recorded.request.turnId,
  });
}

function assertTurnRequestNoDrift(
  recorded: TurnRequest,
  replayed: DeepReadonly<TurnRequest>,
): void {
  const { capabilities: recordedCapabilities, ...recordedProtocol } = recorded;
  const { capabilities: replayedCapabilities, ...replayedProtocol } = replayed;
  assertNoDrift(recorded.turnId, recordedProtocol, replayedProtocol);

  if (recordedCapabilities.evidence === "unrecorded") {
    if (recordedCapabilities.toolNames.length > 0) {
      throw new Error(
        `cannot deterministically replay unrecorded tool capabilities for ${recorded.turnId}`,
      );
    }
    return;
  }
  assertNoDrift(
    recorded.turnId,
    recordedCapabilities,
    replayedCapabilities,
    "capabilities",
  );
}

function readSuccessfulTrace(events: readonly CanonicalEvent[]): {
  runId: string;
  debateId: string;
  topic: string;
  roundCount: number;
  controls: CanonicalRunControls;
  turns: RecordedTurn[];
  experiment: { configHash: string; caseId: string | null } | null;
} {
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("canonical replay must start with run.started");
  const last = events.at(-1);
  if (last?.type === "run.failed") {
    throw new Error("cannot deterministically replay a failed run");
  }
  if (last?.type !== "run.completed") {
    throw new Error("canonical replay requires a terminal run.completed event");
  }
  const turns: RecordedTurn[] = [];
  let active: {
    roundNumber: number;
    request: TurnRequest;
    toolCalls: ToolCallRecord[];
  } | undefined;
  const seenTurnIds = new Set<string>();

  for (const event of events.slice(1, -1)) {
    switch (event.type) {
      case "turn.requested":
        if (active) throw new Error(`recorded turn ${active.request.turnId} has no completion`);
        if (seenTurnIds.has(event.data.request.turnId)) {
          throw new Error(`duplicate recorded turn ${event.data.request.turnId}`);
        }
        seenTurnIds.add(event.data.request.turnId);
        active = {
          roundNumber: event.data.roundNumber,
          request: structuredClone(event.data.request),
          toolCalls: [],
        };
        break;
      case "adapter.attempt":
        if (!active || active.request.turnId !== event.data.turnId) {
          throw new Error(`attempt does not match active turn ${event.data.turnId}`);
        }
        break;
      case "turn.tool_call": {
        if (!active || active.request.turnId !== event.data.turnId) {
          throw new Error(`tool call does not match active turn ${event.data.turnId}`);
        }
        const expectedOrdinal = active.toolCalls.length + 1;
        if (event.data.record.ordinal !== expectedOrdinal) {
          throw new Error(
            `tool call ${event.data.record.callId} has ordinal `
            + `${String(event.data.record.ordinal)} but ${String(expectedOrdinal)} was expected`,
          );
        }
        active.toolCalls.push(structuredClone(event.data.record));
        break;
      }
      case "turn.completed":
        if (!active || active.request.turnId !== event.data.turnId) {
          throw new Error(`completion does not match active turn ${event.data.turnId}`);
        }
        turns.push({
          ...active,
          reply: structuredClone(event.data.reply),
        });
        active = undefined;
        break;
      case "turn.failed":
        throw new Error(`cannot deterministically replay failed turn ${event.data.turnId}`);
      case "run.failed":
        throw new Error("cannot deterministically replay a failed run");
      case "run.started":
        throw new Error("duplicate run.started event");
      case "run.completed":
        throw new Error("run.completed must be the terminal event");
    }
  }
  if (active) throw new Error(`recorded turn ${active.request.turnId} has no completion`);
  if (last.data.turnCount !== turns.length) {
    throw new Error(
      `run.completed records ${String(last.data.turnCount)} turns but trace contains ${String(turns.length)}`,
    );
  }
  if (turns.length !== first.data.roundCount * 2) {
    throw new Error(
      `recorded run requires ${String(first.data.roundCount * 2)} turns but trace contains ${String(turns.length)}`,
    );
  }

  return {
    runId: first.runId,
    experiment: structuredClone(first.data.experiment),
    debateId: first.data.debateId,
    topic: first.data.topic,
    roundCount: first.data.roundCount,
    controls: structuredClone(first.data.controls),
    turns,
  };
}

function toReplayReply(
  reply: CanonicalTurnReply,
  toolCalls: readonly ToolCallRecord[],
): AgentReply {
  return {
    ...structuredClone(reply),
    usage: {},
    trace: { attempts: [] },
    toolCalls: structuredClone(toolCalls),
  };
}

function assertNoDrift(
  turnId: string,
  expected: unknown,
  actual: unknown,
  rootPath = "",
): void {
  const mismatch = findMismatch(expected, actual, rootPath);
  if (mismatch) {
    throw new ReplayDriftError(turnId, mismatch.path, mismatch.expected, mismatch.actual);
  }
}

function findMismatch(
  expected: unknown,
  actual: unknown,
  path: string,
): { path: string; expected: unknown; actual: unknown } | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path, expected, actual };
    const sharedLength = Math.min(expected.length, actual.length);
    for (let index = 0; index < sharedLength; index += 1) {
      const mismatch = findMismatch(expected[index], actual[index], `${path}[${String(index)}]`);
      if (mismatch) return mismatch;
    }
    return expected.length === actual.length
      ? undefined
      : { path: `${path}.length`, expected: expected.length, actual: actual.length };
  }
  if (!isRecord(expected) || !isRecord(actual)) return { path, expected, actual };

  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(expected, key)
      || !Object.prototype.hasOwnProperty.call(actual, key)) {
      return { path: childPath, expected: expected[key], actual: actual[key] };
    }
    const mismatch = findMismatch(expected[key], actual[key], childPath);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ReplayToolLoopInput {
  driver: ToolLoopDriver;
  policy: ToolCapabilityPolicy;
  records: readonly ToolCallRecord[];
  /** Recorded final response; when provided, a differing replayed final response is drift. */
  finalText?: string;
  /** Identity used in drift errors; defaults to "tool-loop". */
  id?: string;
}

export async function replayToolLoop(input: ReplayToolLoopInput): Promise<ToolLoopResult> {
  let position = 0;
  let accounting = createToolCallAccounting(input.policy);
  const replayed: ToolCallRecord[] = [];

  const dispatcher: ToolDispatcher = {
    dispatch: (request) => {
      const recorded = input.records[position];
      if (!recorded) {
        throw new Error(
          `replay has no recorded tool call for replayed dispatch ${String(position + 1)}`,
        );
      }
      position += 1;
      assertNoDrift(recorded.callId, recorded.toolId, request.toolId, "toolId");
      assertNoDrift(
        recorded.callId,
        recorded.schemaVersion,
        request.schemaVersion,
        "schemaVersion",
      );
      assertNoDrift(recorded.callId, recorded.arguments, request.arguments, "arguments");

      const authorization = authorizeToolCall(input.policy, accounting, {
        toolId: recorded.toolId,
        schemaVersion: recorded.schemaVersion,
      });
      accounting = authorization.accounting;
      const replayedDisposition = authorization.decision.status === "accepted"
        ? { status: "accepted" }
        : { status: "denied", reason: authorization.decision.reason };
      assertNoDrift(
        recorded.callId,
        recorded.disposition,
        replayedDisposition,
        "disposition",
      );

      const record = structuredClone(recorded);
      replayed.push(record);
      return Promise.resolve(record);
    },
    trace: () => Object.freeze([...replayed]),
    accounting: () => accounting,
  };

  const result = await runToolLoop({ driver: input.driver, dispatcher });
  if (position !== input.records.length) {
    throw new Error(
      `replay consumed ${String(position)} of ${String(input.records.length)} recorded tool calls`,
    );
  }
  if (input.finalText !== undefined) {
    assertNoDrift(input.id ?? "tool-loop", input.finalText, result.finalText, "finalText");
  }
  return result;
}

