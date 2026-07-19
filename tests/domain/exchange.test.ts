import { describe, expect, test } from "bun:test";

import {
  ScriptedAgent,
  type AgentPort,
  type AgentReply,
  type RequestedControls,
  type TurnRequest,
} from "../../src/domain/agent";
import {
  runExchange,
  type ExchangeParticipant,
} from "../../src/domain/exchange";

const PROPOSER_CONTROLS: RequestedControls = {
  model: { providerId: "provider-a", modelId: "architect-model" },
  thinkingLevel: "high",
  temperature: 0.7,
  maxOutputTokens: 512,
};

const REVIEWER_CONTROLS: RequestedControls = {
  model: { providerId: "provider-b", modelId: "reviewer-model" },
  thinkingLevel: "medium",
  maxOutputTokens: 384,
};

function reply(text: string, controls: RequestedControls): AgentReply {
  return {
    text,
    durationMs: 10,
    model: controls.model,
    controls: {
      model: { requested: controls.model, forwarded: controls.model },
      thinkingLevel: {
        requested: controls.thinkingLevel,
        forwarded: controls.thinkingLevel,
      },
      ...(controls.temperature === undefined
        ? {}
        : { temperature: { requested: controls.temperature, forwarded: controls.temperature } }),
      ...(controls.maxOutputTokens === undefined
        ? {}
        : {
            maxOutputTokens: {
              requested: controls.maxOutputTokens,
              forwarded: controls.maxOutputTokens,
            },
          }),
    },
    usage: { inputTokens: 10, outputTokens: 5 },
    trace: { attempts: [] },
  };
}

function scriptedParticipant(
  role: "proposer" | "reviewer",
  systemPrompt: string,
  controls: RequestedControls,
  scriptedReply: AgentReply,
  order: string[],
): { participant: ExchangeParticipant; agent: ScriptedAgent } {
  const agent = new ScriptedAgent([
    {
      ...scriptedReply,
      usage: {
        values: scriptedReply.usage,
        explicitlyReported: [],
      },
    },
  ]);
  const orderedAgent: AgentPort = {
    reply(request) {
      order.push(role);
      return agent.reply(request);
    },
    dispose() {
      return agent.dispose();
    },
  };
  return {
    participant: {
      agent: orderedAgent,
      role: { id: role, version: "test", systemPrompt },
      controls,
    },
    agent,
  };
}

class DeferredAgent implements AgentPort {
  readonly requests: TurnRequest[] = [];
  readonly started: Promise<void>;

  private markStarted: (() => void) | undefined;
  private resolveReply: ((reply: AgentReply) => void) | undefined;
  private readonly pendingReply: Promise<AgentReply>;

  constructor() {
    this.started = new Promise<void>((resolve) => {
      this.markStarted = resolve;
    });
    this.pendingReply = new Promise<AgentReply>((resolve) => {
      this.resolveReply = resolve;
    });
  }

  reply(request: TurnRequest): Promise<AgentReply> {
    this.requests.push(structuredClone(request));
    this.markStarted?.();
    return this.pendingReply;
  }

