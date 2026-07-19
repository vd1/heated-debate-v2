import { describe, expect, test } from "bun:test";

import {
  ScriptedAgent,
  normalizeUsage,
  type ControlReport,
  type ModelIdentity,
  type TurnRequest,
} from "../../src/domain/agent";

const MODEL: ModelIdentity = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
};

const REQUEST: TurnRequest = {
  turnId: "turn-1",
  systemPrompt: "You are the proposing side.",
  prompt: "Make the first proposal.",
  controls: {
    model: MODEL,
    thinkingLevel: "high",
    temperature: 0.7,
    maxOutputTokens: 512,
  },
  capabilities: {
    toolNames: [],
  },
};

const CONTROL_REPORT: ControlReport = {
  model: {
    requested: MODEL,
    forwarded: MODEL,
    providerVerified: MODEL,
  },
  thinkingLevel: {
    requested: "high",
    forwarded: "high",
  },
  temperature: {
    requested: 0.7,
    adjusted: { value: 0.6, reason: "provider maximum" },
    forwarded: 0.6,
  },
  maxOutputTokens: {
    requested: 512,
    unsupported: { reason: "provider does not expose this control" },
  },
};

describe("ScriptedAgent", () => {
  test("records the request and returns normalized domain data", async () => {
    const agent = new ScriptedAgent([
      {
        text: "Use a staged architecture.",
        durationMs: 125,
        model: MODEL,
        controls: CONTROL_REPORT,
        usage: {
          values: {
            inputTokens: 20,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 3,
            reasoningTokens: 0,
          },
          explicitlyReported: ["outputTokens", "reasoningTokens"],
        },
      },
    ]);

    const reply = await agent.reply(REQUEST);

    expect(agent.requests).toEqual([REQUEST]);
    expect(reply).toEqual({
      text: "Use a staged architecture.",
      durationMs: 125,
      model: MODEL,
      controls: CONTROL_REPORT,
      usage: {
        inputTokens: 20,
        outputTokens: 0,
        cacheWriteTokens: 3,
        reasoningTokens: 0,
      },
    });

    await agent.dispose();
    expect(agent.disposed).toBe(true);
  });

  test("captures an immutable snapshot of each request", async () => {
    const request = structuredClone(REQUEST);
    const agent = new ScriptedAgent([
      {
        text: "Reply",
        durationMs: 1,
        model: MODEL,
        controls: CONTROL_REPORT,
        usage: { values: {}, explicitlyReported: [] },
      },
    ]);

    await agent.reply(request);
    request.prompt = "Mutated after the call";
    request.controls.thinkingLevel = "off";

    expect(agent.requests[0]?.prompt).toBe("Make the first proposal.");
    expect(agent.requests[0]?.controls.thinkingLevel).toBe("high");
  });

  test("rejects replies after disposal", async () => {
    const agent = new ScriptedAgent([]);
    await agent.dispose();

    let error: unknown;
    try {
      await agent.reply(REQUEST);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("scripted agent is disposed");
  });
});

describe("normalizeUsage", () => {
  test("keeps positive values even without separate reporting evidence", () => {
    expect(normalizeUsage({
      values: { inputTokens: 9 },
      explicitlyReported: [],
    })).toEqual({ inputTokens: 9 });
  });

  test("keeps an explicitly reported zero", () => {
    expect(normalizeUsage({
      values: { cacheReadTokens: 0 },
      explicitlyReported: ["cacheReadTokens"],
    })).toEqual({ cacheReadTokens: 0 });
  });

  test("maps an ambiguous zero to absent", () => {
    expect(normalizeUsage({
      values: { cacheReadTokens: 0 },
      explicitlyReported: [],
    })).toEqual({});
  });
});
