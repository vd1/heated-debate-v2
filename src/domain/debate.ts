import {
  runExchange,
  type ExchangeParticipant,
  type ExchangeResult,
  type PriorExchange,
} from "./exchange";

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
  if (!Number.isInteger(input.roundCount) || input.roundCount <= 0) {
    throw new Error("roundCount must be a positive integer");
  }

  const debateId = input.debateId;
  const topic = input.topic;
  const roundCount = input.roundCount;
  const proposer = snapshotParticipant(input.proposer);
  const reviewer = snapshotParticipant(input.reviewer);
  const rounds: DebateRound[] = [];
  let priorExchange: PriorExchange | undefined;

  for (let roundNumber = 1; roundNumber <= roundCount; roundNumber += 1) {
    const exchange = await runExchange({
      exchangeId: `${debateId}:round-${String(roundNumber)}`,
      topic,
      proposer,
      reviewer,
      ...(priorExchange === undefined ? {} : { priorExchange }),
    });
    rounds.push(Object.freeze({ roundNumber, exchange }));
    priorExchange = {
      proposal: exchange.proposal.reply.text,
      review: exchange.review.reply.text,
    };
  }

  return Object.freeze({
    debateId,
    topic,
    rounds: Object.freeze(rounds),
  });
}

function snapshotParticipant(participant: ExchangeParticipant): ExchangeParticipant {
  return {
    agent: participant.agent,
    role: structuredClone(participant.role),
    controls: structuredClone(participant.controls),
  };
}
