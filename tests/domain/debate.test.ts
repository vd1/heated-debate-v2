import { describe, expect, test } from "bun:test";

import {
  ScriptedAgent,
  type AgentPort,
  type AgentReply,
  type RequestedControls,
  type ScriptedReply,
} from "../../src/domain/agent";
import { runDebate } from "../../src/domain/debate";
import type { ExchangeParticipant } from "../../src/domain/exchange";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";

const PROPOSER_CONTROLS: RequestedControls = {
  model: { providerId: "test", modelId: "proposer" },
  thinkingLevel: "high",
  temperature: 0.7,
};
const REVIEWER_CONTROLS: RequestedControls = {
  model: { providerId: "test", modelId: "reviewer" },
  thinkingLevel: "medium",
};

function scriptedReply(text: string, controls: RequestedControls): ScriptedReply {
  const reply: AgentReply = {
    text,
    durationMs: 1,
    model: controls.model,
    controls: {
      model: { requested: controls.model, forwarded: controls.model },
      thinkingLevel: {
        requested: controls.thinkingLevel,
        forwarded: controls.thinkingLevel,
      },
    },
    usage: {},
    trace: { attempts: [] },
  };
  return {
    ...reply,
    usage: { values: {}, explicitlyReported: [] },
  };
}

function participant(
  role: "proposer" | "reviewer",
  controls: RequestedControls,
  replies: string[],
  order: string[],
): { config: ExchangeParticipant; agent: ScriptedAgent } {
  const agent = new ScriptedAgent(replies.map((text) => scriptedReply(text, controls)));
  const orderedAgent: AgentPort = {
    reply(request) {
      order.push(request.turnId);
      return agent.reply(request);
    },
    dispose() {
      return agent.dispose();
    },
  };
  return {
    config: {
      agent: orderedAgent,
      role: role === "proposer" ? PROPOSER_ROLE : REVIEWER_ROLE,
      controls,
    },
    agent,
  };
}

describe("runDebate", () => {
  test("runs two chronological rounds with exactly four policy-selected turns", async () => {
    const order: string[] = [];
    const proposer = participant("proposer", PROPOSER_CONTROLS, ["P1", "P2"], order);
    const reviewer = participant("reviewer", REVIEWER_CONTROLS, ["R1", "R2"], order);

    const result = await runDebate({
      debateId: "debate-7",
      topic: "Design a scheduler.",
      roundCount: 2,
      proposer: proposer.config,
      reviewer: reviewer.config,
    });

    expect(order).toEqual([
      "debate-7:round-1:proposer",
      "debate-7:round-1:reviewer",
      "debate-7:round-2:proposer",
      "debate-7:round-2:reviewer",
    ]);
    expect(proposer.agent.requests).toHaveLength(2);
    expect(reviewer.agent.requests).toHaveLength(2);
    expect(result.rounds.map((round) => ({
      roundNumber: round.roundNumber,
      proposal: round.exchange.proposal.reply.text,
      review: round.exchange.review.reply.text,
    }))).toEqual([
      { roundNumber: 1, proposal: "P1", review: "R1" },
      { roundNumber: 2, proposal: "P2", review: "R2" },
    ]);

    expect(proposer.agent.requests.map((request) => request.creativity.level)).toEqual([5, 1]);
    expect(reviewer.agent.requests.map((request) => request.creativity.level)).toEqual([5, 1]);
    expect(proposer.agent.requests.map((request) => request.controls.temperature)).toEqual([0.7, 0.7]);
    expect(proposer.agent.requests[0]?.context.messages).toEqual([
      {
        role: "user",
        content: "[Creativity: 5/5] Explore radical alternatives. Question the premise. Propose unconventional approaches even if risky.\n\nTopic:\nDesign a scheduler.",
      },
    ]);
    expect(reviewer.agent.requests[0]?.context.messages).toEqual([
      {
        role: "user",
        content: "[Creativity: 5/5] Explore radical alternatives. Question the premise. Propose unconventional approaches even if risky.\n\nTopic:\nDesign a scheduler.\n\nCurrent proposal:\nP1",
      },
    ]);
    expect(proposer.agent.requests[1]?.context.messages).toEqual([
      {
        role: "user",
        content: "[Creativity: 1/5] Converge and finalize the architectural decisions into a clear bulleted plan.\n\nTopic:\nDesign a scheduler.\n\nPrevious proposal:\nP1\n\nReview:\nR1",
      },
    ]);
    expect(reviewer.agent.requests[1]?.context.messages).toEqual([
      {
        role: "user",
        content: [
          "[Creativity: 1/5] Converge and finalize the architectural decisions into a clear bulleted plan.",
          "",
          "Topic:",
          "Design a scheduler.",
          "",
          "Previous review:",
          "R1",
          "",
          "Previous proposal:",
          "P1",
          "",
          "Current proposal:",
          "P2",
        ].join("\n"),
      },
    ]);
  });

  test("last-exchange excludes responses older than the immediately prior round", async () => {
    const order: string[] = [];
    const proposer = participant("proposer", PROPOSER_CONTROLS, ["OLD_P1", "P2", "P3"], order);
    const reviewer = participant("reviewer", REVIEWER_CONTROLS, ["OLD_R1", "R2", "R3"], order);

    await runDebate({
      debateId: "bounded",
      topic: "Bound context.",
      roundCount: 3,
      proposer: proposer.config,
      reviewer: reviewer.config,
    });

    const proposerRound3 = proposer.agent.requests[2]?.context.messages[0]?.content ?? "";
    const reviewerRound3 = reviewer.agent.requests[2]?.context.messages[0]?.content ?? "";
    expect(proposerRound3).toContain("Previous proposal:\nP2");
    expect(proposerRound3).toContain("Review:\nR2");
    expect(reviewerRound3).toContain("Previous review:\nR2");
    expect(reviewerRound3).toContain("Previous proposal:\nP2");
    expect(proposerRound3).not.toContain("OLD_P1");
    expect(proposerRound3).not.toContain("OLD_R1");
    expect(reviewerRound3).not.toContain("OLD_P1");
    expect(reviewerRound3).not.toContain("OLD_R1");
  });

  test("rejects a non-positive or non-integer round count before dispatch", async () => {
    const order: string[] = [];
    const proposer = participant("proposer", PROPOSER_CONTROLS, [], order);
    const reviewer = participant("reviewer", REVIEWER_CONTROLS, [], order);

    for (const roundCount of [0, -1, 1.5]) {
      let error: unknown;
      try {
        await runDebate({
          debateId: "invalid",
          topic: "Topic",
          roundCount,
          proposer: proposer.config,
          reviewer: reviewer.config,
        });
      } catch (caught) {
        error = caught;
      }
      expect((error as Error).message).toBe("roundCount must be a positive integer");
    }
    expect(order).toEqual([]);
  });
});
