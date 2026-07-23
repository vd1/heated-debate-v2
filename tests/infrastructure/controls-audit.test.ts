import { describe, expect, test } from "bun:test";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

import {
  MATRIX_ELIGIBLE_CONTROL_DIMENSIONS,
} from "../../src/domain/control-dimensions";
import { runDebate, type DebateEventSink } from "../../src/domain/debate";
import type { CanonicalEvent } from "../../src/domain/events";
import {
  experimentDebateInput,
  parseExperimentConfig,
} from "../../src/domain/experiment-config";
import { PiAgent, type ModelStream } from "../../src/infrastructure/pi-agent";

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

function textStream(calls: StreamCall[]): ModelStream {
  return (requestModel, context, streamOptions) => {
    const { tools, ...rest } = context;
    calls.push({
      context: { ...structuredClone(rest), ...(tools === undefined ? {} : { tools: [...tools] }) },
      options: streamOptions,
    });
    const events = createAssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "Reply text." }],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      responseModel: requestModel.id,
      usage: {
        input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    queueMicrotask(() => {
      void (async () => {
        await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
        events.push({ type: "start", partial: { ...message, content: [] } });
        events.push({ type: "done", reason: "stop", message });
        events.end();
      })();
    });
    return events;
  };
}

class MemorySink implements DebateEventSink {
  readonly events: CanonicalEvent[] = [];
  append(event: CanonicalEvent): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
  flush(): Promise<void> {
    return Promise.resolve();
  }
}

async function auditRun(configJson: Record<string, unknown>): Promise<{
  events: CanonicalEvent[];
  calls: StreamCall[];
}> {
  const config = parseExperimentConfig(structuredClone(configJson));
  const calls: StreamCall[] = [];
  const agent = (): PiAgent => new PiAgent({
    model: MODEL,
    modelStream: textStream(calls),
    usageEvidence: { explicitlyReported: [], source: "audit" },
    tools: [{ toolId: "web-search", schemaVersion: "1", tool: WEB_SEARCH_TOOL }],
    now: () => 0,
  });
  const sink = new MemorySink();
  const proposer = agent();
  const reviewer = agent();
  try {
    await runDebate({
      ...experimentDebateInput(config, { proposer, reviewer }),
      recording: { runId: "audit-run", sink },
    });
  } finally {
    await proposer.dispose();
    await reviewer.dispose();
  }
  return { events: sink.events, calls };
}

const BASE = {
  configVersion: "1",
  runId: "audit-run",
  topic: "Audit controls.",
  roundCount: 1,
  controls: { model: { providerId: "test-provider", modelId: "test-model" } },
};

function firstRequested(events: CanonicalEvent[]) {
  const event = events.find((item) => item.type === "turn.requested");
  if (event?.type !== "turn.requested") throw new Error("missing turn.requested");
  return event.data.request;
}

function firstCompleted(events: CanonicalEvent[]) {
  const event = events.find((item) => item.type === "turn.completed");
  if (event?.type !== "turn.completed") throw new Error("missing turn.completed");
  return event.data.reply;
}

