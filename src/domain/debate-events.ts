import type { DebateResult } from "./debate";
import {
  assertCanonicalEvent,
  type CanonicalEvent,
  type CanonicalTurnReply,
} from "./events";

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
    schemaVersion: 1,
    runId: artifactRunId,
    sequence,
    type: "run.started",
    data: {
      debateId: result.debateId,
      topic: result.topic,
      roundCount: result.rounds.length,
      controls: {
        policyId: "run-controls",
        policyVersion: "1",
        turnTimeoutMs: null,
        budget: null,
      },
    },
  });

  for (const round of result.rounds) {
    for (const turn of [round.exchange.proposal, round.exchange.review]) {
      append({
        schemaVersion: 1,
        runId: artifactRunId,
        sequence,
        type: "turn.requested",
        data: {
          roundNumber: round.roundNumber,
          request: structuredClone(turn.request),
        },
      });
      for (const attempt of turn.reply.trace.attempts) {
        append({
          schemaVersion: 1,
          runId: artifactRunId,
          sequence,
          type: "adapter.attempt",
          data: {
            turnId: turn.request.turnId,
            attempt: structuredClone(attempt),
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
        schemaVersion: 1,
        runId: artifactRunId,
        sequence,
        type: "turn.completed",
        data: { turnId: turn.request.turnId, reply },
      });
    }
  }

  append({
    schemaVersion: 1,
    runId: artifactRunId,
    sequence,
    type: "run.completed",
    data: { turnCount: result.rounds.length * 2 },
  });

  return deepFreeze(events);
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
