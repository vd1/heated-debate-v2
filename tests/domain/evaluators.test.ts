import { describe, expect, test } from "bun:test";

import {
  AgentFailure,
  ScriptedAgent,
  type ScriptedReply,
  type AgentPort,
} from "../../src/domain/agent";
import { runDebate, type DebateEventSink } from "../../src/domain/debate";
import {
  evaluateCompletion,
  evaluateContractMarkers,
  evaluateLatency,
  evaluateOutputShape,
  evaluateRepetition,
  evaluateTokenUsage,
  runDeterministicEvaluators,
  deterministicEvaluators,
  validateEvaluatorOptions,
  type EvaluatorPort,
} from "../../src/domain/evaluators";
import type { DeterministicScore } from "../../src/domain/evaluators";
import type { CanonicalEvent } from "../../src/domain/events";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";

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

const MODEL = { providerId: "test", modelId: "model" };

function reply(text: string, durationMs: number, tokens: number): ScriptedReply {
  return {
    text,
    durationMs,
    model: MODEL,
    controls: {
      model: { requested: MODEL, forwarded: MODEL },
      thinkingLevel: { requested: "high", forwarded: "high" },
    },
    usage: { values: {}, explicitlyReported: [] },
    trace: {
      attempts: [{
        attempt: 1,
        status: "succeeded",
        httpStatus: 200,
        usage: { inputTokens: tokens, outputTokens: 0 },
        usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
      }],
    },
  };
}

async function recordedRun(
  proposerReplies: ScriptedReply[],
  reviewerReplies: ScriptedReply[],
  roundCount: number,
): Promise<CanonicalEvent[]> {
  const sink = new MemorySink();
  await runDebate({
    debateId: "eval-run",
    topic: "Evaluate this.",
    roundCount,
    proposer: {
      agent: new ScriptedAgent(proposerReplies),
      role: PROPOSER_ROLE,
      controls: { model: MODEL, thinkingLevel: "high" },
    },
    reviewer: {
      agent: new ScriptedAgent(reviewerReplies),
      role: REVIEWER_ROLE,
      controls: { model: MODEL, thinkingLevel: "high" },
    },
    recording: { runId: "artifact-eval", sink },
  });
  return sink.events;
}

function known(result: DeterministicScore): Extract<DeterministicScore, { status: "known" }> {
  if (result.status !== "known") throw new Error(`expected known result: ${result.reason}`);
  return result;
}

describe("deterministic evaluators", () => {
  test("scores a fully completed run as 1 and a failed run below it", async () => {
    const events = await recordedRun(
      [reply("- Proposal", 100, 50)],
      [reply("- Review", 100, 50)],
      1,
    );
    expect(known(evaluateCompletion(events)).score).toBe(1);

    const sink = new MemorySink();
    const failing: AgentPort = {
      reply: () => Promise.reject(new AgentFailure({
        code: "provider_failure",
        message: "down",
        trace: { attempts: [] },
      })),
      dispose: () => Promise.resolve(),
    };
    let caught: unknown;
    try {
      await runDebate({
        debateId: "eval-fail",
        topic: "Evaluate this.",
        roundCount: 1,
        proposer: { agent: failing, role: PROPOSER_ROLE, controls: { model: MODEL, thinkingLevel: "high" } },
        reviewer: { agent: failing, role: REVIEWER_ROLE, controls: { model: MODEL, thinkingLevel: "high" } },
        recording: { runId: "artifact-fail", sink },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const failed = known(evaluateCompletion(sink.events));
    expect(failed.score).toBe(0);
    expect(failed.detail).toContain("0 of 2 turns completed");
  });

  test("scores contract markers by adherent reply fraction", async () => {
    const events = await recordedRun(
      [reply("- bulleted proposal", 100, 10)],
      [reply("prose review without markers", 100, 10)],
      1,
    );
    const score = known(evaluateContractMarkers(events, { contractMarkers: ["- "] }));
    expect(score.score).toBe(0.5);
    expect(score.value).toBe(1);
  });

  test("penalizes verbatim same-role repetition and rewards variation", async () => {
    const repeated = await recordedRun(
      [reply("alpha beta gamma", 100, 10), reply("alpha beta gamma", 100, 10)],
      [reply("first review here", 100, 10), reply("wholly different words", 100, 10)],
      2,
    );
    expect(known(evaluateRepetition(repeated)).score).toBe(0);

    const varied = await recordedRun(
      [reply("alpha beta gamma", 100, 10), reply("delta epsilon zeta", 100, 10)],
      [reply("first review here", 100, 10), reply("second look now", 100, 10)],
      2,
    );
    expect(known(evaluateRepetition(varied)).score).toBe(1);
  });

  test("scores output shape within inclusive character bounds", async () => {
    const events = await recordedRun(
      [reply("ok", 100, 10)],
      [reply("x".repeat(50), 100, 10)],
      1,
    );
    const score = known(evaluateOutputShape(events, { outputShape: { minChars: 3, maxChars: 60 } }));
    expect(score.score).toBe(0.5);
    expect(score.detail).toContain("1 of 2 replies");
  });

  test("normalizes retry-inclusive token usage against the budget", async () => {
    const events = await recordedRun(
      [reply("- P", 100, 300)],
      [reply("- R", 100, 200)],
      1,
    );
    const score = known(evaluateTokenUsage(events, { tokenBudget: 1_000 }));
    expect(score.value).toBe(500);
    expect(score.score).toBe(0.5);
    expect(evaluateTokenUsage(events).status).toBe("unavailable");
  });

  test("normalizes mean turn latency against the target", async () => {
    const events = await recordedRun(
      [reply("- P", 200, 10)],
      [reply("- R", 400, 10)],
      1,
    );
    const score = known(evaluateLatency(events, { latencyTargetMs: 600 }));
    expect(score.value).toBe(300);
    expect(score.score).toBe(0.5);
    expect(evaluateLatency(events).status).toBe("unavailable");
  });

  test("runs all six evaluators with stable identities", async () => {
    const events = await recordedRun(
      [reply("- P", 100, 10)],
      [reply("- R", 100, 10)],
      1,
    );
    const scores = runDeterministicEvaluators(events, {
      tokenBudget: 100,
      latencyTargetMs: 500,
    });
    expect(scores.map((item) => item.evaluatorId)).toEqual([
      "deterministic-completion",
      "deterministic-contract-markers",
      "deterministic-repetition",
      "deterministic-output-shape",
      "deterministic-token-usage",
      "deterministic-latency",
    ]);
    for (const item of scores) {
      if (item.evaluatorId === "deterministic-repetition") {
        // One round has no consecutive same-role pair; unavailable, not perfect.
        expect(item.status).toBe("unavailable");
        continue;
      }
      const value = known(item);
      expect(value.score).toBeGreaterThanOrEqual(0);
      expect(value.score).toBeLessThanOrEqual(1);
      expect(value.range).toEqual({ min: 0, max: 1 });
      expect(value.direction).toBe("higher-is-better");
      expect(value.configurationId).toMatch(/^[0-9a-f]{64}$/);
      expect(value.evidence.eventSequences.length).toBeGreaterThan(0);
    }
  });
});

describe("evaluator boundary cases", () => {
  test("missing usage evidence is unavailable, never a perfect score", async () => {
    const noUsage: ScriptedReply = {
      ...reply("- text", 100, 0),
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: {},
          usageEvidence: { explicitlyReported: [], source: "test" },
        }],
      },
    };
    const events = await recordedRun([noUsage], [structuredClone(noUsage)], 1);

    const result = evaluateTokenUsage(events, { tokenBudget: 100 });
    expect(result.status).toBe("unavailable");
  });

  test("rejects invalid evaluator configuration instead of producing NaN", async () => {
    const events = await recordedRun([reply("- P", 100, 10)], [reply("- R", 100, 10)], 1);
    expect(() => evaluateLatency(events, { latencyTargetMs: Number.NaN })).toThrow(
      "latencyTargetMs must be a finite positive number",
    );
    expect(() => evaluateTokenUsage(events, { tokenBudget: 0 })).toThrow(
      "tokenBudget must be a positive safe integer",
    );
  });

  test("repetition similarity stays within range for duplicated words", async () => {
    const events = await recordedRun(
      [reply("a", 100, 10), reply("a a a", 100, 10)],
      [reply("x y", 100, 10), reply("p q", 100, 10)],
      2,
    );
    const result = known(evaluateRepetition(events));
    expect(result.value).toBeLessThanOrEqual(1);
    expect(result.score).toBe(0);
  });
});

