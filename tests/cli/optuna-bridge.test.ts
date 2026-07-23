import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_CASES } from "../../src/domain/cases";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-bridge-e2e",
  hypotheses: ["h"],
  benchmarkCaseIds: ["fixture-bounded-queue"],
  holdoutCaseIds: [],
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
  holdoutUsePolicy: "never",
  failureHandling: "record-and-continue",
  unknownCostPolicy: "fail-closed",
  rewardScalarization: { rewardId: "reward", rewardVersion: "1" },
  budgets: { perRun: { maxTurns: 4, maxTokens: 100_000 } },
  stoppingRules: { maxRuns: 8 },
  plannedAnalysis: "a",
  reliabilityThresholds: {
    minimumSampleCount: 1, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
  },
};

const uv = Bun.which("uv");
const workdir = await mkdtemp(join(tmpdir(), "heated-bridge-e2e-"));

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

describe("optuna bridge end to end", () => {
  if (uv === null) {
    test.skip("requires uv on PATH", () => {});
    return;
  }
  test("runs real trials through the spawned engine", async () => {
    const specPath = join(workdir, "spec.json");
    const casesPath = join(workdir, "cases.json");
    await writeFile(specPath, JSON.stringify(SPEC_JSON));
    await writeFile(casesPath, JSON.stringify(FIXTURE_CASES));

    const proc = Bun.spawn({
      cmd: [
        uv, "run", "--with", "optuna", "bridge/optuna_bridge.py",
        "--spec", specPath,
        "--cases", casesPath,
        "--engine", "bun src/cli/engine.ts --allow-non-preregistered",
        "--artifact-root", join(workdir, "artifacts"),
        "--trials", "2",
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(code, stderr).toBe(0);
    const lastLine = stdout.trim().split("\n").at(-1) ?? "";
    const summary = JSON.parse(lastLine) as { bestParams: unknown; bestValue: number };
    expect(typeof summary.bestValue).toBe("number");
    expect(Number.isFinite(summary.bestValue)).toBe(true);
  }, 180_000);
});
