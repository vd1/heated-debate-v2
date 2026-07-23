import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_CASES } from "../../src/domain/cases";
import { studySpecHash, parseStudySpec } from "../../src/domain/study-spec";
import { runBoundedStudy, type StudyTrial } from "../../src/infrastructure/study-driver";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-driver",
  hypotheses: ["Higher thinking helps."],
  benchmarkCaseIds: ["fixture-bounded-queue"],
  holdoutCaseIds: ["fixture-schema-migration"],
  fixedParameters: { roundCount: 1 },
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
  holdoutUsePolicy: "final-evaluation-only",
  failureHandling: "record-and-continue",
  unknownCostPolicy: "fail-closed",
  rewardScalarization: { rewardId: "reward", rewardVersion: "1" },
  budgets: { perRun: { maxTurns: 4, maxTokens: 100_000 } },
  stoppingRules: { maxRuns: 2 },
  plannedAnalysis: "Compare thinking levels.",
  reliabilityThresholds: {
    minimumSampleCount: 1, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
  },
};

const workdir = await mkdtemp(join(tmpdir(), "heated-study-"));
const casesPath = join(workdir, "cases.json");
await writeFile(casesPath, JSON.stringify(FIXTURE_CASES));

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("bounded study driver", () => {
  test("runs the selection matrix through the engine and stamps every trial", async () => {
    const persisted: StudyTrial[] = [];
    const outcome = await runBoundedStudy({
      specText: JSON.stringify(SPEC_JSON),
      casesText: JSON.stringify(FIXTURE_CASES),
      casesPath,
      engineCommand: ["bun", "src/cli/engine.ts", "--agents", "scripted"],
      artifactRoot: join(workdir, "artifacts"),
      evidence: { commit: "studycommit1", cleanWorktree: true },
      persistTrial: (trial) => {
        persisted.push(trial);
        return Promise.resolve();
      },
      timeoutMs: 60_000,
    });

    const spec = parseStudySpec(structuredClone(SPEC_JSON));
    // Two variants, bounded by stoppingRules.maxRuns; holdouts never enter.
    expect(outcome.trials).toHaveLength(2);
    expect(outcome.attestationMode).toBe("preregistered");
    expect(persisted).toHaveLength(2);
    for (const trial of persisted) {
      expect(trial.specHash).toBe(studySpecHash(spec));
      expect(trial.commit).toBe("studycommit1");
      expect(trial.caseId).toBe("fixture-bounded-queue");
      if (trial.output.status !== "reward") throw new Error(trial.output.status);
      expect(trial.output.reward.status).toBe("known");
    }
    expect(new Set(persisted.map((trial) => JSON.stringify(trial.point))).size).toBe(2);
  }, 30_000);

  test("rejects an uncommitted spec without the development flag", async () => {
    let caught: unknown;
    try {
      await runBoundedStudy({
        specText: JSON.stringify(SPEC_JSON),
        casesText: JSON.stringify(FIXTURE_CASES),
        casesPath,
        engineCommand: ["bun", "src/cli/engine.ts", "--agents", "scripted"],
        artifactRoot: join(workdir, "artifacts"),
        evidence: {},
        persistTrial: () => Promise.resolve(),
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("committed in a clean worktree");
  }, 15_000);
});
