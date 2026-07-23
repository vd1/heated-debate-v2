import { describe, expect, test } from "bun:test";

import { ScriptedAgent, type ScriptedReply } from "../../src/domain/agent";
import { runDebate, type DebateEventSink } from "../../src/domain/debate";
import type { CanonicalEvent } from "../../src/domain/events";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";
import { parseRubric, type EvaluationRecord } from "../../src/domain/rubric";
import { parseStudySpec } from "../../src/domain/study-spec";
import { collectReliabilitySamples } from "../../src/infrastructure/reliability-collector";

const JUDGE_MODEL = { providerId: "test", modelId: "judge-model" };
const DEBATER_MODEL = { providerId: "test", modelId: "debater-model" };

const RUBRIC = parseRubric({
  rubricVersion: "1",
  rubricId: "debate-quality",
  dimensions: [{
    dimensionId: "quality",
    description: "Overall quality.",
    scale: { min: 1, max: 5 },
    direction: "higher-is-better",
    requiredEvidence: "none",
  }],
});

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-collect",
  hypotheses: ["h"],
  benchmarkCaseIds: ["c1"],
  holdoutCaseIds: [],
  fixedParameters: {},
  variedParameters: [{ dimensionId: "thinkingLevel", values: ["low", "high"] }],
  repetitions: 1,
  evaluators: [{ evaluatorId: "e", evaluatorVersion: "1" }],
  rubric: { rubricId: "debate-quality", rubricVersion: "1" },
  pricingSnapshot: {
    snapshotId: "p", snapshotVersion: "1", currency: "USD",
    effectiveDate: "2026-07-01", provenance: "t",
    entries: [{
      model: JUDGE_MODEL,
      inputRatePerMillionTokens: 1, outputRatePerMillionTokens: 1,
      cacheReadRatePerMillionTokens: 0, cacheWriteRatePerMillionTokens: 0,
      reasoningBilling: { mode: "included-in-output" },
    }],
  },
  samplerSeed: 7,
  caseOrderPolicy: "spec-order",
  baseline: { thinkingLevel: "low" },
  holdoutUsePolicy: "never",
  failureHandling: "record-and-continue",
  unknownCostPolicy: "fail-closed",
  rewardScalarization: { rewardId: "reward", rewardVersion: "1" },
  budgets: { perRun: { maxTurns: 4, maxTokens: 1_000 } },
  stoppingRules: { maxRuns: 8 },
  plannedAnalysis: "a",
  reliabilityThresholds: {
    minimumSampleCount: 2, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
  },
};

function judgeReply(text: string): ScriptedReply {
  return {
    text,
    durationMs: 1,
    model: JUDGE_MODEL,
    controls: {
      model: { requested: JUDGE_MODEL, forwarded: JUDGE_MODEL },
      thinkingLevel: { requested: "low", forwarded: "low" },
    },
    usage: { values: { inputTokens: 100, outputTokens: 50 }, explicitlyReported: [] },
    trace: {
      attempts: [{
        attempt: 1,
        status: "succeeded",
        httpStatus: 200,
        usage: { inputTokens: 100, outputTokens: 50 },
        usageEvidence: { explicitlyReported: [], source: "test" },
      }],
    },
  };
}

async function sourceEvents(): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  const sink: DebateEventSink = {
    append: (event) => {
      events.push(structuredClone(event));
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
  };
  const debateReply = (text: string): ScriptedReply => ({
    ...judgeReply(text),
    model: DEBATER_MODEL,
    controls: {
      model: { requested: DEBATER_MODEL, forwarded: DEBATER_MODEL },
      thinkingLevel: { requested: "low", forwarded: "low" },
    },
  });
  await runDebate({
    debateId: "collect-source",
    topic: "Design a cache.",
    roundCount: 1,
    proposer: {
      agent: new ScriptedAgent([debateReply("Use an LRU cache with TTL.")]),
      role: PROPOSER_ROLE,
      controls: { model: DEBATER_MODEL, thinkingLevel: "low" },
    },
    reviewer: {
      agent: new ScriptedAgent([debateReply("TTL needs jitter to avoid stampedes.")]),
      role: REVIEWER_ROLE,
      controls: { model: DEBATER_MODEL, thinkingLevel: "low" },
    },
    recording: { runId: "collect-source", sink },
  });
  return events;
}

const VALID_RESPONSE = JSON.stringify({ dimensions: { quality: { score: 4 } } });

