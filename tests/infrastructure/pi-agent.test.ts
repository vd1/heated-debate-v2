import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type SimpleStreamOptions,
  Type,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  AgentFailure,
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
import { createDenyAllToolPolicy } from "../../src/domain/tool-policy";

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

const CODEX_MODEL: Model<"openai-codex-responses"> = {
  ...MODEL,
  id: "codex-test-model",
  api: "openai-codex-responses",
  provider: "openai-codex",
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
      content: "[Creativity: 3/5] Mix new ideas with refinement. Address open questions. Weigh tradeoffs.\n\nPropose a design.",
    }],
  },
  controls: {
    model: MODEL_IDENTITY,
    thinkingLevel: "high",
    temperature: 0.7,
    maxOutputTokens: 512,
  },
  capabilities: createDenyAllToolPolicy({
    role: { id: "proposer", version: "1" },
    phase: "proposal",
  }),
};

const WEB_SEARCH_TOOL: AgentTool = {
  name: "web-search",
  label: "Web search",
  description: "Search a test index.",
  parameters: Type.Object({}),
  execute: () => Promise.resolve({ content: [{ type: "text", text: "result" }], details: {} }),
};

interface StreamCall {
  context: Context;
  options: SimpleStreamOptions | undefined;
}

interface ScriptedStreamOptions {
  replies: string[];
  statuses?: number[];
  model?: Model<Api>;
}

function assistantMessage(text: string, model: Model<Api> = MODEL): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    responseModel: model.id,
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

