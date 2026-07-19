import type { CanonicalEvent, CanonicalTurnReply } from "./events";
import type { ExchangeParticipant, ExchangeResult } from "./exchange";
import { DebateScheduler } from "./scheduler";

/**
 * The runner flushes after run start, before each agent dispatch, after each
 * attempt/completion batch, and after the terminal event. A failed dispatch
 * therefore leaves a readable prefix ending at its committed turn request.
 */
export interface DebateEventSink {
  append(event: CanonicalEvent): Promise<void>;
  flush(): Promise<void>;
}

export interface DebateRecording {
  runId: string;
  sink: DebateEventSink;
}

export interface RunDebateInput {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ExchangeParticipant;
  reviewer: ExchangeParticipant;
  recording?: DebateRecording;
}

export interface DebateRound {
  readonly roundNumber: number;
  readonly exchange: ExchangeResult;
}

export interface DebateResult {
  readonly debateId: string;
  readonly topic: string;
  readonly rounds: readonly DebateRound[];
}

export async function runDebate(input: RunDebateInput): Promise<DebateResult> {
  const proposerAgent = input.proposer.agent;
  const reviewerAgent = input.reviewer.agent;
  const scheduler = new DebateScheduler({
    debateId: input.debateId,
    topic: input.topic,
    roundCount: input.roundCount,
    proposer: input.proposer,
    reviewer: input.reviewer,
  });

  let sequence = 0;
  const emit = async (event: CanonicalEvent, flush: boolean): Promise<void> => {
    if (!input.recording) return;
    await input.recording.sink.append(event);
    sequence += 1;
    if (flush) await input.recording.sink.flush();
  };

  if (input.recording) {
    await emit({
      schemaVersion: 1,
      runId: input.recording.runId,
      sequence,
      type: "run.started",
      data: {
        debateId: input.debateId,
        topic: input.topic,
        roundCount: input.roundCount,
      },
    }, true);
  }

  let turnCount = 0;
  for (let turn = scheduler.nextTurn(); turn !== undefined; turn = scheduler.nextTurn()) {
    if (input.recording) {
      await emit({
        schemaVersion: 1,
        runId: input.recording.runId,
        sequence,
        type: "turn.requested",
        data: {
          roundNumber: turn.roundNumber,
          request: structuredClone(turn.request),
        },
      }, true);
    }

    const agent = turn.side === "proposer" ? proposerAgent : reviewerAgent;
    const reply = await agent.reply(structuredClone(turn.request));
    scheduler.acceptReply(reply);
    if (input.recording) {
      for (const attempt of reply.trace.attempts) {
        await emit({
          schemaVersion: 1,
          runId: input.recording.runId,
          sequence,
          type: "adapter.attempt",
          data: {
            turnId: turn.request.turnId,
            attempt: structuredClone(attempt),
          },
        }, false);
      }
      const canonicalReply: CanonicalTurnReply = {
        text: reply.text,
        durationMs: reply.durationMs,
        model: structuredClone(reply.model),
        controls: structuredClone(reply.controls),
      };
      await emit({
        schemaVersion: 1,
        runId: input.recording.runId,
        sequence,
        type: "turn.completed",
        data: { turnId: turn.request.turnId, reply: canonicalReply },
      }, true);
    }
    turnCount += 1;
  }
  const result = scheduler.result();
  if (input.recording) {
    await emit({
      schemaVersion: 1,
      runId: input.recording.runId,
      sequence,
      type: "run.completed",
      data: { turnCount },
    }, true);
  }
  return result;
}
