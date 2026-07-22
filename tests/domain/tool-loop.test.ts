import { describe, expect, test } from "bun:test";

import {
  createToolDispatcher,
  type ToolExecutor,
} from "../../src/domain/tool-loop";
import {
  resolveToolPolicy,
  type ToolCapabilityPolicy,
  type ToolPolicyBinding,
} from "../../src/domain/tool-policy";

const BINDING: ToolPolicyBinding = {
  role: { id: "proposer", version: "1" },
  phase: "proposal",
};

function policy(overrides: Partial<ToolCapabilityPolicy> = {}): ToolCapabilityPolicy {
  return resolveToolPolicy({
    policyId: "debate-tools",
    policyVersion: "1",
    evidence: "recorded",
    role: { id: "proposer", version: "1" },
    phase: "proposal",
    allowedTools: [
      { toolId: "calculator", schemaVersion: "2", maxCalls: 2 },
    ],
    aggregateCallLimit: 3,
    callTimeoutMs: 5_000,
    maxResultBytes: 16_384,
    deniedCallCharge: "none",
    ...overrides,
  }, BINDING);
}

function fakeClock(...ticks: number[]): () => number {
  let index = 0;
  return () => {
    const tick = ticks[Math.min(index, ticks.length - 1)];
    index += 1;
    if (tick === undefined) throw new Error("fake clock has no tick remaining");
    return tick;
  };
}

const CALCULATOR: ToolExecutor = {
  toolId: "calculator",
  schemaVersion: "2",
  execute: (args) => {
    const { a, b } = args as { a: number; b: number };
    return Promise.resolve(JSON.stringify({ sum: a + b }));
  },
};