describe("partial evidence and empty populations", () => {
  test("partial attempt usage is unavailable, never an exact total", async () => {
    const partial: ScriptedReply = {
      ...reply("- text", 100, 0),
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          httpStatus: 200,
          usage: { inputTokens: 20 },
          usageEvidence: { explicitlyReported: [], source: "test" },
        }],
      },
    };
    const events = await recordedRun([partial], [structuredClone(partial)], 1);
    const result = evaluateTokenUsage(events, { tokenBudget: 100 });
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") {
      expect(result.reason).toContain("partial usage");
    }
  });
});

describe("evaluator configuration and terminal-evidence rules", () => {
  test("rejects non-finite and non-positive numeric options for every evaluator", () => {
    expect(() => validateEvaluatorOptions({ latencyTargetMs: Number.POSITIVE_INFINITY }))
      .toThrow("latencyTargetMs");
    expect(() => validateEvaluatorOptions({ latencyTargetMs: Number.NEGATIVE_INFINITY }))
      .toThrow("latencyTargetMs");
    expect(() => validateEvaluatorOptions({ tokenBudget: 0 })).toThrow("tokenBudget");
    // Unsupported values are rejected even by evaluators that ignore the field.
    expect(() => evaluateCompletion([], { latencyTargetMs: Number.POSITIVE_INFINITY }))
      .toThrow("latencyTargetMs");
  });

  test("keeps the full configuration identity, not a truncated prefix", async () => {
    const events = await recordedRun(
      [reply("- Proposal", 10, 100)],
      [reply("- Review", 10, 100)],
      1,
    );
    const score = evaluateCompletion(events, {});
    expect(score.configurationId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("completion without terminal evidence is unavailable, never a known score", async () => {
    const events = await recordedRun(
      [reply("- Proposal", 10, 100)],
      [reply("- Review", 10, 100)],
      1,
    );
    // All turns completed but the terminal event is missing: a plausible
    // prefix must not produce a known completion score.
    const prefix = events.slice(0, -1);
    const score = evaluateCompletion(prefix, {});
    if (score.status !== "unavailable") throw new Error(score.status);
    expect(score.reason).toContain("terminal");
  });

  test("exposes deterministic evaluators as asynchronous ports", async () => {
    const events = await recordedRun(
      [reply("- Proposal", 10, 100)],
      [reply("- Review", 10, 100)],
      1,
    );
    const ports: readonly EvaluatorPort[] = deterministicEvaluators({});
    const completion = ports.find((port) => port.evaluatorId === "deterministic-completion");
    if (!completion) throw new Error("missing completion port");
    const result = await completion.evaluate(events);
    expect(result.status).toBe("known");
  });
});