describe("reliability collector", () => {
  test("collects a seeded balanced permutation plan with full sample evidence", async () => {
    const events = await sourceEvents();
    const records: EvaluationRecord[] = [];
    const run = () => collectReliabilitySamples({
      spec: parseStudySpec(structuredClone(SPEC_JSON)),
      rubric: RUBRIC,
      events,
      judgeControls: { model: JUDGE_MODEL, thinkingLevel: "low" },
      createAgent: () => Promise.resolve(new ScriptedAgent([judgeReply(VALID_RESPONSE)])),
      persistRecord: (record) => {
        records.push(record);
        return Promise.resolve();
      },
      sampleCount: 4,
    });

    const first = await run();
    const second = await run();

    expect(first.samples).toHaveLength(4);
    // The plan derives from the preregistered sampler seed: deterministic and
    // balanced across presentation orders.
    expect(first.orderings).toEqual(second.orderings);
    expect(first.orderings.filter((order) => order === "forward")).toHaveLength(2);
    expect(first.orderings.filter((order) => order === "reversed")).toHaveLength(2);
    const sample = first.samples[0];
    if (!sample) throw new Error("missing sample");
    expect(sample.candidateRunId).toBe("collect-source");
    expect(sample.evaluationRecordHash).toMatch(/^[0-9a-f]{64}$/);
    // The debater identity comes from the source artifact, not the judge.
    expect(sample.debaterModel).toEqual(DEBATER_MODEL);
    expect(sample.judgeModel).toEqual(JUDGE_MODEL);
    // Attempt-inclusive accounting: 150 tokens per judged sample.
    expect(first.totalTokens).toBe(600);
    expect(first.totalCostScaled).toBe(600_000_000n);
    expect(records).toHaveLength(8);
  });

  test("stops at the token budget and keeps the shortfall visible", async () => {
    const events = await sourceEvents();
    const outcome = await collectReliabilitySamples({
      spec: parseStudySpec(structuredClone(SPEC_JSON)),
      rubric: RUBRIC,
      events,
      judgeControls: { model: JUDGE_MODEL, thinkingLevel: "low" },
      createAgent: () => Promise.resolve(new ScriptedAgent([judgeReply(VALID_RESPONSE)])),
      persistRecord: () => Promise.resolve(),
      sampleCount: 4,
      budgets: { maxTotalTokens: 300 },
    });

    expect(outcome.samples).toHaveLength(2);
    expect(outcome.missingEvaluations).toHaveLength(2);
    expect(outcome.missingEvaluations[0]?.reason).toContain("budget");
  });

  test("keeps unavailable evaluations instead of silently dropping them", async () => {
    const events = await sourceEvents();
    let calls = 0;
    const outcome = await collectReliabilitySamples({
      spec: parseStudySpec(structuredClone(SPEC_JSON)),
      rubric: RUBRIC,
      events,
      judgeControls: { model: JUDGE_MODEL, thinkingLevel: "low" },
      createAgent: () => {
        calls += 1;
        return Promise.resolve(new ScriptedAgent([
          judgeReply(calls === 2 ? "not the contract" : VALID_RESPONSE),
        ]));
      },
      persistRecord: () => Promise.resolve(),
      sampleCount: 3,
    });

    expect(outcome.samples).toHaveLength(2);
    expect(outcome.missingEvaluations).toHaveLength(1);
    expect(outcome.missingEvaluations[0]?.reason).toContain("malformed");
  });

  test("fails closed on mixed debater identities pending per-candidate strata", async () => {
    const events = await sourceEvents();
    const completed = events.filter((event) => event.type === "turn.completed");
    const second = completed[1];
    if (second?.type !== "turn.completed") throw new Error("missing turn");
    second.data = {
      ...second.data,
      reply: { ...second.data.reply, model: { providerId: "test", modelId: "other" } },
    };

    let caught: unknown;
    try {
      await collectReliabilitySamples({
        spec: parseStudySpec(structuredClone(SPEC_JSON)),
        rubric: RUBRIC,
        events,
        judgeControls: { model: JUDGE_MODEL, thinkingLevel: "low" },
        createAgent: () => Promise.resolve(new ScriptedAgent([judgeReply(VALID_RESPONSE)])),
        persistRecord: () => Promise.resolve(),
        sampleCount: 2,
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("debater");
  });
});
