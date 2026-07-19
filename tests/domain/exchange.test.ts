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
    participant: { agent: orderedAgent, systemPrompt, controls },
    agent,
  };
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
      systemPrompt: "Propose a concrete architecture.",
      prompt: "Topic:\nDesign a resilient job processor.",
      controls: PROPOSER_CONTROLS,
      capabilities: { toolNames: [] },
    };
    const expectedReviewRequest: TurnRequest = {
      turnId: "exchange-42:reviewer",
      systemPrompt: "Challenge the proposal.",
      prompt: [
        "Topic:",
        "Design a resilient job processor.",
        "",
        "Proposal:",
        "Use a queue with explicit backpressure.",
      ].join("\n"),
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
