import type { AgentReply, RequestedControls, TurnRequest } from "./agent";
import { selectLastExchangeContext } from "./context";
import type { DebateResult } from "./debate";
import { selectCreativity } from "./dial";
import type { DeepReadonly, ExchangeResult, PriorExchange } from "./exchange";
import type { RoleDefinition } from "./roles";

export interface ScheduledParticipant {
  role: RoleDefinition;
  controls: RequestedControls;
}

export interface DebateSchedulerInput {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ScheduledParticipant;
  reviewer: ScheduledParticipant;
}

export interface ScheduledTurn {
  readonly side: "proposer" | "reviewer";
  readonly roundNumber: number;
  readonly request: DeepReadonly<TurnRequest>;
}

interface PendingTurn {
  turn: ScheduledTurn;
  request: TurnRequest;
}

export class DebateScheduler {
  private readonly debateId: string;
  private readonly topic: string;
  private readonly roundCount: number;
  private readonly proposer: ScheduledParticipant;
  private readonly reviewer: ScheduledParticipant;
  private readonly rounds: Array<{ readonly roundNumber: number; readonly exchange: ExchangeResult }> = [];
  private roundNumber = 1;
  private side: "proposer" | "reviewer" = "proposer";
  private priorExchange: PriorExchange | undefined;
  private proposal: { request: TurnRequest; reply: AgentReply } | undefined;
  private pending: PendingTurn | undefined;

  constructor(input: DebateSchedulerInput) {
    if (!Number.isInteger(input.roundCount) || input.roundCount <= 0) {
      throw new Error("roundCount must be a positive integer");
    }
    this.debateId = input.debateId;
    this.topic = input.topic;
    this.roundCount = input.roundCount;
    this.proposer = {
      role: structuredClone(input.proposer.role),
      controls: structuredClone(input.proposer.controls),
    };
    this.reviewer = {
      role: structuredClone(input.reviewer.role),
      controls: structuredClone(input.reviewer.controls),
    };
  }

  nextTurn(): ScheduledTurn | undefined {
    if (this.pending) return this.pending.turn;
    if (this.roundNumber > this.roundCount) return undefined;

    const creativity = selectCreativity(this.roundNumber - 1, this.roundCount);
    const exchangeId = `${this.debateId}:round-${String(this.roundNumber)}`;
    const participant = this.side === "proposer" ? this.proposer : this.reviewer;
    const request: TurnRequest = {
      turnId: `${exchangeId}:${this.side}`,
      role: structuredClone(participant.role),
      creativity: structuredClone(creativity),
      context: this.side === "proposer"
        ? selectLastExchangeContext({
            role: "proposer",
            topic: this.topic,
            creativity,
            ...(this.priorExchange === undefined
              ? {}
              : {
                  ownPriorResponse: this.priorExchange.proposal,
                  counterpartyResponse: this.priorExchange.review,
                }),
          })
        : selectLastExchangeContext({
            role: "reviewer",
            topic: this.topic,
            creativity,
            currentProposal: this.requireProposal().reply.text,
            ...(this.priorExchange === undefined
              ? {}
              : {
                  ownPriorResponse: this.priorExchange.review,
                  counterpartyResponse: this.priorExchange.proposal,
                }),
          }),
      controls: structuredClone(participant.controls),
      capabilities: { toolNames: [] },
    };
    const turn = deepFreeze({
      side: this.side,
      roundNumber: this.roundNumber,
      request: structuredClone(request),
    });
    this.pending = { turn, request: structuredClone(request) };
    return turn;
  }

  acceptReply(reply: AgentReply): void {
    const pending = this.pending;
    if (!pending) throw new Error("cannot accept a reply without a pending turn");
    const replySnapshot = structuredClone(reply);

    if (pending.turn.side === "proposer") {
      this.proposal = { request: pending.request, reply: replySnapshot };
      this.side = "reviewer";
      this.pending = undefined;
      return;
    }

    const proposal = this.requireProposal();
    const exchange = deepFreeze({
      exchangeId: `${this.debateId}:round-${String(this.roundNumber)}`,
      topic: this.topic,
      proposal: {
        request: proposal.request,
        reply: proposal.reply,
      },
      review: {
        request: pending.request,
        reply: replySnapshot,
      },
    });
    this.rounds.push(Object.freeze({ roundNumber: this.roundNumber, exchange }));
    this.priorExchange = {
      proposal: proposal.reply.text,
      review: replySnapshot.text,
    };
    this.proposal = undefined;
    this.pending = undefined;
    this.side = "proposer";
    this.roundNumber += 1;
  }

  result(): DebateResult {
    if (this.pending || this.roundNumber <= this.roundCount) {
      throw new Error("debate schedule is not complete");
    }
    return deepFreeze({
      debateId: this.debateId,
      topic: this.topic,
      rounds: this.rounds,
    });
  }

  private requireProposal(): { request: TurnRequest; reply: AgentReply } {
    if (!this.proposal) throw new Error("reviewer turn requires a proposal reply");
    return this.proposal;
  }
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value) as DeepReadonly<T>;
}
