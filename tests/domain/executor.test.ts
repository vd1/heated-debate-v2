import { describe, expect, test } from "bun:test";

import { artifactPathForRun, executeMatrix, executeStudyRuns } from "../../src/domain/executor";
import { parseStudySpec, studySpecHash, type StudySpec } from "../../src/domain/study-spec";
import type { RunSpecification } from "../../src/domain/matrix";

function run(n: number): RunSpecification {
  return {
    purpose: "selection",
    runId: `study:abc123def456:case-${String(n)}:cafecafecafe:thinkingLevel="low":rep0`,
    specHash: "a".repeat(64),
    caseId: `case-${String(n)}`,
    caseHash: "c".repeat(64),
    holdout: false,
    variantKey: 'thinkingLevel="low"',
    parameters: { thinkingLevel: "low" },
    repetition: 0,
  };
}

const RUNS = [run(1), run(2), run(3), run(4)];
const id = (n: number): string => run(n).runId;

describe("matrix executor", () => {
  test("maps run IDs to deterministic artifact paths", () => {
    const path = artifactPathForRun(run(1));
    expect(path).toMatch(
      /^study\/abc123def456\/case-1\/thinkingLevel=_low_\/rep0-[0-9a-f]{64}\.jsonl$/,
    );
    // Sanitization is lossy, so distinct variant keys keep distinct paths.
    const slash = artifactPathForRun({
      ...run(1),
      runId: "study:abc123def456:case-1:cafecafecafe:x=a/b:rep0",
      variantKey: "x=a/b",
    });
    const underscore = artifactPathForRun({
      ...run(1),
      runId: "study:abc123def456:case-1:cafecafecafe:x=a_b:rep0",
      variantKey: "x=a_b",
    });
    expect(slash).not.toBe(underscore);
  });

  test("bounds concurrency and reports results in input order", async () => {
    let active = 0;
    let peak = 0;
    const report = await executeMatrix({
      runs: RUNS,
      concurrency: 2,
      execute: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
      },
    });

    expect(peak).toBe(2);
    expect(report.executed).toEqual(RUNS.map((item) => item.runId));
    expect(report.failed).toEqual([]);
  });

  test("continues after an individual run failure and records it", async () => {
    const report = await executeMatrix({
      runs: RUNS,
      execute: (item) => item.caseId === "case-2"
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(),
    });

    expect(report.executed).toEqual([id(1), id(3), id(4)]);
    expect(report.failed).toEqual([{ runId: id(2), message: "boom" }]);
    expect(report.stopped).toBeUndefined();
  });

  test("stops at consecutive-failure and total-run limits", async () => {
    const failing = await executeMatrix({
      runs: RUNS,
      maxConsecutiveFailures: 2,
      execute: () => Promise.reject(new Error("down")),
    });
    expect(failing.failed).toHaveLength(2);
    expect(failing.stopped).toBe("2 consecutive failures reached the stopping rule");

    const capped = await executeMatrix({
      runs: RUNS,
      maxTotalRuns: 3,
      execute: () => Promise.resolve(),
    });
    expect(capped.executed).toHaveLength(3);
    expect(capped.skipped).toEqual([id(4)]);
    expect(capped.stopped).toBe("study budget of 3 total runs exhausted");
  });

  test("skips completed run IDs and resumes to completion", async () => {
    const first = await executeMatrix({
      runs: RUNS,
      maxTotalRuns: 2,
      execute: () => Promise.resolve(),
    });
    const completed = new Set(first.executed);

    const resumed = await executeMatrix({
      runs: RUNS,
      completedRunIds: completed,
      execute: () => Promise.resolve(),
    });

    expect(resumed.skipped).toEqual([...completed]);
    expect(resumed.executed).toEqual([id(3), id(4)]);
  });
});

describe("study-bound execution", () => {
  const SPEC_JSON = {
    specVersion: "1",
    studyId: "study",
    hypotheses: ["h"],
    benchmarkCaseIds: ["case-1", "case-2", "case-3", "case-4"],
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
    failureHandling: "stop-after-max-consecutive",
    unknownCostPolicy: "fail-closed",
    rewardScalarization: { rewardId: "reward", rewardVersion: "1" },
    budgets: { perRun: { maxTurns: 4, maxTokens: 1_000 }, maxTotalRuns: 3 },
    stoppingRules: { maxRuns: 4, maxConsecutiveFailures: 2 },
    plannedAnalysis: "a",
    reliabilityThresholds: {
      minimumSampleCount: 1, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
    },
  };

  function studyFixture(): { spec: StudySpec; runs: RunSpecification[] } {
    const spec = parseStudySpec(structuredClone(SPEC_JSON));
    const specHash = studySpecHash(spec);
    const runs = [1, 2, 3, 4].map((n) => ({
      ...run(n),
      specHash,
    }));
    return { spec, runs };
  }

  test("counts validated prior completions toward the study run budget", async () => {
    const { spec, runs } = studyFixture();
    const executed: string[] = [];

    const report = await executeStudyRuns({
      spec,
      runs,
      readArtifactState: (item) => Promise.resolve(
        item.caseId === "case-1" || item.caseId === "case-2" ? "completed" : "absent",
      ),
      execute: (item) => {
        executed.push(item.runId);
        return Promise.resolve();
      },
    });

    // maxTotalRuns 3 minus two validated completions leaves one run.
    expect(executed).toHaveLength(1);
    expect(report.skipped).toContain(runs[3]?.runId ?? "");
    expect(report.stopped).toContain("study budget");
  });

  test("rejects invalid artifacts, foreign specs, and claimed runs", async () => {
    const { spec, runs } = studyFixture();

    let caught: unknown;
    try {
      await executeStudyRuns({
        spec,
        runs,
        readArtifactState: () => Promise.resolve("invalid"),
        execute: () => Promise.resolve(),
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("failed validation");

    let foreign: unknown;
    try {
      await executeStudyRuns({
        spec,
        runs: runs.slice(0, 1).map((item) => ({ ...item, specHash: "b".repeat(64) })),
        readArtifactState: () => Promise.resolve("absent"),
        execute: () => Promise.resolve(),
      });
    } catch (error) {
      foreign = error;
    }
    expect(String(foreign)).toContain("different study spec");

    const claimed = await executeStudyRuns({
      spec,
      runs: runs.slice(0, 1),
      readArtifactState: () => Promise.resolve("absent"),
      claim: () => Promise.resolve(false),
      execute: () => Promise.resolve(),
    });
    expect(claimed.failed[0]?.message).toContain("already claimed");
  });

  test("spec failure handling stops scheduling at the threshold", async () => {
    const { spec, runs } = studyFixture();

    const report = await executeStudyRuns({
      spec,
      runs,
      readArtifactState: () => Promise.resolve("absent"),
      execute: () => Promise.reject(new Error("down")),
    });

    expect(report.failed).toHaveLength(2);
    expect(report.stopped).toContain("consecutive failures");
  });
});
