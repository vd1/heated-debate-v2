import type { AgentReply, RequestedControls, TurnRequest } from "./agent";
import { selectLastExchangeContext } from "./context";
import type { DebateResult } from "./debate";
import { selectCreativity } from "./dial";
import type { DeepReadonly, ExchangeResult, PriorExchange } from "./exchange";
import type { RoleDefinition } from "./roles";
import {
  createDenyAllToolPolicy,
  resolveToolPolicy,
  type ToolCapabilityPolicy,
  type ToolProtocolPhase,
} from "./tool-policy";

export interface ScheduledParticipant {
  role: RoleDefinition;
  controls: RequestedControls;
  capabilities?: ToolCapabilityPolicy;
}

interface ResolvedScheduledParticipant {
  role: RoleDefinition;
  controls: RequestedControls;
  capabilities: ToolCapabilityPolicy;
}

export interface DebateSchedulerInput {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ScheduledParticipant;
  reviewer: ScheduledParticipant;
  protocol?: { protocolId: string; protocolVersion: string };
  creativitySchedule?: { scheduleId: string; scheduleVersion: string };
  contextPolicy?: { policyId: string; policyVersion: string };
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
  private readonly proposer: ResolvedScheduledParticipant;
  private readonly reviewer: ResolvedScheduledParticipant;
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
    // Selected identities resolve to implementations here; unknown selections
    // fail instead of silently falling back to a different implementation.
    const protocol = input.protocol ?? { protocolId: "proposer-reviewer", protocolVersion: "1" };
    if (protocol.protocolId !== "proposer-reviewer" || protocol.protocolVersion !== "1") {
      throw new Error(
        `protocol ${protocol.protocolId}@${protocol.protocolVersion} is not implemented`,
      );
    }
    const schedule = input.creativitySchedule
      ?? { scheduleId: "linear-cooling", scheduleVersion: "1" };
    if (schedule.scheduleId !== "linear-cooling" || schedule.scheduleVersion !== "1") {
      throw new Error(
        `creativitySchedule ${schedule.scheduleId}@${schedule.scheduleVersion} is not implemented`,
      );
    }
    const contextPolicy = input.contextPolicy
      ?? { policyId: "last-exchange", policyVersion: "1" };
    if (contextPolicy.policyId !== "last-exchange" || contextPolicy.policyVersion !== "1") {
      throw new Error(
        `contextPolicy ${contextPolicy.policyId}@${contextPolicy.policyVersion} is not implemented`,
      );
    }
    this.debateId = input.debateId;
    this.topic = input.topic;
    this.roundCount = input.roundCount;
    this.proposer = resolveParticipant(input.proposer, "proposal");
    this.reviewer = resolveParticipant(input.reviewer, "review");
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
      capabilities: structuredClone(participant.capabilities),
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

  result(): Omit<DebateResult, "controls" | "experiment"> {
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

function resolveParticipant(
  participant: ScheduledParticipant,
  phase: ToolProtocolPhase,
): ResolvedScheduledParticipant {
  const role = structuredClone(participant.role);
  const binding = { role: { id: role.id, version: role.version }, phase };
  return {
    role,
    controls: structuredClone(participant.controls),
    capabilities: participant.capabilities === undefined
      ? createDenyAllToolPolicy(binding)
      : resolveToolPolicy(participant.capabilities, binding),
  };
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value) as DeepReadonly<T>;
}
