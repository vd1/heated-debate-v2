import type {
  AgentPort,
  AgentReply,
  RequestedControls,
  TurnRequest,
} from "./agent";

export interface ExchangeParticipant {
  agent: AgentPort;
  systemPrompt: string;
  controls: RequestedControls;
}

export interface RunExchangeInput {
  exchangeId: string;
  topic: string;
  proposer: ExchangeParticipant;
  reviewer: ExchangeParticipant;
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
  const proposalRequest: TurnRequest = {
    turnId: turnId(input.exchangeId, "proposer"),
    systemPrompt: input.proposer.systemPrompt,
    prompt: proposalPrompt(input.topic),
    controls: structuredClone(input.proposer.controls),
    capabilities: { toolNames: [] },
  };
  const proposalReply = await input.proposer.agent.reply(proposalRequest);

  const reviewRequest: TurnRequest = {
    turnId: turnId(input.exchangeId, "reviewer"),
    systemPrompt: input.reviewer.systemPrompt,
    prompt: reviewPrompt(input.topic, proposalReply.text),
    controls: structuredClone(input.reviewer.controls),
    capabilities: { toolNames: [] },
  };
  const reviewReply = await input.reviewer.agent.reply(reviewRequest);

  return deepFreeze({
    exchangeId: input.exchangeId,
    topic: input.topic,
    proposal: {
      request: structuredClone(proposalRequest),
      reply: structuredClone(proposalReply),
    },
    review: {
      request: structuredClone(reviewRequest),
      reply: structuredClone(reviewReply),
    },
  });
}

function turnId(exchangeId: string, role: "proposer" | "reviewer"): string {
  return `${exchangeId}:${role}`;
}

function proposalPrompt(topic: string): string {
  return `Topic:\n${topic}`;
}

function reviewPrompt(topic: string, proposal: string): string {
  return ["Topic:", topic, "", "Proposal:", proposal].join("\n");
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
