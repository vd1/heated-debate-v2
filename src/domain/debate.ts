import type { ExchangeParticipant, ExchangeResult } from "./exchange";
import { DebateScheduler } from "./scheduler";

export interface RunDebateInput {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ExchangeParticipant;
  reviewer: ExchangeParticipant;
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

  for (let turn = scheduler.nextTurn(); turn !== undefined; turn = scheduler.nextTurn()) {
    const agent = turn.side === "proposer" ? proposerAgent : reviewerAgent;
    const reply = await agent.reply(structuredClone(turn.request));
    scheduler.acceptReply(reply);
  }
  return scheduler.result();
}