  resolve(reply: AgentReply): void {
    this.resolveReply?.(reply);
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("runExchange", () => {
  test("runs exactly one proposer turn followed by one reviewer turn", async () => {
    const order: string[] = [];
    const proposalReply = reply("Use a queue with explicit backpressure.", PROPOSER_CONTROLS);
    const reviewReply = reply("Specify queue bounds and overload behavior.", REVIEWER_CONTROLS);
    const proposer = scriptedParticipant(
      "proposer",
      "Propose a concrete architecture.",
      PROPOSER_CONTROLS,
      proposalReply,
      order,
    );
    const reviewer = scriptedParticipant(
      "reviewer",
      "Challenge the proposal.",
      REVIEWER_CONTROLS,
      reviewReply,
      order,
    );

    const result = await runExchange({
      exchangeId: "exchange-42",
      topic: "Design a resilient job processor.",
      proposer: proposer.participant,
      reviewer: reviewer.participant,
    });

    const expectedProposalRequest: TurnRequest = {
      turnId: "exchange-42:proposer",
      role: {
        id: "proposer",
        version: "test",
        systemPrompt: "Propose a concrete architecture.",
      },
      context: {
        policyId: "last-exchange",
        policyVersion: "1",
        messages: [{
          role: "user",
          content: "Topic:\nDesign a resilient job processor.",
        }],
      },
      controls: PROPOSER_CONTROLS,
      capabilities: { toolNames: [] },
    };
    const expectedReviewRequest: TurnRequest = {
      turnId: "exchange-42:reviewer",
      role: {
        id: "reviewer",
        version: "test",
        systemPrompt: "Challenge the proposal.",
      },
      context: {
        policyId: "last-exchange",
        policyVersion: "1",
        messages: [{
          role: "user",
          content: [
            "Topic:",
            "Design a resilient job processor.",
            "",
            "Current proposal:",
            "Use a queue with explicit backpressure.",
          ].join("\n"),
        }],
      },
      controls: REVIEWER_CONTROLS,
      capabilities: { toolNames: [] },
    };

    expect(order).toEqual(["proposer", "reviewer"]);
    expect(proposer.agent.requests).toEqual([expectedProposalRequest]);
    expect(reviewer.agent.requests).toEqual([expectedReviewRequest]);
    expect(result).toEqual({
      exchangeId: "exchange-42",
      topic: "Design a resilient job processor.",
      proposal: { request: expectedProposalRequest, reply: proposalReply },
      review: { request: expectedReviewRequest, reply: reviewReply },
    });
  });

  test("snapshots inputs and replies at each asynchronous boundary", async () => {
    const proposer = new DeferredAgent();
    const reviewer = new DeferredAgent();
    const input = {
      exchangeId: "deferred",
      topic: "Original topic",
      proposer: {
        agent: proposer,
        role: {
          id: "proposer",
          version: "1",
          systemPrompt: "Original proposer system",
        },
        controls: structuredClone(PROPOSER_CONTROLS),
      },
      reviewer: {
        agent: reviewer,
        role: {
          id: "reviewer",
          version: "1",
          systemPrompt: "Original reviewer system",
        },
        controls: structuredClone(REVIEWER_CONTROLS),
      },
    };

    const pending = runExchange(input);
    await proposer.started;
    input.exchangeId = "mutated-id";
    input.topic = "Mutated topic";
    input.reviewer.role.systemPrompt = "Mutated reviewer system";
    input.reviewer.controls.thinkingLevel = "off";

    const mutableProposal = reply("Original proposal", PROPOSER_CONTROLS);
    proposer.resolve(mutableProposal);
    await reviewer.started;
    expect(reviewer.requests[0]).toEqual({
      turnId: "deferred:reviewer",
      role: {
        id: "reviewer",
        version: "1",
        systemPrompt: "Original reviewer system",
      },
      context: {
        policyId: "last-exchange",
        policyVersion: "1",
        messages: [{
          role: "user",
          content: "Topic:\nOriginal topic\n\nCurrent proposal:\nOriginal proposal",
        }],
      },
      controls: REVIEWER_CONTROLS,
      capabilities: { toolNames: [] },
    });

    mutableProposal.text = "Mutated proposal";
    mutableProposal.usage.inputTokens = 999;
    const mutableReview = reply("Original review", REVIEWER_CONTROLS);
    reviewer.resolve(mutableReview);
    const result = await pending;
    mutableReview.text = "Mutated review";

    expect(result.exchangeId).toBe("deferred");
    expect(result.topic).toBe("Original topic");
    expect(result.proposal.reply.text).toBe("Original proposal");
    expect(result.proposal.reply.usage.inputTokens).toBe(10);
    expect(result.review.reply.text).toBe("Original review");
  });

  test("returns deeply frozen snapshots independent of mutable inputs", async () => {
    const order: string[] = [];
    const proposalReply = reply("Proposal", PROPOSER_CONTROLS);
    const reviewReply = reply("Review", REVIEWER_CONTROLS);
    const proposer = scriptedParticipant(
      "proposer",
      "Proposer system",
      structuredClone(PROPOSER_CONTROLS),
      proposalReply,
      order,
    );
    const reviewer = scriptedParticipant(
      "reviewer",
      "Reviewer system",
      structuredClone(REVIEWER_CONTROLS),
      reviewReply,
      order,
    );
    const input = {
      exchangeId: "immutable",
      topic: "Original topic",
      proposer: proposer.participant,
      reviewer: reviewer.participant,
    };

    const result = await runExchange(input);
    input.topic = "Mutated topic";
    input.proposer.controls.thinkingLevel = "off";

    expect(result.topic).toBe("Original topic");
    expect(result.proposal.request.controls.thinkingLevel).toBe("high");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.proposal)).toBe(true);
    expect(Object.isFrozen(result.proposal.request.controls)).toBe(true);
  });
});
