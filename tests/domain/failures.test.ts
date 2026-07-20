import { describe, expect, test } from "bun:test";

import {
  AgentFailure,
  type AgentPort,
  type AgentReply,
  type AgentReplyOptions,
  type AgentTrace,
  type TurnRequest,
} from "../../src/domain/agent";
import {
  DebateRunFailure,
  runDebate,
  type DebateEventSink,
  type RunDebateInput,
} from "../../src/domain/debate";
import type { CanonicalEvent } from "../../src/domain/events";
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

const FAILED_TRACE: AgentTrace = {
  attempts: [{
    attempt: 1,
    status: "failed",
    httpStatus: 503,
    usage: {},
    usageEvidence: { explicitlyReported: [], source: "provider response" },
  }],
};

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
      turnTimeoutMs: 25,
      budget: { maxTurns: 2, maxTokens: 100 },
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
      turnTimeoutMs: null,
      budget: null,
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
