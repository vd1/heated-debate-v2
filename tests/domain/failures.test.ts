import { describe, expect, test } from "bun:test";

import {
  AgentFailure,
  type AgentPort,
  type AgentReply,
  type AgentReplyOptions,
  type AgentTrace,
  type TurnRequest,
} from "../../src/domain/agent";
import { projectDebateEvents } from "../../src/domain/debate-events";
import {
  DebateRunFailure,
  runDebate,
  type DebateEventSink,
  type RunDebateInput,
} from "../../src/domain/debate";
import type { CanonicalEvent } from "../../src/domain/events";
import { definePricingSnapshot, pricingSnapshotHash } from "../../src/domain/pricing";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";

const CONTROLS = {
  model: { providerId: "test", modelId: "model" },
  thinkingLevel: "high" as const,
};

function reply(text: string, trace: AgentTrace = { attempts: [] }): AgentReply {
  return {
    text,
    durationMs: 1,
    model: CONTROLS.model,
    controls: {
      model: { requested: CONTROLS.model, forwarded: CONTROLS.model },
      thinkingLevel: { requested: "high", forwarded: "high" },
    },
    usage: {},
    trace,
    toolCalls: [],
  };
}

class ScenarioAgent implements AgentPort {
  disposed = false;
  calls = 0;

  constructor(
    private readonly scenario: (
      request: TurnRequest,
      options: AgentReplyOptions,
    ) => Promise<AgentReply>,
  ) {}

  reply(request: TurnRequest, options: AgentReplyOptions = {}): Promise<AgentReply> {
    this.calls += 1;
    return this.scenario(request, options);
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

class MemorySink implements DebateEventSink {
  readonly events: CanonicalEvent[] = [];
  flushes = 0;

  append(event: CanonicalEvent): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }

  flush(): Promise<void> {
    this.flushes += 1;
    return Promise.resolve();
  }
}

function debateInput(
  proposer: AgentPort,
  reviewer: AgentPort,
  sink: MemorySink,
  overrides: Partial<RunDebateInput> = {},
): RunDebateInput {
  return {
    debateId: "failure-run",
    topic: "Exercise failure semantics.",
    roundCount: 1,
    proposer: { agent: proposer, role: PROPOSER_ROLE, controls: CONTROLS },
    reviewer: { agent: reviewer, role: REVIEWER_ROLE, controls: CONTROLS },
    recording: { runId: "artifact-failure", sink },
    ...overrides,
  };
}

const FAILED_ATTEMPT: AgentTrace["attempts"][number] = {
  attempt: 1,
  status: "failed",
  httpStatus: 503,
  usage: {},
  usageEvidence: { explicitlyReported: [], source: "provider response" },
};
const FAILED_TRACE: AgentTrace = { attempts: [FAILED_ATTEMPT] };

describe("runDebate failure semantics", () => {
  test.each([
    {
      name: "provider failure",
      expectedCode: "provider_failure",
      configure: () => new ScenarioAgent(() => Promise.reject(new AgentFailure({
        code: "provider_failure",
        message: "provider unavailable",
        trace: FAILED_TRACE,
      }))),
      overrides: {},
    },
    {
      name: "whitespace-only output",
      expectedCode: "empty_output",
      configure: () => new ScenarioAgent(() => Promise.resolve(reply(" \n\t", FAILED_TRACE))),
      overrides: {},
    },
    {
      name: "turn timeout",
      expectedCode: "timeout",
      configure: () => new ScenarioAgent((_request, options) => waitForAbort(options.signal)),
      overrides: { turnTimeoutMs: 5 },
    },
  ])("normalizes $name, records one terminal outcome, and disposes both agents", async ({
    expectedCode,
    configure,
    overrides,
  }) => {
    const proposer = configure();
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, overrides));

    expect(error.code).toBe(expectedCode);
    expect(proposer.disposed).toBe(true);
    expect(reviewer.disposed).toBe(true);
    expect(sink.events.filter((event) => event.type === "run.failed")).toHaveLength(1);
    expect(sink.events.filter((event) => event.type === "run.completed")).toHaveLength(0);
    expect(sink.events.at(-1)?.type).toBe("run.failed");
    expect(sink.events.some((event) => event.type === "turn.failed")).toBe(true);
    expect(sink.events.filter((event) => event.type === "adapter.attempt")).toHaveLength(1);
  });

