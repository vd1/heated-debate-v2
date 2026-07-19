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
  PiAgentProbe,
  streamFromModelRuntime,
  type ModelStream,
  type ProbeControls,
} from "../spikes/pi-agent-probe";

const MODEL: Model<"anthropic-messages"> = {
  id: "probe-model",
  name: "Probe Model",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 8_192,
  maxTokens: 1_024,
};

interface StreamCall {
  context: Context;
  options: SimpleStreamOptions | undefined;
}

function assistantMessage(text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 11,
      output: 3,
      cacheRead: 5,
      cacheWrite: 0,
      reasoning: 1,
      totalTokens: 19,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function scriptedStream(replies: string[]): { calls: StreamCall[]; stream: ModelStream } {
  const calls: StreamCall[] = [];
  let replyIndex = 0;

  return {
    calls,
    stream: (_model, context, options) => {
      calls.push({ context: structuredClone(context), options });
      const stream = createAssistantMessageEventStream();
      const message = assistantMessage(replies[replyIndex] ?? "unexpected");
      replyIndex += 1;

      queueMicrotask(() => {
        stream.push({ type: "start", partial: { ...message, content: [] } });
        stream.push({ type: "text_start", contentIndex: 0, partial: { ...message, content: [] } });
        stream.push({
          type: "text_delta",
          contentIndex: 0,
          delta: message.content[0]?.type === "text" ? message.content[0].text : "",
          partial: message,
        });
        stream.push({ type: "text_end", contentIndex: 0, content: replies[replyIndex - 1] ?? "", partial: message });
        stream.push({ type: "done", reason: "stop", message });
        stream.end();
      });
      return stream;
    },
  };
}

const CONTROLS: ProbeControls = {
  thinkingLevel: "high",
  temperature: 0.7,
  maxTokens: 512,
};

describe("Pi low-level Agent capability probe", () => {
  test("composes with an offline ModelRuntime for production authentication", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });

    expect(streamFromModelRuntime(runtime)).toBeFunction();
  });

  test("retains conversation while exposing text, usage, prompt, tools, and controls", async () => {
    const fake = scriptedStream(["proposal", "revision"]);
    const probe = new PiAgentProbe({
      model: MODEL,
      modelStream: fake.stream,
      systemPrompt: "You are the architect.",
      tools: [],
      controls: CONTROLS,
    });

    const first = await probe.prompt("Start");
    const second = await probe.prompt("Continue");

    expect(first.text).toBe("proposal");
    expect(first.usage).toEqual({ input: 11, output: 3, cacheRead: 5, cacheWrite: 0, reasoning: 1 });
    expect(probe.textDeltas).toEqual(["proposal", "revision"]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[0]?.context.systemPrompt).toBe("You are the architect.");
    expect(fake.calls[0]?.context.tools).toEqual([]);
    expect(fake.calls[1]?.context.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"]);
    expect(fake.calls[0]?.options).toMatchObject({ reasoning: "high", temperature: 0.7, maxTokens: 512 });
    expect(second.controls.forwarded).toEqual(CONTROLS);

    await probe.dispose();
    expect(probe.disposed).toBe(true);
    expect(probe.messageCount).toBe(0);
  });

  test("reports known unsupported or adjusted controls instead of silently forwarding them", async () => {
    const fake = scriptedStream(["answer"]);
    const limitedModel: Model<"anthropic-messages"> = {
      ...MODEL,
      reasoning: false,
      maxTokens: 128,
      compat: { supportsTemperature: false },
    };
    const probe = new PiAgentProbe({
      model: limitedModel,
      modelStream: fake.stream,
      systemPrompt: "Role",
      tools: [],
      controls: { thinkingLevel: "high", temperature: 0.9, maxTokens: 512 },
    });

    const result = await probe.prompt("Test controls");

    expect(result.controls.forwarded).toEqual({ thinkingLevel: "off", maxTokens: 128 });
    expect(result.controls.issues).toEqual([
      { control: "thinkingLevel", kind: "unsupported", reason: "model does not support reasoning" },
      { control: "temperature", kind: "unsupported", reason: "model metadata disables temperature" },
      { control: "maxTokens", kind: "adjusted", reason: "clamped to model maximum 128" },
    ]);
    expect(fake.calls[0]?.options).toMatchObject({ maxTokens: 128 });
    expect(fake.calls[0]?.options?.temperature).toBeUndefined();
    expect(fake.calls[0]?.options?.reasoning).toBeUndefined();

    await probe.dispose();
  });

  test("defines cancellation and disposal without a provider call", async () => {
    let started: (() => void) | undefined;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream: ModelStream = (_model, _context, options) => {
      const events = createAssistantMessageEventStream();
      const message = assistantMessage("");
      started?.();
      options?.signal?.addEventListener("abort", () => {
        const aborted = { ...message, stopReason: "aborted" as const, errorMessage: "aborted" };
        events.push({ type: "error", reason: "aborted", error: aborted });
        events.end();
      }, { once: true });
      return events;
    };
    const probe = new PiAgentProbe({
      model: MODEL,
      modelStream: stream,
      systemPrompt: "Role",
      tools: [],
      controls: CONTROLS,
    });

    const pending = probe.prompt("Wait");
    await didStart;
    probe.abort();
    const result = await pending;

    expect(result.stopReason).toBe("aborted");
    await probe.dispose();

    let disposalError: unknown;
    try {
      await probe.prompt("Too late");
    } catch (error) {
      disposalError = error;
    }
    expect(disposalError).toBeInstanceOf(Error);
    expect((disposalError as Error).message).toBe("probe is disposed");
  });
});
