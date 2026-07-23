import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";

import { createDenyAllToolPolicy } from "../../src/domain/tool-policy";
import type { TurnRequest } from "../../src/domain/agent";
import { PiAgent, streamFromModelRuntime } from "../../src/infrastructure/pi-agent";
import { LIVE_ENABLED, LIVE_TURN_TIMEOUT_MS, withTimeout } from "./support";

// Endpoint and model selection stay external to domain code.
const LOCAL_URL = process.env.HEATED_DEBATE_LOCAL_URL;
const LOCAL_MODEL_ID = process.env.HEATED_DEBATE_LOCAL_MODEL ?? "gemma-3-27b";

if (!LIVE_ENABLED || LOCAL_URL === undefined) {
  test.skip("requires HEATED_DEBATE_LIVE=1 and HEATED_DEBATE_LOCAL_URL", () => {});
} else {
  test("completes one turn against an OpenAI-compatible local endpoint", async () => {
    const model: Model<Api> = {
      id: LOCAL_MODEL_ID,
      name: LOCAL_MODEL_ID,
      api: "openai-completions",
      provider: "local",
      baseUrl: LOCAL_URL,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 8_192,
      maxTokens: 512,
    };
    const runtime = await ModelRuntime.create();
    const agent = new PiAgent({
      model,
      modelStream: streamFromModelRuntime(runtime),
      usageEvidence: { explicitlyReported: [], source: "local-openai-compatible" },
    });
    const request: TurnRequest = {
      turnId: "local-1",
      role: { id: "proposer", version: "1", systemPrompt: "Answer in one short sentence." },
      creativity: {
        scheduleId: "linear-cooling",
        scheduleVersion: "1",
        level: 1,
        instruction: "Answer briefly.",
      },
      context: {
        policyId: "last-exchange",
        policyVersion: "1",
        messages: [{ role: "user", content: "Reply with the single word: ready." }],
      },
      controls: {
        model: { providerId: "local", modelId: LOCAL_MODEL_ID },
        thinkingLevel: "off",
        maxOutputTokens: 64,
      },
      capabilities: createDenyAllToolPolicy({
        role: { id: "proposer", version: "1" },
        phase: "proposal",
      }),
    };

    try {
      const reply = await withTimeout(
        agent.reply(request),
        LIVE_TURN_TIMEOUT_MS,
        "local model turn",
      );
      expect(reply.text.length).toBeGreaterThan(0);
      expect(reply.model.providerId).toBe("local");
    } finally {
      await agent.dispose();
    }
  }, LIVE_TURN_TIMEOUT_MS + 10_000);
}
