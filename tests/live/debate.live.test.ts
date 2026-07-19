import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AgentReply, RequestedControls } from "../../src/domain/agent";
import { runDebate } from "../../src/domain/debate";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";
import { createPiAgentFromRuntime } from "../../src/infrastructure/pi-agent";
import {
  LIVE_DEBATE_TIMEOUT_MS,
  LIVE_ENABLED,
  LIVE_MODEL,
  withTimeout,
} from "./support";

const CONTROLS: RequestedControls = {
  model: LIVE_MODEL,
  thinkingLevel: "high",
  maxOutputTokens: 128,
};

describe("two-round live debate", () => {
  if (!LIVE_ENABLED) {
    test.skip("requires HEATED_DEBATE_LIVE=1", () => {});
    return;
  }

  test("runs four bounded turns with exact policy-selected messages", async () => {
    const runtime = await ModelRuntime.create();
    const proposer = await createPiAgentFromRuntime({ runtime, model: LIVE_MODEL });
    const reviewer = await createPiAgentFromRuntime({ runtime, model: LIVE_MODEL });

    try {
      const result = await withTimeout(
        runDebate({
          debateId: "live-debate",
          topic: "Propose and review a minimal in-memory FIFO queue with a fixed capacity.",
          roundCount: 2,
          proposer: { agent: proposer, role: PROPOSER_ROLE, controls: CONTROLS },
          reviewer: { agent: reviewer, role: REVIEWER_ROLE, controls: CONTROLS },
        }),
        LIVE_DEBATE_TIMEOUT_MS,
        "live two-round debate",
      );

      const turns = result.rounds.flatMap((round) => [round.exchange.proposal, round.exchange.review]);
      expect(result.rounds).toHaveLength(2);
      expect(turns).toHaveLength(4);
      expect(turns.map((turn) => turn.request.turnId)).toEqual([
        "live-debate:round-1:proposer",
        "live-debate:round-1:reviewer",
        "live-debate:round-2:proposer",
        "live-debate:round-2:reviewer",
      ]);
      expect(turns.map((turn) => turn.request.creativity.level)).toEqual([5, 5, 1, 1]);

      for (const turn of turns) {
        expect(turn.request.context.policyId).toBe("last-exchange");
        expect(turn.request.context.policyVersion).toBe("1");
        expect(turn.request.context.messages.length).toBeGreaterThan(0);
        expect(turn.request.context.messages.at(-1)?.role).toBe("user");
        expect(turn.reply.text.trim().length).toBeGreaterThan(0);
        expect(turn.reply.model.providerId).toBe(LIVE_MODEL.providerId);
        expect(turn.reply.controls.model.requested).toEqual(LIVE_MODEL);
        expect(turn.reply.controls.model.forwarded).toEqual(LIVE_MODEL);
        expect(turn.reply.controls.thinkingLevel).toEqual({ requested: "high", forwarded: "high" });
        expect(turn.reply.controls.maxOutputTokens).toEqual({ requested: 128, forwarded: 128 });
        expect(turn.reply.trace.attempts.length).toBeGreaterThan(0);
        if (turn.reply.controls.model.providerVerified) {
          expect(turn.reply.controls.model.providerVerified).toEqual(turn.reply.model);
        }
        assertNormalizedUsage(turn.reply);
      }

      const round1 = result.rounds[0];
      const round2 = result.rounds[1];
      expect(round1?.exchange.review.request.context.messages[0]?.content).toContain(
        round1?.exchange.proposal.reply.text ?? "missing proposal",
      );
      expect(round2?.exchange.proposal.request.context.messages[0]?.content).toContain(
        round1?.exchange.proposal.reply.text ?? "missing proposal",
      );
      expect(round2?.exchange.proposal.request.context.messages[0]?.content).toContain(
        round1?.exchange.review.reply.text ?? "missing review",
      );
      expect(round2?.exchange.review.request.context.messages[0]?.content).toContain(
        round2?.exchange.proposal.reply.text ?? "missing proposal",
      );

      console.info(`LIVE_DEBATE_RESULT ${JSON.stringify({
        debateId: result.debateId,
        roundCount: result.rounds.length,
        turnIds: turns.map((turn) => turn.request.turnId),
        models: turns.map((turn) => turn.reply.model),
        controls: turns.map((turn) => turn.reply.controls),
        usage: turns.map((turn) => turn.reply.usage),
      })}`);
    } finally {
      await Promise.allSettled([proposer.dispose(), reviewer.dispose()]);
    }
  }, LIVE_DEBATE_TIMEOUT_MS + 15_000);
});

function assertNormalizedUsage(reply: AgentReply): void {
  for (const tokens of Object.values(reply.usage)) {
    expect(tokens).toBeGreaterThanOrEqual(0);
  }
}
