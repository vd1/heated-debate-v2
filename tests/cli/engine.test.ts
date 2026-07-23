import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { benchmarkCaseHash, FIXTURE_CASES } from "../../src/domain/cases";
import { ENGINE_SCHEMA_VERSION, parseEngineOutput } from "../../src/domain/engine-schema";
import { parseStudySpec, studyRunId } from "../../src/domain/study-spec";
import { readCanonicalJsonl } from "../../src/infrastructure/jsonl-events";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-cli",
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

const workdir = await mkdtemp(join(tmpdir(), "heated-engine-"));
const casesPath = join(workdir, "cases.json");
await writeFile(casesPath, JSON.stringify(FIXTURE_CASES));

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function engineInput(): string {
  const spec = parseStudySpec(structuredClone(SPEC_JSON));
  const queueCase = FIXTURE_CASES.find((item) => item.caseId === "fixture-bounded-queue");
  if (!queueCase) throw new Error("missing fixture");
  const runId = studyRunId(spec, {
    caseId: "fixture-bounded-queue",
    caseHash: benchmarkCaseHash(queueCase),
    point: { thinkingLevel: "low" },
    repetition: 0,
  });
  return JSON.stringify({
    schemaVersion: ENGINE_SCHEMA_VERSION,
    spec: SPEC_JSON,
    run: { runId, caseId: "fixture-bounded-queue", point: { thinkingLevel: "low" }, repetition: 0 },
  });
}

async function spawnEngine(
  stdin: string,
  extraArgs: readonly string[] = [],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn({
    cmd: [
      "bun", "src/cli/engine.ts",
      "--cases", casesPath,
      "--artifact-root", join(workdir, "artifacts"),
      "--agents", "scripted",
      ...extraArgs,
    ],
    stdin: new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("engine CLI", () => {
  test("executes a run, writes the artifact, and frames one reward line", async () => {
    const { code, stdout, stderr } = await spawnEngine(engineInput(), [
      "--allow-non-preregistered",
      "--attestation-out", join(workdir, "attestation.json"),
    ]);

    expect(code).toBe(0);
    const output = parseEngineOutput(stdout);
    if (output.status !== "reward") throw new Error(output.status);
    expect(output.reward.status).toBe("known");
    // Diagnostics stay on stderr; stdout is exactly the contract line.
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(stderr).toContain("attestation");
    const artifactLine = stderr.split("\n").find((line) => line.startsWith("artifact "));
    if (!artifactLine) throw new Error("missing artifact diagnostic");
    const artifact = await readCanonicalJsonl(artifactLine.slice("artifact ".length));
    expect(artifact.events.at(-1)?.type).toBe("run.completed");
    const attestation = JSON.parse(await Bun.file(join(workdir, "attestation.json")).text()) as {
      mode: string;
    };
    expect(attestation.mode).toBe("development");
  }, 20_000);

  test("stamps the preregistered commit from Git evidence", async () => {
    const { code, stderr } = await spawnEngine(engineInput(), [], {
      HEATED_DEBATE_GIT_COMMIT: "cafe1234",
      HEATED_DEBATE_GIT_CLEAN: "1",
    });
    expect(code).toBe(0);
    expect(stderr).toContain('"mode":"preregistered"');
    expect(stderr).toContain('"commit":"cafe1234"');

    const dirty = await spawnEngine(engineInput(), [], {
      HEATED_DEBATE_GIT_COMMIT: "cafe1234",
      HEATED_DEBATE_GIT_CLEAN: "0",
    });
    expect(dirty.code).toBe(1);
    const output = parseEngineOutput(dirty.stdout);
    if (output.status !== "failure") throw new Error(output.status);
    expect(output.failure.message).toContain("committed in a clean worktree");
  }, 20_000);

  test("rejects malformed input and identity mismatches with exit code 2", async () => {
    const malformed = await spawnEngine("not json", ["--allow-non-preregistered"]);
    expect(malformed.code).toBe(2);
    const output = parseEngineOutput(malformed.stdout);
    if (output.status !== "failure") throw new Error(output.status);
    expect(output.failure.code).toBe("invalid_input");

    const mismatched = await spawnEngine(JSON.stringify({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      spec: structuredClone(SPEC_JSON),
      run: {
        runId: "study-cli:000000000000:fixture-bounded-queue:000000000000:x:rep0",
        caseId: "fixture-bounded-queue",
        point: { thinkingLevel: "low" },
        repetition: 0,
      },
    }), ["--allow-non-preregistered"]);
    expect(mismatched.code).toBe(2);
    const mismatchOutput = parseEngineOutput(mismatched.stdout);
    if (mismatchOutput.status !== "failure") throw new Error(mismatchOutput.status);
    expect(mismatchOutput.failure.code).toBe("run_identity_mismatch");
  }, 20_000);

  test("reports budget exhaustion as a structured failure with exit code 1", async () => {
    const specJson = {
      ...structuredClone(SPEC_JSON),
      budgets: { perRun: { maxTurns: 1, maxTokens: 100_000 } },
    };
    const spec = parseStudySpec(structuredClone(specJson));
    const queueCase = FIXTURE_CASES.find((item) => item.caseId === "fixture-bounded-queue");
    if (!queueCase) throw new Error("missing fixture");
    const runId = studyRunId(spec, {
      caseId: "fixture-bounded-queue",
      caseHash: benchmarkCaseHash(queueCase),
      point: { thinkingLevel: "low" },
      repetition: 0,
    });
    const { code, stdout, stderr } = await spawnEngine(JSON.stringify({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      spec: specJson,
      run: { runId, caseId: "fixture-bounded-queue", point: { thinkingLevel: "low" }, repetition: 0 },
    }), ["--allow-non-preregistered"]);

    expect(code).toBe(1);
    const output = parseEngineOutput(stdout);
    if (output.status !== "failure") throw new Error(output.status);
    expect(output.failure.code).toBe("turn_budget_exhausted");
    // The terminal failure is evidence: its artifact is persisted, not discarded.
    const artifactLine = stderr.split("\n").find((line) => line.startsWith("artifact "));
    if (!artifactLine) throw new Error("missing failure artifact diagnostic");
    const artifact = await readCanonicalJsonl(artifactLine.slice("artifact ".length));
    expect(artifact.events.at(-1)?.type).toBe("run.failed");
  }, 20_000);

  test("emits an interruption failure on SIGTERM", async () => {
    const proc = Bun.spawn({
      cmd: [
        "bun", "src/cli/engine.ts",
        "--cases", casesPath,
        "--artifact-root", join(workdir, "artifacts"),
        "--agents", "hang",
        "--allow-non-preregistered",
      ],
      stdin: new TextEncoder().encode(engineInput()),
      stdout: "pipe",
      stderr: "pipe",
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    proc.kill("SIGTERM");
    const [stdout, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);

    expect(code).toBe(130);
    const output = parseEngineOutput(stdout);
    if (output.status !== "failure") throw new Error(output.status);
    expect(output.failure.code).toBe("interrupted");
  }, 20_000);
});
