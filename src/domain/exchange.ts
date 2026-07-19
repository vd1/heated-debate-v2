import type {
  AgentPort,
  AgentReply,
  RequestedControls,
  TurnRequest,
} from "./agent";
import { selectLastExchangeContext } from "./context";
import type { RoleDefinition } from "./roles";

export interface ExchangeParticipant {
  agent: AgentPort;
  role: RoleDefinition;
  controls: RequestedControls;
}

export interface PriorExchange {
  proposal: string;
  review: string;
}

export interface RunExchangeInput {
  exchangeId: string;
  topic: string;
  proposer: ExchangeParticipant;
  reviewer: ExchangeParticipant;
  priorExchange?: PriorExchange;
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer Item)[]
    ? readonly DeepReadonly<Item>[]
    : T extends object
      ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
      : T;

export interface ExchangeTurn {
  readonly request: DeepReadonly<TurnRequest>;
  readonly reply: DeepReadonly<AgentReply>;
}

export interface ExchangeResult {
  readonly exchangeId: string;
  readonly topic: string;
  readonly proposal: ExchangeTurn;
  readonly review: ExchangeTurn;
}

export async function runExchange(input: RunExchangeInput): Promise<ExchangeResult> {
  const exchangeId = input.exchangeId;
  const topic = input.topic;
  const priorExchange = input.priorExchange === undefined
    ? undefined
    : structuredClone(input.priorExchange);
  const proposer = {
    agent: input.proposer.agent,
    role: structuredClone(input.proposer.role),
    controls: structuredClone(input.proposer.controls),
  };
  const reviewer = {
    agent: input.reviewer.agent,
    role: structuredClone(input.reviewer.role),
    controls: structuredClone(input.reviewer.controls),
  };

  const proposalRequest: TurnRequest = {
    turnId: turnId(exchangeId, "proposer"),
    role: proposer.role,
    context: selectLastExchangeContext({
      role: "proposer",
      topic,
      ...(priorExchange === undefined
        ? {}
        : {
            ownPriorResponse: priorExchange.proposal,
            counterpartyResponse: priorExchange.review,
          }),
    }),
    controls: proposer.controls,
    capabilities: { toolNames: [] },
  };
  const proposalRequestSnapshot = structuredClone(proposalRequest);
  const proposalReply = structuredClone(await proposer.agent.reply(proposalRequest));

  const reviewRequest: TurnRequest = {
    turnId: turnId(exchangeId, "reviewer"),
    role: reviewer.role,
    context: selectLastExchangeContext({
      role: "reviewer",
      topic,
      currentProposal: proposalReply.text,
      ...(priorExchange === undefined
        ? {}
        : {
            ownPriorResponse: priorExchange.review,
            counterpartyResponse: priorExchange.proposal,
          }),
    }),
    controls: reviewer.controls,
    capabilities: { toolNames: [] },
  };
  const reviewRequestSnapshot = structuredClone(reviewRequest);
  const reviewReply = structuredClone(await reviewer.agent.reply(reviewRequest));

  return deepFreeze({
    exchangeId,
    topic,
    proposal: {
      request: proposalRequestSnapshot,
      reply: proposalReply,
    },
    review: {
      request: reviewRequestSnapshot,
      reply: reviewReply,
    },
  });
}

function turnId(exchangeId: string, role: "proposer" | "reviewer"): string {
  return `${exchangeId}:${role}`;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value as DeepReadonly<T>;
  }

  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key));
  }
  return Object.freeze(value) as DeepReadonly<T>;
}
