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
    candidateRunId: "run-1",
    evaluationRecordHash: "e".repeat(64),
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
      sample({ sampleId: "a", ordering: "forward", score: 0.8 }),
      sample({ sampleId: "b", ordering: "forward", score: 0.8 }),
      sample({ sampleId: "c", ordering: "reversed", score: 0.6 }),
      sample({ sampleId: "d", ordering: "reversed", debaterModel: JUDGE, score: 1 }),
      sample({
        sampleId: "e",
        ordering: "forward",
        judgeModel: { providerId: "test", modelId: "judge-2" },
        score: 0.4,
      }),
    ];

    const analysis = analyzeReliability(samples);

    expect(analysis.sampleCount).toBe(5);
    if (analysis.orderingBiasEffect.status !== "known") throw new Error("ordering unavailable");
    // Forward mean (0.8+0.8+0.4)/3, reversed mean (0.6+1)/2.
    expect(analysis.orderingBiasEffect.value).toBeCloseTo(Math.abs(2 / 3 - 0.8), 10);
    if (analysis.selfPreferenceEffect.status !== "known") throw new Error("self unavailable");
    // Same-model mean 1 minus cross mean 0.65.
    expect(analysis.selfPreferenceEffect.value).toBeCloseTo(1 - 0.65, 10);
    if (analysis.judgeDisagreement.status !== "known") throw new Error("judges unavailable");
    // Judge means: judge (0.8+0.8+0.6+1)/4 = 0.8, judge-2 0.4.
    expect(analysis.judgeDisagreement.value).toBeCloseTo(0.4, 10);
    if (analysis.judgeVariance.status !== "known") throw new Error("variance unavailable");
    expect(analysis.judgeVariance.value).toBeGreaterThan(0);
  });

  test("rejects out-of-range scores and structurally invalid samples", () => {
    expect(() => analyzeReliability([sample({ score: 1.5 })])).toThrow(
      "score must be within [0, 1]",
    );
    expect(() => analyzeReliability([
      sample({ judgeModel: { providerId: "", modelId: "x" } }),
    ])).toThrow("judgeModel");
    expect(() => analyzeReliability([
      sample({ ordering: "sideways" as never }),
    ])).toThrow("ordering");
    expect(() => analyzeReliability([
      sample({ evaluationRecordHash: "short" }),
    ])).toThrow("evaluationRecordHash");
  });

  test("reports missing comparison populations as unavailable, never zero", () => {
    const forwardOnly = analyzeReliability([
      sample({ sampleId: "a", score: 0.7 }),
      sample({ sampleId: "b", score: 0.7 }),
    ]);
    expect(forwardOnly.orderingBiasEffect.status).toBe("unavailable");
    expect(forwardOnly.selfPreferenceEffect.status).toBe("unavailable");
    expect(forwardOnly.judgeDisagreement.status).toBe("unavailable");

    const empty = analyzeReliability([]);
    expect(empty.judgeVariance.status).toBe("unavailable");
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
      sample({ sampleId: "a", ordering: "forward", score: 0.7 }),
      sample({ sampleId: "b", ordering: "reversed", score: 0.72 }),
      sample({ sampleId: "c", ordering: "forward", score: 0.71 }),
      sample({ sampleId: "d", ordering: "reversed", score: 0.69 }),
    ];
    const accepted = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: tight,
      conclusions: "Stable scores across orderings.",
    });
    expect(accepted.status).toBe("accepted");
    expect(accepted.evaluatedThresholds.every((item) => item.passed)).toBe(true);
    expect(accepted.samples.map((item) => item.score)).toEqual([0.7, 0.72, 0.71, 0.69]);
    expect(accepted.judge.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(accepted.pricingSnapshot.snapshotHash).toMatch(/^[0-9a-f]{64}$/);

    const scattered = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        sample({ sampleId: "a", ordering: "forward", score: 0 }),
        sample({ sampleId: "b", ordering: "reversed", score: 1 }),
        sample({ sampleId: "c", ordering: "forward", score: 0 }),
        sample({ sampleId: "d", ordering: "reversed", score: 1 }),
      ],
      conclusions: "High variance and ordering bias.",
    });
    expect(scattered.status).toBe("rejected");
    expect(scattered.evaluatedThresholds.some((item) => !item.passed)).toBe(true);
  });

  test("rejects when a thresholded effect has no comparison population", () => {
    // Four identical forward-only samples: ordering bias is unmeasurable, so
    // the preregistered ordering threshold cannot pass.
    const forwardOnly = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        sample({ sampleId: "a", score: 0.7 }),
        sample({ sampleId: "b", score: 0.7 }),
        sample({ sampleId: "c", score: 0.7 }),
        sample({ sampleId: "d", score: 0.7 }),
      ],
      conclusions: "forward only",
    });
    expect(forwardOnly.status).toBe("rejected");

    // An empty collection under minimumSampleCount 0 is still rejected;
    // variance over nothing is unavailable, not zero.
    const empty = createReliabilityArtifact({
      spec: parseStudySpec({
        ...structuredClone(SPEC_JSON),
        reliabilityThresholds: {
          minimumSampleCount: 0, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
        },
      }),
      judge,
      samples: [],
      conclusions: "empty",
    });
    expect(empty.status).toBe("rejected");
  });

  test("enforces preregistered self-preference and disagreement limits", () => {
    const strictSpec = parseStudySpec({
      ...structuredClone(SPEC_JSON),
      reliabilityThresholds: {
        minimumSampleCount: 2,
        maximumJudgeVariance: 1,
        maximumOrderingBiasEffect: 1,
        maximumSelfPreferenceEffect: 0.1,
        maximumJudgeDisagreement: 0.1,
      },
    });
    const biased = createReliabilityArtifact({
      spec: strictSpec,
      judge,
      samples: [
        sample({ sampleId: "a", ordering: "forward", debaterModel: JUDGE, score: 1 }),
        sample({ sampleId: "b", ordering: "reversed", score: 0.95 }),
        sample({
          sampleId: "c",
          ordering: "forward",
          judgeModel: { providerId: "test", modelId: "judge-2" },
          score: 0.5,
        }),
        sample({ sampleId: "d", ordering: "reversed", score: 0.98 }),
      ],
      conclusions: "self-preferring and disagreeing",
    });
    expect(biased.status).toBe("rejected");
    const failing = biased.evaluatedThresholds.filter((item) => !item.passed)
      .map((item) => item.thresholdId);
    expect(failing).toContain("maximumSelfPreferenceEffect");
    expect(failing).toContain("maximumJudgeDisagreement");
  });

  test("preserves every sample's full evidence and any missing evaluations", () => {
    const artifact = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        sample({ sampleId: "a", ordering: "forward", score: 0.7 }),
        sample({ sampleId: "b", ordering: "reversed", score: 0.7 }),
        sample({ sampleId: "c", ordering: "forward", score: 0.7 }),
        sample({ sampleId: "d", ordering: "reversed", score: 0.7 }),
      ],
      missingEvaluations: [{ sampleId: "e", reason: "judge output malformed" }],
      conclusions: "ok",
    });
    expect(artifact.samples).toHaveLength(4);
    expect(artifact.samples[0]?.candidateRunId).toBe("run-1");
    expect(artifact.samples[0]?.evaluationRecordHash).toMatch(/^[0-9a-f]{64}$/);
    expect(artifact.missingEvaluations).toEqual([
      { sampleId: "e", reason: "judge output malformed" },
    ]);
  });

  test("gates optimization on a matching, recomputable accepted artifact", () => {
    const artifact = createReliabilityArtifact({
      spec: spec(),
      judge,
      samples: [
        sample({ sampleId: "a", ordering: "forward", score: 0.7 }),
        sample({ sampleId: "b", ordering: "reversed", score: 0.7 }),
        sample({ sampleId: "c", ordering: "forward", score: 0.7 }),
        sample({ sampleId: "d", ordering: "reversed", score: 0.7 }),
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
      samples: [sample({ sampleId: "a", ordering: "forward", score: 0 })],
      conclusions: "too few",
    });
    expect(() => {
      assertAcceptedReliability(rejected, spec());
    }).toThrow("optimization requires an accepted reliability artifact");

    // A manually constructed object with just the matching hash and status
    // must not pass the gate; the gate recomputes the analysis and verdict.
    const forged = {
      ...artifact,
      analysis: { ...artifact.analysis, sampleCount: 99 },
    } as typeof artifact;
    expect(() => {
      assertAcceptedReliability(forged, spec());
    }).toThrow("recompute");

    const tampered = {
      ...artifact,
      samples: artifact.samples.map((item, index) =>
        index === 0 ? { ...item, score: 0.1 } : item),
    } as typeof artifact;
    expect(() => {
      assertAcceptedReliability(tampered, spec());
    }).toThrow("recompute");
  });
});
