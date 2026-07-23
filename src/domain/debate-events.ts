import type { AttemptTrace } from "./agent";
import type { DebateResult } from "./debate";
import {
  CANONICAL_SCHEMA_VERSION,
  assertCanonicalEvent,
  type CanonicalEvent,
  type CanonicalTurnReply,
} from "./events";
import type { ToolCallRecord } from "./tool-loop";

export function projectDebateEvents(
  result: DebateResult,
  artifactRunId: string,
): readonly CanonicalEvent[] {
  const events: CanonicalEvent[] = [];
  let sequence = 0;
  const append = (event: CanonicalEvent): void => {
    assertCanonicalEvent(event);
    events.push(event);
    sequence += 1;
  };

  append({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    runId: artifactRunId,
    sequence,
    type: "run.started",
    data: {
      debateId: result.debateId,
      topic: result.topic,
      roundCount: result.rounds.length,
      controls: structuredClone(result.controls),
      experiment: structuredClone(result.experiment),
    },
  });

  for (const round of result.rounds) {
    for (const turn of [round.exchange.proposal, round.exchange.review]) {
      append({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        runId: artifactRunId,
        sequence,
        type: "turn.requested",
        data: {
          roundNumber: round.roundNumber,
          request: structuredClone(turn.request),
        },
      });
      for (const evidence of orderedTurnEvidence(turn.reply.trace.attempts, turn.reply.toolCalls)) {
        append(evidence.kind === "attempt"
          ? {
              schemaVersion: CANONICAL_SCHEMA_VERSION,
              runId: artifactRunId,
              sequence,
              type: "adapter.attempt",
              data: {
                turnId: turn.request.turnId,
                attempt: structuredClone(evidence.attempt),
              },
            }
          : {
              schemaVersion: CANONICAL_SCHEMA_VERSION,
              runId: artifactRunId,
              sequence,
              type: "turn.tool_call",
              data: {
                turnId: turn.request.turnId,
                record: structuredClone(evidence.record),
              },
            });
      }
      const reply: CanonicalTurnReply = {
        text: turn.reply.text,
        durationMs: turn.reply.durationMs,
        model: structuredClone(turn.reply.model),
        controls: structuredClone(turn.reply.controls),
      };
      append({
        schemaVersion: CANONICAL_SCHEMA_VERSION,
        runId: artifactRunId,
        sequence,
        type: "turn.completed",
        data: { turnId: turn.request.turnId, reply },
      });
    }
  }

  append({
    schemaVersion: CANONICAL_SCHEMA_VERSION,
    runId: artifactRunId,
    sequence,
    type: "run.completed",
    data: { turnCount: result.rounds.length * 2 },
  });

  return deepFreeze(events);
}

export type TurnEvidence =
  | { kind: "attempt"; attempt: AttemptTrace }
  | { kind: "tool_call"; record: ToolCallRecord };

/**
 * Orders a turn's attempts and tool calls by their shared turn sequence when
 * every entry carries one; otherwise preserves the bucketed attempt-then-call
 * order for evidence recorded without sequencing.
 */
export function orderedTurnEvidence(
  attempts: readonly AttemptTrace[],
  toolCalls: readonly ToolCallRecord[],
): readonly TurnEvidence[] {
  const bucketed: TurnEvidence[] = [
    ...attempts.map((attempt) => ({ kind: "attempt" as const, attempt })),
    ...toolCalls.map((record) => ({ kind: "tool_call" as const, record })),
  ];
  const sequenceOf = (evidence: TurnEvidence): number | undefined =>
    evidence.kind === "attempt" ? evidence.attempt.turnSequence : evidence.record.turnSequence;
  const annotated = bucketed.filter((evidence) => sequenceOf(evidence) !== undefined);
  if (annotated.length === 0) return bucketed;
  if (annotated.length !== bucketed.length) {
    throw new Error("turn evidence mixes sequenced and unsequenced evidence");
  }
  const ordered = bucketed.slice().sort((left, right) =>
    (sequenceOf(left) ?? 0) - (sequenceOf(right) ?? 0));
  ordered.forEach((evidence, position) => {
    if (sequenceOf(evidence) !== position + 1) {
      throw new Error("shared turn sequence must be unique and consecutive from 1");
    }
  });
  return ordered;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
