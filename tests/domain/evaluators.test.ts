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
} from "../../src/domain/evaluators";
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

describe("deterministic evaluators", () => {
  test("scores a fully completed run as 1 and a failed run below it", async () => {
    const events = await recordedRun(
      [reply("- Proposal", 100, 50)],
      [reply("- Review", 100, 50)],
      1,
    );
    expect(evaluateCompletion(events).score).toBe(1);

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
    const failed = evaluateCompletion(sink.events);
    expect(failed.score).toBe(0);
    expect(failed.detail).toContain("0 of 2 turns completed");
  });

  test("scores contract markers by adherent reply fraction", async () => {
    const events = await recordedRun(
      [reply("- bulleted proposal", 100, 10)],
      [reply("prose review without markers", 100, 10)],
      1,
    );
    const score = evaluateContractMarkers(events, { contractMarkers: ["- "] });
    expect(score.score).toBe(0.5);
    expect(score.value).toBe(1);
  });

  test("penalizes verbatim same-role repetition and rewards variation", async () => {
    const repeated = await recordedRun(
      [reply("alpha beta gamma", 100, 10), reply("alpha beta gamma", 100, 10)],
      [reply("first review here", 100, 10), reply("wholly different words", 100, 10)],
      2,
    );
    expect(evaluateRepetition(repeated).score).toBe(0);

    const varied = await recordedRun(
      [reply("alpha beta gamma", 100, 10), reply("delta epsilon zeta", 100, 10)],
      [reply("first review here", 100, 10), reply("second look now", 100, 10)],
      2,
    );
    expect(evaluateRepetition(varied).score).toBe(1);
  });

  test("scores output shape within inclusive character bounds", async () => {
    const events = await recordedRun(
      [reply("ok", 100, 10)],
      [reply("x".repeat(50), 100, 10)],
      1,
    );
    const score = evaluateOutputShape(events, { outputShape: { minChars: 3, maxChars: 60 } });
    expect(score.score).toBe(0.5);
    expect(score.detail).toContain("1 of 2 replies");
  });

  test("normalizes retry-inclusive token usage against the budget", async () => {
    const events = await recordedRun(
      [reply("- P", 100, 300)],
      [reply("- R", 100, 200)],
      1,
    );
    const score = evaluateTokenUsage(events, { tokenBudget: 1_000 });
    expect(score.value).toBe(500);
    expect(score.score).toBe(0.5);
    expect(evaluateTokenUsage(events).score).toBe(0);
  });

  test("normalizes mean turn latency against the target", async () => {
    const events = await recordedRun(
      [reply("- P", 200, 10)],
      [reply("- R", 400, 10)],
      1,
    );
    const score = evaluateLatency(events, { latencyTargetMs: 600 });
    expect(score.value).toBe(300);
    expect(score.score).toBe(0.5);
    expect(evaluateLatency(events).score).toBe(0);
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
      expect(item.score).toBeGreaterThanOrEqual(0);
      expect(item.score).toBeLessThanOrEqual(1);
    }
  });
});
