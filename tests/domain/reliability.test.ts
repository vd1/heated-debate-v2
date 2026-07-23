import { describe, expect, test } from "bun:test";

import {
  analyzeReliability,
  assertAcceptedReliability,
  createReliabilityArtifact,
  type ReliabilitySample,
} from "../../src/domain/reliability";
import { parseStudySpec, type StudySpec } from "../../src/domain/study-spec";

const JUDGE = { providerId: "test", modelId: "judge" };
const OTHER = { providerId: "test", modelId: "debater" };

function sample(overrides: Partial<ReliabilitySample>): ReliabilitySample {
  return {
    sampleId: `sample-${JSON.stringify(overrides)}`,
    ordering: "forward",
    judgeModel: JUDGE,
    debaterModel: OTHER,
    score: 0.5,
    ...overrides,
  };
}

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-rel",
  hypotheses: ["h"],
  benchmarkCaseIds: ["c1"],
  holdoutCaseIds: [],
  fixedParameters: {},
  variedParameters: [{ dimensionId: "thinkingLevel", values: ["low", "high"] }],
  repetitions: 1,
  evaluators: [{ evaluatorId: "e", evaluatorVersion: "1" }],
  rubric: { rubricId: "r", rubricVersion: "1" },
  pricingSnapshot: {
    snapshotId: "p", snapshotVersion: "1", currency: "USD",
    effectiveDate: "2026-07-01", provenance: "t",
    entries: [{
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
      inputRatePerMillionTokens: 0, outputRatePerMillionTokens: 0,
      cacheReadRatePerMillionTokens: 0, cacheWriteRatePerMillionTokens: 0,
      reasoningBilling: { mode: "included-in-output" },
    }],
  },
  samplerSeed: 1,
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
    minimumSampleCount: 4,
    maximumJudgeVariance: 0.05,
    maximumOrderingBiasEffect: 0.1,
  },
};

function spec(): StudySpec {
  return parseStudySpec(structuredClone(SPEC_JSON));
}

describe("reliability analysis", () => {
  test("measures variance, ordering bias, self-preference, and disagreement", () => {
    const samples: ReliabilitySample[] = [
      { sampleId: "a", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0.8 },
      { sampleId: "b", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0.8 },
      { sampleId: "c", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 0.6 },
      { sampleId: "d", ordering: "reversed", judgeModel: JUDGE, debaterModel: JUDGE, score: 1 },
      {
        sampleId: "e",
        ordering: "forward",
        judgeModel: { providerId: "test", modelId: "judge-2" },
        debaterModel: OTHER,
        score: 0.4,
      },
    ];

    const analysis = analyzeReliability(samples);

    expect(analysis.sampleCount).toBe(5);
    // Forward mean (0.8+0.8+0.4)/3, reversed mean (0.6+1)/2.
    expect(analysis.orderingBiasEffect).toBeCloseTo(Math.abs(2 / 3 - 0.8), 10);
    // Same-model mean 1 minus cross mean 0.65.
    expect(analysis.selfPreferenceEffect).toBeCloseTo(1 - 0.65, 10);
    // Judge means: judge (0.8+0.8+0.6+1)/4 = 0.8, judge-2 0.4.
    expect(analysis.judgeDisagreement).toBeCloseTo(0.4, 10);
    expect(analysis.judgeVariance).toBeGreaterThan(0);
  });

  test("rejects out-of-range scores", () => {
    expect(() => analyzeReliability([sample({ score: 1.5 })])).toThrow(
      "score must be within [0, 1]",
    );
  });
});

describe("reliability artifact", () => {
  const judge = {
    model: JUDGE,
    controls: { model: JUDGE, thinkingLevel: "high" as const },
    promptText: "Score the transcript.",
  };

  test("accepts only when every preregistered threshold passes", () => {
    const tight: ReliabilitySample[] = [
      { sampleId: "a", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0.7 },
      { sampleId: "b", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 0.72 },
      { sampleId: "c", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0.71 },
      { sampleId: "d", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 0.69 },
    ];
    const accepted = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: tight,
      conclusions: "Stable scores across orderings.",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.evaluatedThresholds.every((item) => item.passed)).toBe(true);
    expect(accepted.rawScores).toEqual([0.7, 0.72, 0.71, 0.69]);
    expect(accepted.judge.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.pricingSnapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const scattered = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        { sampleId: "a", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0 },
        { sampleId: "b", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 1 },
        { sampleId: "c", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0 },
        { sampleId: "d", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 1 },
      ],
      conclusions: "High variance and ordering bias.",
    });
    expect(scattered.status).toBe("rejected");
    expect(scattered.evaluatedThresholds.some((item) => !item.passed)).toBe(true);
  });

  test("gates optimization on a matching accepted artifact", () => {
    const artifact = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        { sampleId: "a", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0.7 },
        { sampleId: "b", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 0.7 },
        { sampleId: "c", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0.7 },
        { sampleId: "d", ordering: "reversed", judgeModel: JUDGE, debaterModel: OTHER, score: 0.7 },
      ],
      conclusions: "ok",
    });
    expect(() => {
      assertAcceptedReliability(artifact, spec());
    }).not.toThrow();

    const otherSpec = parseStudySpec({ ...structuredClone(SPEC_JSON), studyId: "different" });
    expect(() => {
      assertAcceptedReliability(artifact, otherSpec);
    }).toThrow("reliability artifact does not match the study spec");

    const rejected = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        { sampleId: "a", ordering: "forward", judgeModel: JUDGE, debaterModel: OTHER, score: 0 },
      ],
      conclusions: "too few",
    });
    expect(() => {
      assertAcceptedReliability(rejected, spec());
    }).toThrow("optimization requires an accepted reliability artifact");
  });
});