describe("D-CONTROLS end-to-end propagation audit", () => {
  test("thinking level travels config to request, adapter option, report, and events", async () => {
    const { events, calls } = await auditRun({ ...BASE, controls: { ...BASE.controls, thinkingLevel: "low" } });

    expect(firstRequested(events).controls.thinkingLevel).toBe("low");
    expect(calls[0]?.options?.reasoning).toBe("low");
    expect(firstCompleted(events).controls.thinkingLevel).toEqual({
      requested: "low",
      forwarded: "low",
    });
  });

  test("output limit travels config to request, adapter option, report, and events", async () => {
    const { events, calls } = await auditRun({
      ...BASE,
      controls: { ...BASE.controls, maxOutputTokens: 256 },
    });

    expect(firstRequested(events).controls.maxOutputTokens).toBe(256);
    expect(calls[0]?.options?.maxTokens).toBe(256);
    expect(firstCompleted(events).controls.maxOutputTokens).toEqual({
      requested: 256,
      forwarded: 256,
    });
  });

  test("temperature travels independently of the creativity instruction", async () => {
    const cool = await auditRun({ ...BASE, controls: { ...BASE.controls, temperature: 0.2 } });
    const warm = await auditRun({ ...BASE, controls: { ...BASE.controls, temperature: 1.2 } });

    expect(cool.calls[0]?.options?.temperature).toBe(0.2);
    expect(warm.calls[0]?.options?.temperature).toBe(1.2);
    expect(firstCompleted(warm.events).controls.temperature).toEqual({
      requested: 1.2,
      forwarded: 1.2,
    });
    // Varying temperature must not change the prompt dial.
    expect(firstRequested(cool.events).creativity).toEqual(firstRequested(warm.events).creativity);
  });

  test("creativity materializes as an exact prompt instruction without provider verification", async () => {
    const selection = { scheduleId: "linear-cooling" as const, scheduleVersion: "1" as const };
    const parsed = parseExperimentConfig({ ...BASE, creativitySchedule: selection });
    const { events, calls } = await auditRun({ ...BASE, creativitySchedule: selection });

    const request = firstRequested(events);
    // The parsed selection that entered the run is the identity in the request.
    expect(request.creativity.scheduleId).toBe(parsed.creativitySchedule.scheduleId);
    expect(request.creativity.scheduleVersion).toBe(parsed.creativitySchedule.scheduleVersion);
    expect(request.creativity.level).toBe(5);
    const message = request.context.messages[0];
    if (!message) throw new Error("missing model input");
    expect(message.content).toContain(`[Creativity: 5/5] ${request.creativity.instruction}`);
    const forwarded = calls[0]?.context.messages[0];
    if (!forwarded || forwarded.role !== "user" || typeof forwarded.content !== "string") {
      throw new Error("missing forwarded prompt");
    }
    expect(forwarded.content).toContain(request.creativity.instruction);
    // The prompt dial is not a provider control; the report never mentions it.
    expect(Object.keys(firstCompleted(events).controls).sort()).toEqual([
      "model",
      "thinkingLevel",
    ]);
  });

  test("tool allowlists are recorded exactly and enforced by the dispatcher, never provider-verified", async () => {
    const capabilities = {
      policyId: "audit-tools",
      policyVersion: "1",
      evidence: "recorded" as const,
      role: { id: "proposer", version: "1" },
      phase: "proposal" as const,
      allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 1 }],
      aggregateCallLimit: 1,
      callTimeoutMs: 1_000,
      maxResultBytes: 4_096,
      deniedCallCharge: "none" as const,
    };
    const { events, calls } = await auditRun({
      ...BASE,
      proposer: { capabilities },
    });

    expect(firstRequested(events).capabilities).toEqual(capabilities);
    // Definitions are forwarded for the model; execution stays project-owned.
    expect(calls[0]?.context.tools?.map((tool) => tool.name)).toEqual(["web-search"]);
    const report = firstCompleted(events).controls;
    expect(JSON.stringify(report)).not.toContain("web-search");
  });

  test("tool policy enforcement executes allowed calls and denies undeclared ones", async () => {
    let executed = 0;
    const searchTool: AgentTool = {
      ...WEB_SEARCH_TOOL,
      execute: () => {
        executed += 1;
        return Promise.resolve({ content: [{ type: "text", text: "result" }], details: {} });
      },
    };
    const messages = [
      {
        stopReason: "toolUse" as const,
        content: [
          { type: "toolCall" as const, id: "c1", name: "web-search", arguments: { } },
          { type: "toolCall" as const, id: "c2", name: "filesystem", arguments: { path: "/etc" } },
        ],
      },
      { stopReason: "stop" as const, content: [{ type: "text" as const, text: "Done." }] },
    ];
    let index = 0;
    const stream: ModelStream = (requestModel, context, streamOptions) => {
      const events = createAssistantMessageEventStream();
      const scripted = messages[Math.min(index, messages.length - 1)];
      index += 1;
      if (!scripted) throw new Error("no scripted message");
      const message: AssistantMessage = {
        role: "assistant",
        content: structuredClone(scripted.content),
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
        responseModel: requestModel.id,
        usage: {
          input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, totalTokens: 12,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: scripted.stopReason,
        timestamp: 0,
      };
      queueMicrotask(() => {
        void (async () => {
          await streamOptions?.onResponse?.({ status: 200, headers: {} }, requestModel);
          events.push({ type: "start", partial: { ...message, content: [] } });
          events.push({ type: "done", reason: scripted.stopReason, message });
          events.end();
        })();
      });
      return events;
    };
    const config = parseExperimentConfig({
      ...BASE,
      proposer: {
        capabilities: {
          policyId: "audit-tools",
          policyVersion: "1",
          evidence: "recorded",
          role: { id: "proposer", version: "1" },
          phase: "proposal",
          allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 1 }],
          aggregateCallLimit: 2,
          callTimeoutMs: 1_000,
          maxResultBytes: 4_096,
          deniedCallCharge: "none",
        },
      },
    });
    const sink = new MemorySink();
    const agent = (own: ModelStream): PiAgent => new PiAgent({
      model: MODEL,
      modelStream: own,
      usageEvidence: { explicitlyReported: [], source: "audit" },
      tools: [{ toolId: "web-search", schemaVersion: "1", tool: searchTool }],
      now: () => 0,
    });
    const reviewerCalls: StreamCall[] = [];
    const proposer = agent(stream);
    const reviewer = agent(textStream(reviewerCalls));
    try {
      await runDebate({
        ...experimentDebateInput(config, { proposer, reviewer }),
        recording: { runId: "audit-run", sink },
      });
    } finally {
      await proposer.dispose();
      await reviewer.dispose();
    }

    expect(executed).toBe(1);
    const toolEvents = sink.events.filter((event) => event.type === "turn.tool_call");
    expect(toolEvents.map((event) => event.data.record.disposition)).toEqual([
      { status: "accepted" },
      { status: "denied", reason: "tool_not_allowed" },
    ]);
    const completed = firstCompleted(sink.events);
    expect(JSON.stringify(completed.controls)).not.toContain("web-search");
  });

  test("declares exactly the five audited dimensions matrix-eligible", () => {
    expect(MATRIX_ELIGIBLE_CONTROL_DIMENSIONS.map((dimension) => `${dimension.id}:${dimension.enforcement}`)).toEqual([
      "thinkingLevel:provider-taxonomy",
      "maxOutputTokens:provider-taxonomy",
      "temperature:provider-taxonomy",
      "creativitySchedule:prompt-instruction",
      "toolCapabilityPolicy:project-dispatcher",
    ]);
    expect(Object.isFrozen(MATRIX_ELIGIBLE_CONTROL_DIMENSIONS)).toBe(true);
  });
});
