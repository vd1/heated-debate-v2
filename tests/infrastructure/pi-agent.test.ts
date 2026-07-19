import { describe, expect, test } from "bun:test";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  ScriptedAgent,
  type AgentReply,
  type ModelIdentity,
  type TurnRequest,
} from "../../src/domain/agent";
import {
  PiAgent,
  streamFromModelRuntime,
  type ModelStream,
} from "../../src/infrastructure/pi-agent";

const MODEL: Model<"anthropic-messages"> = {
  id: "test-model",
  name: "Test Model",
  api: "anthropic-messages",
  provider: "test-provider",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

const MODEL_IDENTITY: ModelIdentity = {
  providerId: MODEL.provider,
  modelId: MODEL.id,
};

const REQUEST: TurnRequest = {
  turnId: "turn-1",
  role: {
    id: "proposer",
    version: "1",
    systemPrompt: "You are the architect.",
  },
  prompt: "Propose a design.",
  controls: {
    model: MODEL_IDENTITY,
    thinkingLevel: "high",
    temperature: 0.7,
    maxOutputTokens: 512,
  },
  capabilities: { toolNames: [] },
};

interface StreamCall {
  context: Context;
  options: SimpleStreamOptions | undefined;
}

interface ScriptedStreamOptions {
  replies: string[];
  statuses?: number[];
}

function assistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    responseModel: MODEL.id,
    usage: {
      input: 20,
      output: 0,
      cacheRead: 0,
      cacheWrite: 3,
      reasoning: 0,
      totalTokens: 23,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function scriptedStream(options: ScriptedStreamOptions): { calls: StreamCall[]; stream: ModelStream } {
  const calls: StreamCall[] = [];
  let replyIndex = 0;

  return {
    calls,
    stream: (_model, context, streamOptions) => {
      calls.push({ context: structuredClone(context), options: streamOptions });
      const events = createAssistantMessageEventStream();
      const text = options.replies[replyIndex] ?? "unexpected";
      replyIndex += 1;
      const message = assistantMessage(text);

      queueMicrotask(() => {
        void (async () => {
          for (const status of options.statuses ?? [200]) {
            await streamOptions?.onResponse?.({ status, headers: {} }, MODEL);
          }
          events.push({ type: "start", partial: { ...message, content: [] } });
          events.push({ type: "text_start", contentIndex: 0, partial: message });
          events.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          events.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
          events.push({ type: "done", reason: "stop", message });
          events.end();
        })();
      });
      return events;
    },
  };
}

function clock(...values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? values.at(-1) ?? 0;
}

function expectedReply(): AgentReply {
  return {
    text: "Use ports and adapters.",
    durationMs: 125,
    model: MODEL_IDENTITY,
    controls: {
      model: {
        requested: MODEL_IDENTITY,
        forwarded: MODEL_IDENTITY,
        providerVerified: MODEL_IDENTITY,
      },
      thinkingLevel: { requested: "high", forwarded: "high" },
      temperature: { requested: 0.7, forwarded: 0.7 },
      maxOutputTokens: { requested: 512, forwarded: 512 },
    },
    usage: {
      inputTokens: 20,
      outputTokens: 0,
      cacheWriteTokens: 3,
    },
    trace: {
      attempts: [
        {
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: {
            inputTokens: 20,
            outputTokens: 0,
            cacheWriteTokens: 3,
          },
          usageEvidence: {
            explicitlyReported: ["outputTokens"],
            source: "test-provider-policy",
          },
        },
      ],
    },
  };
}

describe("PiAgent", () => {
  test("matches ScriptedAgent's domain contract without a provider call", async () => {
    const fake = scriptedStream({ replies: ["Use ports and adapters."] });
    const expected = expectedReply();
    const scripted = new ScriptedAgent([
      {
        ...expected,
        usage: {
          values: {
            inputTokens: 20,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 3,
            reasoningTokens: 0,
          },
          explicitlyReported: ["outputTokens"],
        },
      },
    ]);
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: {
        explicitlyReported: ["outputTokens"],
        source: "test-provider-policy",
      },
      now: clock(1_000, 1_125),
    });

    const [scriptedReply, piReply] = await Promise.all([
      scripted.reply(REQUEST),
      agent.reply(REQUEST),
    ]);

    expect(piReply).toEqual(expected);
    expect(piReply).toEqual(scriptedReply);
    expect(fake.calls[0]?.context.systemPrompt).toBe(REQUEST.role.systemPrompt);
    expect(fake.calls[0]?.context.tools).toEqual([]);
    expect(fake.calls[0]?.options).toMatchObject({
      reasoning: "high",
      temperature: 0.7,
      maxTokens: 512,
    });

    await Promise.all([scripted.dispose(), agent.dispose()]);
  });

  test("accounts for failed HTTP attempts before the successful attempt", async () => {
    const fake = scriptedStream({ replies: ["Answer"], statuses: [429, 200] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "no-zero-evidence" },
      now: clock(0, 10),
    });

    const reply = await agent.reply(REQUEST);

    expect(reply.trace.attempts).toEqual([
      {
        attempt: 1,
        status: "failed",
        httpStatus: 429,
        usage: {},
        usageEvidence: { explicitlyReported: [], source: "no-zero-evidence" },
      },
      {
        attempt: 2,
        status: "succeeded",
        httpStatus: 200,
        usage: { inputTokens: 20, cacheWriteTokens: 3 },
        usageEvidence: { explicitlyReported: [], source: "no-zero-evidence" },
      },
    ]);

    await agent.dispose();
  });

  test("reports adjusted and unsupported controls without forwarding them", async () => {
    const fake = scriptedStream({ replies: ["Answer"] });
    const limitedModel: Model<"anthropic-messages"> = {
      ...MODEL,
      reasoning: false,
      maxTokens: 128,
      compat: { supportsTemperature: false },
    };
    const agent = new PiAgent({
      model: limitedModel,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1),
    });

    const reply = await agent.reply(REQUEST);

    expect(reply.controls.thinkingLevel).toEqual({
      requested: "high",
      unsupported: { reason: "model does not support reasoning" },
    });
    expect(reply.controls.temperature).toEqual({
      requested: 0.7,
      unsupported: { reason: "model metadata disables temperature" },
    });
    expect(reply.controls.maxOutputTokens).toEqual({
      requested: 512,
      adjusted: { value: 128, reason: "clamped to model maximum 128" },
      forwarded: 128,
    });
    expect(fake.calls[0]?.options?.reasoning).toBeUndefined();
    expect(fake.calls[0]?.options?.temperature).toBeUndefined();
    expect(fake.calls[0]?.options?.maxTokens).toBe(128);

    await agent.dispose();
  });

  test("retains conversation and synthesizes disposal around low-level Agent", async () => {
    const fake = scriptedStream({ replies: ["First", "Second"] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1, 2, 3),
    });

    await agent.reply(REQUEST);
    await agent.reply({ ...REQUEST, turnId: "turn-2", prompt: "Continue" });

    expect(fake.calls[1]?.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);

    await agent.dispose();
    expect(agent.disposed).toBe(true);
    expect(agent.messageCount).toBe(0);
  });

  test("disposal aborts an active low-level Agent turn", async () => {
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const stream: ModelStream = (_model, _context, options) => {
      const events = createAssistantMessageEventStream();
      const message = assistantMessage("");
      markStarted?.();
      options?.signal?.addEventListener("abort", () => {
        const aborted = { ...message, stopReason: "aborted" as const, errorMessage: "aborted" };
        events.push({ type: "error", reason: "aborted", error: aborted });
        events.end();
      }, { once: true });
      return events;
    };
    const agent = new PiAgent({
      model: MODEL,
      modelStream: stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1),
    });

    const pendingReply = agent.reply(REQUEST);
    await started;
    const pendingDisposal = agent.dispose();
    const reply = await pendingReply;
    await pendingDisposal;

    expect(reply.trace.attempts[0]?.status).toBe("aborted");
    expect(agent.disposed).toBe(true);
    expect(agent.messageCount).toBe(0);
  });

  test("composes with offline ModelRuntime authentication", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });

    expect(streamFromModelRuntime(runtime)).toBeFunction();
  });
});
