import { describe, expect, test } from "bun:test";

import { benchmarkCaseHash, FIXTURE_CASES } from "../../src/domain/cases";
import { generateExperimentMatrix } from "../../src/domain/matrix";
import { parseStudySpec, studySpecHash } from "../../src/domain/study-spec";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-thinking-sweep",
  hypotheses: ["Higher thinking levels improve review specificity."],
  benchmarkCaseIds: ["fixture-bounded-queue", "fixture-retry-policy"],
  holdoutCaseIds: ["fixture-schema-migration"],
  fixedParameters: { roundCount: 2 },
  variedParameters: [
    { dimensionId: "thinkingLevel", values: ["low", "high"] },
    { dimensionId: "temperature", values: [0.2, 1] },
  ],
  repetitions: 2,
  evaluators: [{ evaluatorId: "judge-default", evaluatorVersion: "1" }],
  rubric: { rubricId: "debate-quality", rubricVersion: "1" },
  pricingSnapshot: {
    snapshotId: "pricing-test",
    snapshotVersion: "1",
    currency: "USD",
    effectiveDate: "2026-07-01",
    provenance: "test fixture",
    entries: [{
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
      inputRatePerMillionTokens: 1,
      outputRatePerMillionTokens: 10,
      cacheReadRatePerMillionTokens: 0,
      cacheWriteRatePerMillionTokens: 0,
      reasoningBilling: { mode: "included-in-output" },
    }],
  },
  samplerSeed: 7,
  caseOrderPolicy: "spec-order",
  baseline: { thinkingLevel: "low", temperature: 0.2 },
  holdoutUsePolicy: "final-evaluation-only",
  failureHandling: "record-and-continue",
  unknownCostPolicy: "fail-closed",
  rewardScalarization: { rewardId: "reward-default", rewardVersion: "1" },
  budgets: { perRun: { maxTurns: 8, maxTokens: 200_000 } },
  stoppingRules: { maxRuns: 48 },
  plannedAnalysis: "Pairwise comparison per case.",
  reliabilityThresholds: {
    minimumSampleCount: 12,
    maximumJudgeVariance: 0.5,
    maximumOrderingBiasEffect: 0.2,
  },
};

describe("experiment matrix", () => {
  test("generates a deterministic complete matrix with stable run IDs", () => {
    const spec = parseStudySpec(structuredClone(SPEC_JSON));
    const first = generateExperimentMatrix(spec, FIXTURE_CASES);
    const second = generateExperimentMatrix(spec, FIXTURE_CASES);

    // Selection: 2 benchmark cases x 4 variants x 2 repetitions; no holdout runs.
    expect(first).toHaveLength(16);
    expect(second).toEqual(first);
    expect(new Set(first.map((run) => run.runId)).size).toBe(16);
    expect(first.every((run) => run.purpose === "selection" && !run.holdout)).toBe(true);

    const finalEvaluation = generateExperimentMatrix(spec, FIXTURE_CASES, {
      purpose: "final-evaluation",
    });
    // Only the preregistered baseline point runs on the holdout set.
    expect(finalEvaluation).toHaveLength(2);
    expect(finalEvaluation.every((run) => run.holdout && run.purpose === "final-evaluation"))
      .toBe(true);
    expect(finalEvaluation.every(
      (run) => run.parameters.thinkingLevel === "low" && run.parameters.temperature === 0.2,
    )).toBe(true);

    const sample = first[0];
    if (!sample) throw new Error("empty matrix");
    const queueCase = FIXTURE_CASES.find((item) => item.caseId === "fixture-bounded-queue");
    if (!queueCase) throw new Error("missing fixture");
    const caseHash = benchmarkCaseHash(queueCase);
    // Variants sort by canonical typed key; repetitions are zero-based.
    expect(sample.runId).toBe(
      `study-thinking-sweep:${studySpecHash(spec).slice(0, 12)}`
      + `:fixture-bounded-queue:${caseHash.slice(0, 12)}`
      + ':temperature=0.2,thinkingLevel="high":rep0',
    );
    expect(sample.specHash).toBe(studySpecHash(spec));
    expect(sample.caseHash).toBe(caseHash);
    expect(sample.parameters).toEqual({
      roundCount: 2,
      thinkingLevel: "high",
      temperature: 0.2,
    });
    expect(sample.holdout).toBe(false);
  });

  test("rejects missing and duplicate case definitions", () => {
    const spec = parseStudySpec(structuredClone(SPEC_JSON));

    expect(() => generateExperimentMatrix(spec, FIXTURE_CASES.slice(0, 1))).toThrow(
      "case fixture-retry-policy is not defined",
    );
    expect(() => generateExperimentMatrix(spec, [...FIXTURE_CASES, ...FIXTURE_CASES.slice(0, 1)]))
      .toThrow("duplicate case definition fixture-bounded-queue");
  });
});