function scriptedStream(options: ScriptedStreamOptions): {
  calls: StreamCall[];
  emittedPayloads: unknown[];
  stream: ModelStream;
} {
  const calls: StreamCall[] = [];
  const emittedPayloads: unknown[] = [];
  let replyIndex = 0;

  return {
    calls,
    emittedPayloads,
    stream: (requestModel, context, streamOptions) => {
      const { tools, ...serializableContext } = context;
      calls.push({
        context: {
          ...structuredClone(serializableContext),
          ...(tools === undefined ? {} : { tools: [...tools] }),
        },
        options: streamOptions,
      });
      const events = createAssistantMessageEventStream();
      const text = options.replies[replyIndex] ?? "unexpected";
      replyIndex += 1;
      const selectedModel = options.model ?? requestModel;
      const message = assistantMessage(text, selectedModel);

      queueMicrotask(() => {
        void (async () => {
          const basePayload = { model: selectedModel.id, stream: true };
          const replacedPayload = await streamOptions?.onPayload?.(basePayload, selectedModel);
          emittedPayloads.push(replacedPayload ?? basePayload);
          for (const status of options.statuses ?? [200]) {
            await streamOptions?.onResponse?.({ status, headers: {} }, selectedModel);
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

function messageText(message: Message): string {
  if (message.role === "toolResult") return "";
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("");
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
    toolCalls: [],
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

  test("blocks registered policy tools until the project dispatcher owns execution", async () => {
    const fake = scriptedStream({ replies: ["Used the declared capability."] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      tools: [{ toolId: "web-search", schemaVersion: "1", tool: WEB_SEARCH_TOOL }],
    });
    const request: TurnRequest = {
      ...REQUEST,
      capabilities: {
        policyId: "research",
        policyVersion: "1",
        evidence: "recorded",
        role: { id: "proposer", version: "1" },
        phase: "proposal",
        allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 1 }],
        aggregateCallLimit: 1,
        callTimeoutMs: 1_000,
        maxResultBytes: 4_096,
        deniedCallCharge: "none",
      },
    };

    expect((await rejectionError(agent.reply(request))).message).toBe(
      "tool-enabled policies require the project dispatcher",
    );
    expect(fake.calls).toHaveLength(0);
    await agent.dispose();
  });

  test("rejects a policy tool that is unavailable at the requested schema version", async () => {
    const fake = scriptedStream({ replies: ["unused"] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      tools: [{ toolId: "web-search", schemaVersion: "2", tool: WEB_SEARCH_TOOL }],
    });
    const request: TurnRequest = {
      ...REQUEST,
      capabilities: {
        policyId: "research",
        policyVersion: "1",
        evidence: "recorded",
        role: { id: "proposer", version: "1" },
        phase: "proposal",
        allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 1 }],
        aggregateCallLimit: 1,
        callTimeoutMs: 1_000,
        maxResultBytes: 4_096,
        deniedCallCharge: "none",
      },
    };

    expect((await rejectionError(agent.reply(request))).message).toBe(
      "tool is unavailable in environment: web-search@1",
    );
    expect(fake.calls).toHaveLength(0);
    await agent.dispose();
  });

  test("rejects a recorded policy bound to a different request role", async () => {
    const fake = scriptedStream({ replies: ["unused"] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
    });
    if (REQUEST.capabilities.evidence !== "recorded") throw new Error("bad fixture");
    const request: TurnRequest = {
      ...REQUEST,
      capabilities: {
        ...REQUEST.capabilities,
        role: { id: "reviewer", version: "1" },
      },
    };

    expect((await rejectionError(agent.reply(request))).message).toBe(
      "tool policy role must match proposer@1",
    );
    expect(fake.calls).toHaveLength(0);
    await agent.dispose();
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

  test("does not invent an HTTP status when Pi exposes no response hook", async () => {
    const fake = scriptedStream({ replies: ["Answer"], statuses: [] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1),
    });

    const reply = await agent.reply(REQUEST);

    expect(reply.trace.attempts).toEqual([{
      attempt: 1,
      status: "succeeded",
      usage: { inputTokens: 20, cacheWriteTokens: 3 },
      usageEvidence: { explicitlyReported: [], source: "test" },
    }]);
    await agent.dispose();
  });

  test("reports the omitted Codex provider cap truthfully at payload level", async () => {
    const fake = scriptedStream({ replies: ["Bounded answer"], model: CODEX_MODEL });
    const agent = new PiAgent({
      model: CODEX_MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1),
    });
    const request: TurnRequest = {
      ...REQUEST,
      controls: {
        ...REQUEST.controls,
        model: { providerId: CODEX_MODEL.provider, modelId: CODEX_MODEL.id },
      },
    };

    const reply = await agent.reply(request);

    expect(fake.emittedPayloads).toEqual([{
      model: CODEX_MODEL.id,
      stream: true,
    }]);
    expect(reply.controls.maxOutputTokens).toEqual({
      requested: 512,
      unsupported: {
        reason: "Codex route does not support a provider-enforced output token cap",
      },
    });
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

  test("synchronizes Pi state to the exact selected messages and synthesizes disposal", async () => {
    const fake = scriptedStream({ replies: ["First", "Second"] });
    const agent = new PiAgent({
      model: MODEL,
      modelStream: fake.stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1, 2, 3),
    });

    await agent.reply(REQUEST);
    await agent.reply({
      ...REQUEST,
      turnId: "turn-2",
      context: {
        policyId: "last-exchange",
        policyVersion: "1",
        messages: [
          { role: "user", content: "Selected prior question" },
          { role: "assistant", content: "Selected prior answer" },
          {
            role: "user",
            content: "[Creativity: 3/5] Mix new ideas with refinement. Address open questions. Weigh tradeoffs.\n\nContinue from only this context",
          },
        ],
      },
    });

    expect(fake.calls[1]?.context.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
    ]);
    expect(fake.calls[1]?.context.messages.map(messageText)).toEqual([
      "Selected prior question",
      "Selected prior answer",
      "[Creativity: 3/5] Mix new ideas with refinement. Address open questions. Weigh tradeoffs.\n\nContinue from only this context",
    ]);

    await agent.dispose();
    expect(agent.disposed).toBe(true);
    expect(agent.messageCount).toBe(0);
  });

  test("normalizes provider errors with partial response attempts", async () => {
    const stream: ModelStream = (_model, _context, options) => {
      const events = createAssistantMessageEventStream();
      const message = {
        ...assistantMessage(""),
        stopReason: "error" as const,
        errorMessage: "provider failed",
      };
      queueMicrotask(() => {
        void (async () => {
          await options?.onResponse?.({ status: 503, headers: {} }, MODEL);
          events.push({ type: "error", reason: "error", error: message });
          events.end();
        })();
      });
      return events;
    };
    const agent = new PiAgent({
      model: MODEL,
      modelStream: stream,
      usageEvidence: { explicitlyReported: [], source: "test" },
      now: clock(0, 1),
    });

    const error = await rejectionError(agent.reply(REQUEST));

    expect(error).toBeInstanceOf(AgentFailure);
    expect((error as AgentFailure).code).toBe("provider_failure");
    expect((error as AgentFailure).trace.attempts).toEqual([{
      attempt: 1,
      status: "failed",
      httpStatus: 503,
      usage: { inputTokens: 20, cacheWriteTokens: 3 },
      usageEvidence: { explicitlyReported: [], source: "test" },
    }]);
    await agent.dispose();
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
    const error = await rejectionError(pendingReply);
    await pendingDisposal;

    expect(error).toBeInstanceOf(AgentFailure);
    expect((error as AgentFailure).code).toBe("cancelled");
    expect((error as AgentFailure).trace.attempts[0]?.status).toBe("aborted");
    expect(agent.disposed).toBe(true);
    expect(agent.messageCount).toBe(0);
  });

  test("AbortSignal cancels an active reply without serving as cleanup", async () => {
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
    const controller = new AbortController();

    const pending = agent.reply(REQUEST, { signal: controller.signal });
    await started;
    controller.abort();
    const signalError = await rejectionError(pending);

    expect(signalError).toBeInstanceOf(AgentFailure);
    expect((signalError as AgentFailure).code).toBe("cancelled");
    expect(agent.disposed).toBe(false);
    await agent.dispose();
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

async function rejectionError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("expected promise to reject");
}