describe("tool dispatcher", () => {
  test("executes an authorized call and records a complete ordered trace entry", async () => {
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [CALCULATOR],
      now: fakeClock(1_000, 1_040),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    });

    expect(record).toEqual({
      callId: "debate-1:round-1:proposer:call-1",
      ordinal: 1,
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
      disposition: { status: "accepted" },
      outcome: {
        status: "succeeded",
        output: '{"sum":3}',
        outputBytes: 9,
        truncation: null,
      },
      durationMs: 40,
    });
    expect(Object.isFrozen(record)).toBe(true);
    expect(dispatcher.trace()).toEqual([record]);
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 0,
      consumedCalls: 1,
    });
  });

  test("records an undeclared tool call as denied without executing or charging", async () => {
    let executed = 0;
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: () => {
          executed += 1;
          return Promise.resolve("never");
        },
      }],
      now: fakeClock(2_000, 2_000),
    });

    const record = await dispatcher.dispatch({
      toolId: "filesystem",
      schemaVersion: "1",
      arguments: { path: "/etc/passwd" },
    });

    expect(record).toEqual({
      callId: "debate-1:round-1:proposer:call-1",
      ordinal: 1,
      toolId: "filesystem",
      schemaVersion: "1",
      arguments: { path: "/etc/passwd" },
      disposition: { status: "denied", reason: "tool_not_allowed" },
      outcome: null,
      durationMs: 0,
    });
    expect(executed).toBe(0);
    expect(dispatcher.trace()).toEqual([record]);
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 0,
      deniedCalls: 1,
      consumedCalls: 0,
    });
  });

  test("charges an accepted call whose tool is unavailable in the environment", async () => {
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [],
      now: fakeClock(3_000, 3_005),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    });

    expect(record).toEqual({
      callId: "debate-1:round-1:proposer:call-1",
      ordinal: 1,
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
      disposition: { status: "accepted" },
      outcome: {
        status: "failed",
        error: {
          code: "tool_unavailable",
          message: "tool is unavailable in environment: calculator@2",
        },
      },
      durationMs: 5,
    });
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 0,
      consumedCalls: 1,
    });
  });

  test("charges and fails a call whose arguments are not JSON-representable", async () => {
    let executed = 0;
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: () => {
          executed += 1;
          return Promise.resolve("never");
        },
      }],
      now: fakeClock(4_000, 4_001),
    });

    const dropped = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, callback: () => 2 },
    });
    expect(dropped.disposition).toEqual({ status: "accepted" });
    expect(dropped.arguments).toEqual({ a: 1 });
    expect(dropped.outcome).toEqual({
      status: "failed",
      error: {
        code: "malformed_arguments",
        message: "tool call arguments must be JSON-representable",
      },
    });

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const unserializable = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: circular,
    });
    expect(unserializable.arguments).toBeNull();
    expect(unserializable.outcome).toEqual({
      status: "failed",
      error: {
        code: "malformed_arguments",
        message: "tool call arguments must be JSON-representable",
      },
    });

    expect(executed).toBe(0);
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 2,
      deniedCalls: 0,
      consumedCalls: 2,
    });
  });

  test("times out an accepted call at the policy timeout and aborts the executor", async () => {
    let observedSignal: AbortSignal | undefined;
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy({ callTimeoutMs: 20 }),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: (_args, context) => {
          observedSignal = context.signal;
          return new Promise<string>(() => {
            // never settles without external interruption
          });
        },
      }],
      now: fakeClock(5_000, 5_020),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    });

    expect(record.disposition).toEqual({ status: "accepted" });
    expect(record.outcome).toEqual({
      status: "failed",
      error: {
        code: "timeout",
        message: "tool call timed out after 20ms",
      },
    });
    expect(record.durationMs).toBe(20);
    expect(observedSignal?.aborted).toBe(true);
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 0,
      consumedCalls: 1,
    });
  });

  test("records a thrown executor error as a sanitized charged failure", async () => {
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: () => Promise.reject(new Error("backend rejected token secret-abc")),
      }],
      secrets: ["secret-abc"],
      now: fakeClock(6_000, 6_003),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    });

    expect(record.disposition).toEqual({ status: "accepted" });
    expect(record.outcome).toEqual({
      status: "failed",
      error: {
        code: "tool_error",
        message: "backend rejected token [REDACTED]",
      },
    });
    expect(record.durationMs).toBe(3);
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 0,
      consumedCalls: 1,
    });
  });

  test("cancels an in-flight call through a standard signal and charges it", async () => {
    let observedSignal: AbortSignal | undefined;
    const external = new AbortController();
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: (_args, context) => {
          observedSignal = context.signal;
          queueMicrotask(() => {
            external.abort();
          });
          return new Promise<string>(() => {
            // never settles without external interruption
          });
        },
      }],
      now: fakeClock(7_000, 7_002),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    }, { signal: external.signal });

    expect(record.disposition).toEqual({ status: "accepted" });
    expect(record.outcome).toEqual({
      status: "failed",
      error: {
        code: "cancelled",
        message: "tool call was cancelled",
      },
    });
    expect(observedSignal?.aborted).toBe(true);
    expect(dispatcher.accounting().aggregate).toEqual({
      acceptedCalls: 1,
      deniedCalls: 0,
      consumedCalls: 1,
    });
  });

  test("records a call under an already-aborted signal as cancelled without executing", async () => {
    let executed = 0;
    const external = new AbortController();
    external.abort();
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy(),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: () => {
          executed += 1;
          return Promise.resolve("never");
        },
      }],
      now: fakeClock(8_000, 8_000),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    }, { signal: external.signal });

    expect(record.outcome).toEqual({
      status: "failed",
      error: {
        code: "cancelled",
        message: "tool call was cancelled",
      },
    });
    expect(executed).toBe(0);
    expect(dispatcher.accounting().aggregate.consumedCalls).toBe(1);
  });

  test("truncates oversized output at the byte limit without splitting a character", async () => {
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy({ maxResultBytes: 10 }),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: () => Promise.resolve("123456789é"),
      }],
      now: fakeClock(9_000, 9_004),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    });

    expect(record.outcome).toEqual({
      status: "succeeded",
      output: "123456789",
      outputBytes: 9,
      truncation: { originalBytes: 11, retainedBytes: 9 },
    });
  });

  test("keeps output that exactly fits the byte limit untruncated", async () => {
    const dispatcher = createToolDispatcher({
      dispatchId: "debate-1:round-1:proposer",
      policy: policy({ maxResultBytes: 10 }),
      executors: [{
        toolId: "calculator",
        schemaVersion: "2",
        execute: () => Promise.resolve("12345678é"),
      }],
      now: fakeClock(10_000, 10_001),
    });

    const record = await dispatcher.dispatch({
      toolId: "calculator",
      schemaVersion: "2",
      arguments: { a: 1, b: 2 },
    });

    expect(record.outcome).toEqual({
      status: "succeeded",
      output: "12345678é",
      outputBytes: 10,
      truncation: null,
    });
  });
});
