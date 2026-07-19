import { describe, expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  AgentPort,
  ModelIdentity,
  TurnRequest,
} from "../../src/domain/agent";
import { createPiAgentFromRuntime } from "../../src/infrastructure/pi-agent";

const LIVE_ENABLED = process.env.HEATED_DEBATE_LIVE === "1";
const LIVE_TIMEOUT_MS = 60_000;

const LIVE_MODEL: ModelIdentity = {
  providerId: process.env.HEATED_DEBATE_PROVIDER ?? "openai-codex",
  modelId: process.env.HEATED_DEBATE_MODEL ?? "gpt-5.6-sol",
};

describe("PiAgent live provider smoke", () => {
  if (!LIVE_ENABLED) {
    test.skip("requires HEATED_DEBATE_LIVE=1", () => {});
    return;
  }

  test("uses stored Pi authentication for one bounded turn", async () => {
    const runtime = await ModelRuntime.create();
    const agent = await createPiAgentFromRuntime({
      runtime,
      model: LIVE_MODEL,
    });
    const request: TurnRequest = {
      turnId: "live-smoke-1",
      role: {
        id: "live-smoke",
        version: "1",
        systemPrompt: "You are a concise connectivity test. Do not use tools.",
      },
      creativity: {
        scheduleId: "linear-cooling",
        scheduleVersion: "1",
        level: 3,
        instruction: "Mix new ideas with refinement. Address open questions. Weigh tradeoffs.",
      },
      context: {
        policyId: "last-exchange",
        policyVersion: "1",
        messages: [{
          role: "user",
          content: "[Creativity: 3/5] Mix new ideas with refinement. Address open questions. Weigh tradeoffs.\n\nReply with a brief confirmation that the live model call succeeded.",
        }],
      },
      controls: {
        model: LIVE_MODEL,
        thinkingLevel: "high",
        maxOutputTokens: 128,
      },
      capabilities: { toolNames: [] },
    };

    try {
      const reply = await replyWithTimeout(agent, request, LIVE_TIMEOUT_MS);

      expect(reply.text.trim().length).toBeGreaterThan(0);
      expect(reply.controls.model.requested).toEqual(LIVE_MODEL);
      expect(reply.controls.model.forwarded).toEqual(LIVE_MODEL);
      expect(reply.trace.attempts.length).toBeGreaterThan(0);
      if (reply.controls.model.providerVerified) {
        expect(reply.controls.model.providerVerified).toEqual(reply.model);
      }
      for (const tokens of Object.values(reply.usage)) {
        expect(tokens).toBeGreaterThanOrEqual(0);
      }

      console.info(`LIVE_RESULT ${JSON.stringify({
        model: reply.model,
        controls: reply.controls,
        usage: reply.usage,
      })}`);
    } finally {
      await agent.dispose();
    }
  }, LIVE_TIMEOUT_MS + 15_000);
});

async function replyWithTimeout(
  agent: AgentPort,
  request: TurnRequest,
  timeoutMs: number,
): Promise<Awaited<ReturnType<AgentPort["reply"]>>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`live model call timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([agent.reply(request), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