  test("timeout remains hard even when an AgentPort ignores cancellation", async () => {
    const proposer = new ScenarioAgent(() => new Promise(() => {}));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, { turnTimeoutMs: 5 }));

    expect(error.code).toBe("timeout");
    expect(proposer.disposed).toBe(true);
    expect(sink.events.at(-1)?.type).toBe("run.failed");
  });

  test("cancels through AbortSignal rather than disposal", async () => {
    const controller = new AbortController();
    const proposer = new ScenarioAgent((_request, options) => {
      queueMicrotask(() => {
        controller.abort();
      });
      return waitForAbort(options.signal);
    });
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      signal: controller.signal,
    }));

    expect(error.code).toBe("cancelled");
    expect(proposer.disposed).toBe(true);
  });

  test("checks the turn budget before dispatch", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal")));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 1, maxTokens: 1_000 },
    }));

    expect(error.code).toBe("turn_budget_exhausted");
    expect(proposer.calls).toBe(1);
    expect(reviewer.calls).toBe(0);
    expect(sink.events.filter((event) => event.type === "turn.requested")).toHaveLength(1);
  });

  test("records versioned timeout and budget controls with explicit absence", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal")));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review")));
    const sink = new MemorySink();

    await runDebate(debateInput(proposer, reviewer, sink, {
      turnTimeoutMs: 25,
      budget: { maxTurns: 2, maxTokens: 100 },
    }));

    const started = sink.events[0];
    if (started?.type !== "run.started") throw new Error("missing run start");
    expect(started.data.controls).toEqual({
      policyId: "run-controls",
      policyVersion: "1",
      evidence: "recorded",
      turnTimeoutMs: 25,
      wholeRunTimeoutMs: null,
      budget: { maxTurns: 2, maxTokens: 100 },
      monetary: null,
    });

    const absentSink = new MemorySink();
    await runDebate(debateInput(
      new ScenarioAgent(() => Promise.resolve(reply("Proposal"))),
      new ScenarioAgent(() => Promise.resolve(reply("Review"))),
      absentSink,
    ));
    const absentStart = absentSink.events[0];
    if (absentStart?.type !== "run.started") throw new Error("missing run start");
    expect(absentStart.data.controls).toEqual({
      policyId: "run-controls",
      policyVersion: "1",
      evidence: "recorded",
      turnTimeoutMs: null,
      wholeRunTimeoutMs: null,
      budget: null,
      monetary: null,
    });
  });




  const PRICING = definePricingSnapshot({
    snapshotId: "pricing-test",
    snapshotVersion: "1",
    currency: "USD",
    effectiveDate: "2026-07-01",
    provenance: "test fixture",
    entries: [{
      model: { providerId: "test", modelId: "model" },
      inputRatePerMillionTokens: 1,
      outputRatePerMillionTokens: 10,
      cacheReadRatePerMillionTokens: 0,
      cacheWriteRatePerMillionTokens: 0,
      reasoningBilling: { mode: "included-in-output" },
    }],
  });

  function pricedReply(text: string): AgentReply {
    return {
      ...reply(text),
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          // 0.5 input + 2.0 output per attempt in USD.
          usage: { inputTokens: 500_000, outputTokens: 200_000 },
          usageEvidence: { explicitlyReported: [], source: "test" },
        }],
      },
    };
  }


  test("completes exactly at the monetary limit and ignores later caller mutation", async () => {
    // Two turns cost 0.1 + 0.2; a float sum would exceed a 0.3 budget spuriously.
    const tenth: AgentReply = {
      ...reply("Proposal"),
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: { inputTokens: 100_000, outputTokens: 0 },
          usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
        }],
      },
    };
    const fifth: AgentReply = {
      ...reply("Review"),
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: { inputTokens: 200_000, outputTokens: 0 },
          usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
        }],
      },
    };
    const exactPricing = definePricingSnapshot({
      snapshotId: "pricing-exact",
      snapshotVersion: "1",
      currency: "USD",
      effectiveDate: "2026-07-01",
      provenance: "test fixture",
      entries: [{
        model: { providerId: "test", modelId: "model" },
        inputRatePerMillionTokens: 1,
        outputRatePerMillionTokens: 0,
        cacheReadRatePerMillionTokens: 0,
        cacheWriteRatePerMillionTokens: 0,
        reasoningBilling: { mode: "included-in-output" },
      }],
    });
    const budget = {
      maxTurns: 4,
      maxTokens: 10_000_000,
      monetary: { maxAmount: 0.3, snapshot: exactPricing },
    };
    const proposer = new ScenarioAgent(() => {
      // Caller-side mutation after the run starts must not change enforcement.
      budget.monetary.maxAmount = 999;
      return Promise.resolve(structuredClone(tenth));
    });
    const reviewer = new ScenarioAgent(() => Promise.resolve(structuredClone(fifth)));
    const sink = new MemorySink();

    const result = await runDebate(debateInput(proposer, reviewer, sink, { budget }));

    expect(result.rounds).toHaveLength(1);
    const started = sink.events[0];
    if (started?.type !== "run.started" || started.data.controls.evidence !== "recorded") {
      throw new Error("missing run start");
    }
    expect(started.data.controls.monetary?.maxAmount).toBe(0.3);
  });

  test("prices successful turns by the returned model identity", async () => {
    const routedPricing = definePricingSnapshot({
      snapshotId: "pricing-routed",
      snapshotVersion: "1",
      currency: "USD",
      effectiveDate: "2026-07-01",
      provenance: "test fixture",
      entries: [
        {
          model: { providerId: "test", modelId: "model" },
          inputRatePerMillionTokens: 1,
          outputRatePerMillionTokens: 0,
          cacheReadRatePerMillionTokens: 0,
          cacheWriteRatePerMillionTokens: 0,
          reasoningBilling: { mode: "included-in-output" },
        },
        {
          model: { providerId: "test", modelId: "model-routed" },
          inputRatePerMillionTokens: 100,
          outputRatePerMillionTokens: 0,
          cacheReadRatePerMillionTokens: 0,
          cacheWriteRatePerMillionTokens: 0,
          reasoningBilling: { mode: "included-in-output" },
        },
      ],
    });
    const routedReply: AgentReply = {
      ...reply("Proposal"),
      model: { providerId: "test", modelId: "model-routed" },
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: { inputTokens: 100_000, outputTokens: 0 },
          usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
        }],
      },
    };
    const proposer = new ScenarioAgent(() => Promise.resolve(structuredClone(routedReply)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: {
        maxTurns: 4,
        maxTokens: 10_000_000,
        // 100k tokens at the requested model cost 0.1; at the returned model 10.
        monetary: { maxAmount: 5, snapshot: routedPricing },
      },
    }));

    expect(error.code).toBe("monetary_budget_exhausted");
    expect(reviewer.calls).toBe(0);
  });

  test("records the monetary budget with its snapshot hash in run controls", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(pricedReply("Proposal")));
    const reviewer = new ScenarioAgent(() => Promise.resolve(pricedReply("Review")));
    const sink = new MemorySink();

    await runDebate(debateInput(proposer, reviewer, sink, {
      budget: {
        maxTurns: 4,
        maxTokens: 10_000_000,
        monetary: { maxAmount: 100, snapshot: PRICING },
      },
    }));

    const started = sink.events[0];
    if (started?.type !== "run.started") throw new Error("missing run start");
    if (started.data.controls.evidence !== "recorded") throw new Error("missing evidence");
    expect(started.data.controls.monetary).toEqual({
      maxAmount: 100,
      currency: "USD",
      snapshotId: "pricing-test",
      snapshotVersion: "1",
      snapshotHash: pricingSnapshotHash(PRICING),
      permitTokenOnlyAccounting: false,
    });

    const absentSink = new MemorySink();
    await runDebate(debateInput(
      new ScenarioAgent(() => Promise.resolve(reply("Proposal"))),
      new ScenarioAgent(() => Promise.resolve(reply("Review"))),
      absentSink,
    ));
    const absentStart = absentSink.events[0];
    if (absentStart?.type !== "run.started") throw new Error("missing run start");
    if (absentStart.data.controls.evidence !== "recorded") throw new Error("missing evidence");
    expect(absentStart.data.controls.monetary).toBeNull();
  });

  test("stops at the first observable monetary budget overage", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(pricedReply("Proposal")));
    const reviewer = new ScenarioAgent(() => Promise.resolve(pricedReply("Review")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: {
        maxTurns: 8,
        maxTokens: 10_000_000,
        // First turn costs 2.5 USD, so the reviewer dispatch must not happen.
        monetary: { maxAmount: 2, snapshot: PRICING },
      },
    }));

    expect(error.code).toBe("monetary_budget_exhausted");
    expect(proposer.calls).toBe(1);
    expect(reviewer.calls).toBe(0);
  });

  test("fails closed when observed usage cannot be priced", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal", FAILED_TRACE)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(pricedReply("Review")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: {
        maxTurns: 8,
        maxTokens: 10_000_000,
        monetary: { maxAmount: 100, snapshot: PRICING },
      },
    }));

    expect(error.code).toBe("cost_unknown");
    expect(reviewer.calls).toBe(0);
  });

  test("permits token-only accounting only when explicitly configured", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal", FAILED_TRACE)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(pricedReply("Review")));
    const sink = new MemorySink();

    const result = await runDebate(debateInput(proposer, reviewer, sink, {
      budget: {
        maxTurns: 8,
        maxTokens: 10_000_000,
        monetary: { maxAmount: 100, snapshot: PRICING, permitTokenOnlyAccounting: true },
      },
    }));

    expect(result.rounds).toHaveLength(1);
  });

  test("rejects a monetary budget whose snapshot lacks a participant model", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal")));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review")));
    const sink = new MemorySink();

    const error = await rejectionMessage(runDebate(debateInput(proposer, reviewer, sink, {
      reviewer: {
        agent: reviewer,
        role: REVIEWER_ROLE,
        controls: { model: { providerId: "test", modelId: "unpriced" }, thinkingLevel: "high" as const },
      },
      budget: {
        maxTurns: 8,
        maxTokens: 10_000_000,
        monetary: { maxAmount: 100, snapshot: PRICING },
      },
    })));

    expect(error).toBe("no pricing entry for test/unpriced");
  });

  test("emits sequenced attempts and tool calls in shared order while recording", async () => {
    const annotatedReply: AgentReply = {
      ...reply("Proposal"),
      trace: {
        attempts: [
          { ...FAILED_ATTEMPT, status: "succeeded", turnSequence: 1 },
          { ...FAILED_ATTEMPT, status: "succeeded", attempt: 2, turnSequence: 3 },
        ],
      },
      toolCalls: [{
        callId: "failure-run:round-1:proposer:call-1",
        ordinal: 1,
        toolId: "web-search",
        schemaVersion: "1",
        arguments: { query: "q" },
        disposition: { status: "accepted" },
        outcome: { status: "succeeded", output: "r", outputBytes: 1, truncation: null },
        durationMs: 5,
        turnSequence: 2,
      }],
    };
    const proposer = new ScenarioAgent(() => Promise.resolve(structuredClone(annotatedReply)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review")));
    const sink = new MemorySink();

    await runDebate(debateInput(proposer, reviewer, sink));

    expect(sink.events.slice(1, 6).map((event) => event.type)).toEqual([
      "turn.requested",
      "adapter.attempt",
      "turn.tool_call",
      "adapter.attempt",
      "turn.completed",
    ]);
  });

  test("emits completed tool calls before the turn failure that follows them", async () => {
    const completedCall = {
      callId: "failure-run:round-1:proposer:call-1",
      ordinal: 1,
      toolId: "web-search",
      schemaVersion: "1",
      arguments: { query: "queues" },
      disposition: { status: "accepted" as const },
      outcome: {
        status: "succeeded" as const,
        output: "results",
        outputBytes: 7,
        truncation: null,
      },
      durationMs: 12,
    };
    const proposer = new ScenarioAgent(() => Promise.reject(new AgentFailure({
      code: "provider_failure",
      message: "provider failed after tool completion",
      trace: FAILED_TRACE,
      toolCalls: [completedCall],
    })));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink));

    expect(error.code).toBe("provider_failure");
    expect(error.toolCalls).toEqual([completedCall]);
    const types = sink.events.map((event) => event.type);
    const toolCallIndex = types.indexOf("turn.tool_call");
    const failureIndex = types.indexOf("turn.failed");
    expect(toolCallIndex).toBeGreaterThan(-1);
    expect(failureIndex).toBeGreaterThan(toolCallIndex);
    const toolEvent = sink.events[toolCallIndex];
    if (toolEvent?.type !== "turn.tool_call") throw new Error("missing tool call event");
    expect(toolEvent.data.record).toEqual(completedCall);
    expect(toolEvent.data.turnId).toBe("failure-run:round-1:proposer");
  });

  test("snapshots and freezes run controls once for enforcement and post-hoc projection", async () => {
    const mutableBudget = { maxTurns: 2, maxTokens: 100 };
    const oneToken = usageTrace({ outputTokens: 1 });
    const proposer = new ScenarioAgent(() => {
      mutableBudget.maxTokens = 0;
      return Promise.resolve(reply("Proposal", oneToken));
    });
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review", oneToken)));
    const sink = new MemorySink();

    const result = await runDebate(debateInput(proposer, reviewer, sink, {
      turnTimeoutMs: 321,
      budget: mutableBudget,
    }));
    const projected = projectDebateEvents(result, "post-hoc-artifact");
    const start = projected[0];
    if (start?.type !== "run.started") throw new Error("missing projected run start");

    expect(proposer.calls).toBe(1);
    expect(reviewer.calls).toBe(1);
    expect(Object.isFrozen(result.controls)).toBe(true);
    expect(Object.isFrozen(result.controls.budget)).toBe(true);
    expect(Reflect.set(result.controls, "turnTimeoutMs", 999)).toBe(false);
    if (result.controls.budget === null) throw new Error("missing run budget snapshot");
    expect(Reflect.set(result.controls.budget, "maxTokens", 0)).toBe(false);
    expect(start.data.controls).toEqual({
      policyId: "run-controls",
      policyVersion: "1",
      evidence: "recorded",
      turnTimeoutMs: 321,
      wholeRunTimeoutMs: null,
      budget: { maxTurns: 2, maxTokens: 100 },
      monetary: null,
    });
  });

  test("zero token budget prevents the first dispatch", async () => {
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 2, maxTokens: 0 },
    }));

    expect(error.code).toBe("token_budget_exhausted");
    expect(proposer.calls).toBe(0);
    expect(reviewer.calls).toBe(0);
  });

  test("exact token exhaustion prevents a non-final dispatch", async () => {
    const exact = usageTrace({ inputTokens: 6, outputTokens: 4 });
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal", exact)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 2, maxTokens: 10 },
    }));

    expect(error.code).toBe("token_budget_exhausted");
    expect(proposer.calls).toBe(1);
    expect(reviewer.calls).toBe(0);
  });

  test("exact token use on the final turn completes", async () => {
    const five = usageTrace({ inputTokens: 3, outputTokens: 2 });
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal", five)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review", five)));
    const sink = new MemorySink();

    await runDebate(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 2, maxTokens: 10 },
    }));

    expect(proposer.calls).toBe(1);
    expect(reviewer.calls).toBe(1);
    expect(sink.events.at(-1)?.type).toBe("run.completed");
  });

  test("counts cache reads and writes toward token exhaustion", async () => {
    const cached = usageTrace({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
    });
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal", cached)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 2, maxTokens: 10 },
    }));

    expect(error.code).toBe("token_budget_exhausted");
    expect(error.observedUsage).toEqual({
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 100,
      cacheWriteTokens: 2,
    });
    expect(reviewer.calls).toBe(0);
  });

  test("sums retry usage once, excludes reasoning subsets, and stops after observable overage", async () => {
    const trace: AgentTrace = {
      attempts: [
        {
          attempt: 1,
          status: "failed",
          usage: {
            inputTokens: 4,
            outputTokens: 3,
            cacheReadTokens: 100,
            cacheWriteTokens: 100,
            reasoningTokens: 3,
          },
          usageEvidence: { explicitlyReported: [], source: "attempt 1" },
        },
        {
          attempt: 2,
          status: "succeeded",
          usage: {
            inputTokens: 3,
            outputTokens: 2,
            cacheReadTokens: 100,
            cacheWriteTokens: 100,
            reasoningTokens: 2,
          },
          usageEvidence: { explicitlyReported: [], source: "attempt 2" },
        },
      ],
    };
    const proposer = new ScenarioAgent(() => Promise.resolve({
      ...reply("Proposal", trace),
      // This summary duplicates attempt usage and must not be counted again.
      usage: { inputTokens: 7, outputTokens: 5 },
    }));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    const error = await debateError(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 2, maxTokens: 411 },
    }));

    expect(error.code).toBe("token_budget_exhausted");
    expect(error.observedUsage).toEqual({
      inputTokens: 7,
      outputTokens: 5,
      cacheReadTokens: 200,
      cacheWriteTokens: 200,
    });
    expect(reviewer.calls).toBe(0);
    expect(sink.events.filter((event) => event.type === "adapter.attempt")).toHaveLength(2);
    expect(sink.events.at(-1)?.type).toBe("run.failed");
  });

  test("sanitizes configured secrets before failure events reach the sink", async () => {
    const proposer = new ScenarioAgent(() => Promise.reject(new AgentFailure({
      code: "provider_failure",
      message: "provider exposed configured-secret-123",
      trace: FAILED_TRACE,
    })));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("unused")));
    const sink = new MemorySink();

    await debateError(debateInput(proposer, reviewer, sink, {
      recording: {
        runId: "artifact-failure",
        sink,
        failureSecrets: ["configured-secret-123"],
      },
    }));

    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain("configured-secret-123");
    expect(serialized).toContain("[REDACTED]");
  });

  test("keeps unavailable usage absent rather than manufacturing zero", async () => {
    const unknownTrace: AgentTrace = {
      attempts: [{
        attempt: 1,
        status: "succeeded",
        usage: {},
        usageEvidence: { explicitlyReported: [], source: "usage unavailable" },
      }],
    };
    const proposer = new ScenarioAgent(() => Promise.resolve(reply("Proposal", unknownTrace)));
    const reviewer = new ScenarioAgent(() => Promise.resolve(reply("Review", unknownTrace)));
    const sink = new MemorySink();

    await runDebate(debateInput(proposer, reviewer, sink, {
      budget: { maxTurns: 2, maxTokens: 1 },
    }));

    const attempts = sink.events.filter((event) => event.type === "adapter.attempt");
    expect(attempts.map((event) => event.data.attempt.usage)).toEqual([{}, {}]);
    expect(sink.events.at(-1)?.type).toBe("run.completed");
  });
});

function usageTrace(usage: AgentTrace["attempts"][number]["usage"]): AgentTrace {
  return {
    attempts: [{
      attempt: 1,
      status: "succeeded",
      usage,
      usageEvidence: { explicitlyReported: [], source: "test usage" },
    }],
  };
}

function waitForAbort(signal: AbortSignal | undefined): Promise<AgentReply> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(new AgentFailure({ code: "cancelled", message: "cancelled", trace: FAILED_TRACE }));
      return;
    }
    signal?.addEventListener("abort", () => {
      reject(new AgentFailure({ code: "cancelled", message: "cancelled", trace: FAILED_TRACE }));
    }, { once: true });
  });
}

async function debateError(input: RunDebateInput): Promise<DebateRunFailure> {
  try {
    await runDebate(input);
  } catch (error) {
    if (error instanceof DebateRunFailure) return error;
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
  throw new Error("expected debate to fail");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}
