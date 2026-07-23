import { describe, expect, test } from "bun:test";

import {
  assertPreregisteredStudy,
  parseStudySpec,
  studyRunId,
  studySpecHash,
} from "../../src/domain/study-spec";

const SNAPSHOT = {
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
};

const SPEC = {
  specVersion: "1",
  studyId: "study-thinking-sweep",
  hypotheses: ["Higher thinking levels improve review specificity."],
  benchmarkCaseIds: ["fixture-bounded-queue", "fixture-retry-policy"],
  holdoutCaseIds: ["fixture-schema-migration"],
  fixedParameters: { roundCount: 2 },
  variedParameters: [{ dimensionId: "thinkingLevel", values: ["low", "high"] }],
  repetitions: 3,
  evaluators: [{ evaluatorId: "judge-default", evaluatorVersion: "1" }],
  rubric: { rubricId: "debate-quality", rubricVersion: "1" },
  pricingSnapshot: SNAPSHOT,
  samplerSeed: 7,
  caseOrderPolicy: "spec-order",
  baseline: { thinkingLevel: "low" },
  holdoutUsePolicy: "final-evaluation-only",
  failureHandling: "record-and-continue",
  unknownCostPolicy: "fail-closed",
  rewardScalarization: { rewardId: "reward-default", rewardVersion: "1" },
  budgets: { perRun: { maxTurns: 8, maxTokens: 200_000 }, maxTotalRuns: 24 },
  stoppingRules: { maxRuns: 24, maxConsecutiveFailures: 3 },
  plannedAnalysis: "Compare mean rubric scores between thinking levels with per-case pairing.",
  reliabilityThresholds: {
    minimumSampleCount: 12,
    maximumJudgeVariance: 0.5,
    maximumOrderingBiasEffect: 0.2,
  },
};

describe("study spec", () => {
  test("parses a validated frozen preregistered spec", () => {
    const spec = parseStudySpec(structuredClone(SPEC));

    expect(spec.studyId).toBe("study-thinking-sweep");
    expect(spec.variedParameters[0]?.dimensionId).toBe("thinkingLevel");
    expect(spec.pricingSnapshot.snapshotId).toBe("pricing-test");
    expect(Object.isFrozen(spec)).toBe(true);
  });

  test("rejects unknown fields, overlap, ineligible dimensions, and empty hypotheses", () => {
    expect(() => parseStudySpec({ ...SPEC, extra: 1 })).toThrow("unknown field at spec: extra");
    expect(() => parseStudySpec({
      ...SPEC,
      holdoutCaseIds: ["fixture-bounded-queue"],
    })).toThrow("holdout case fixture-bounded-queue overlaps the benchmark set");
    expect(() => parseStudySpec({
      ...SPEC,
      variedParameters: [{ dimensionId: "verbosity", values: [1, 2] }],
    })).toThrow("varied dimension verbosity is not matrix-eligible");
    expect(() => parseStudySpec({ ...SPEC, hypotheses: [] })).toThrow(
      "hypotheses must be a non-empty string array",
    );
    expect(() => parseStudySpec({
      ...SPEC,
      variedParameters: [{ dimensionId: "thinkingLevel", values: ["low"] }],
    })).toThrow("varied dimension thinkingLevel needs at least two values");
  });

  test("hashes canonically and stamps every run ID with the spec hash", () => {
    const spec = parseStudySpec(structuredClone(SPEC));
    const hash = studySpecHash(spec);

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(studySpecHash(parseStudySpec(structuredClone(SPEC)))).toBe(hash);

    const caseHash = "c".repeat(64);
    const runId = studyRunId(spec, {
      caseId: "fixture-bounded-queue",
      caseHash,
      point: { thinkingLevel: "low" },
      repetition: 2,
    });
    expect(runId).toBe(
      `study-thinking-sweep:${hash.slice(0, 12)}:fixture-bounded-queue:`
      + `${caseHash.slice(0, 12)}:thinkingLevel="low":rep2`,
    );
    // The variant key derives from a validated point, never from caller text.
    expect(() => studyRunId(spec, {
      caseId: "fixture-bounded-queue",
      caseHash,
      point: { nonsense: true },
      repetition: 0,
    })).toThrow("parameter point must cover exactly the varied dimensions");
    expect(() => studyRunId(spec, {
      caseId: "fixture-bounded-queue",
      caseHash,
      point: { thinkingLevel: "medium" },
      repetition: 0,
    })).toThrow("point value for thinkingLevel is not among the declared values");
    expect(() => studyRunId(spec, {
      caseId: "unknown-case",
      caseHash,
      point: { thinkingLevel: "low" },
      repetition: 0,
    })).toThrow("caseId unknown-case is not part of the study");
    expect(() => studyRunId(spec, {
      caseId: "fixture-bounded-queue",
      caseHash,
      point: { thinkingLevel: "low" },
      repetition: 3,
    })).toThrow("repetition must be an integer from 0 to 2");
  });

  test("rejects an uncommitted spec unless development mode is explicit", () => {
    const spec = parseStudySpec(structuredClone(SPEC));

    expect(() => {
      assertPreregisteredStudy(spec, {});
    }).toThrow("study spec must be committed in a clean worktree before execution");
    expect(() => {
      assertPreregisteredStudy(spec, { commit: "abc", cleanWorktree: false });
    }).toThrow("study spec must be committed in a clean worktree before execution");

    const development = assertPreregisteredStudy(spec, { allowNonPreregistered: true });
    expect(development.mode).toBe("development");
    const attested = assertPreregisteredStudy(spec, { commit: "abc123", cleanWorktree: true });
    expect(attested).toEqual({
      specHash: studySpecHash(spec),
      mode: "preregistered",
      commit: "abc123",
      cleanWorktree: true,
    });
  });
});
