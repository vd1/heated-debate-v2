import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ENGINE_SCHEMA_VERSION, type EngineInput } from "../../src/domain/engine-schema";
import { parseStudySpec } from "../../src/domain/study-spec";
import { runEngineTrial } from "../../src/infrastructure/engine-client";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-bridge",
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
    minimumSampleCount: 1, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
  },
};

const workdir = await mkdtemp(join(tmpdir(), "heated-bridge-"));

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

async function fakeEngine(name: string, body: string): Promise<string> {
  const path = join(workdir, name);
  await writeFile(path, body);
  return path;
}

function input(): EngineInput {
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    spec: parseStudySpec(structuredClone(SPEC_JSON)),
    run: { runId: "run-1", caseId: "c1", point: { thinkingLevel: "low" }, repetition: 0 },
  };
}

describe("engine trial client", () => {
  test("crosses the process boundary and parses a conformant reward line", async () => {
    const engine = await fakeEngine("good.ts", `
      const text = await Bun.stdin.text();
      const parsed = JSON.parse(text);
      if (parsed.schemaVersion !== "1") throw new Error("bad input");
      process.stderr.write("diagnostic noise\\n");
      process.stdout.write(JSON.stringify({
        schemaVersion: "1",
        status: "reward",
        reward: {
          rewardVersion: "1", rewardId: "reward", status: "known",
          vector: {
            qualityTerm: 1, tokenCostTerm: 0, latencyTerm: 0,
            failureTerm: 0, varianceTerm: 0, monetaryTerm: 0,
          },
          scalar: 1,
        },
      }) + "\\n");
    `);

    const result = await runEngineTrial({ command: ["bun", engine], input: input() });

    expect(result.exitCode).toBe(0);
    if (result.output.status !== "reward") throw new Error(result.output.status);
    expect(result.output.reward.status).toBe("known");
    expect(result.stderr).toContain("diagnostic noise");
  }, 15_000);

  test("rejects malformed engine output as a typed error", async () => {
    const engine = await fakeEngine("malformed.ts", `
      process.stdout.write("this is not the contract\\n");
    `);

    let caught: unknown;
    try {
      await runEngineTrial({ command: ["bun", engine], input: input() });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("no valid contract output");
  }, 15_000);

  test("rejects missing output and multi-line stdout", async () => {
    const silent = await fakeEngine("silent.ts", "process.exit(3);");
    let missing: unknown;
    try {
      await runEngineTrial({ command: ["bun", silent], input: input() });
    } catch (error) {
      missing = error;
    }
    expect(String(missing)).toContain("exit 3");

    const chatty = await fakeEngine("chatty.ts", `
      process.stdout.write(JSON.stringify({
        schemaVersion: "1",
        status: "failure",
        failure: { code: "x", message: "y" },
      }) + "\\n");
      process.stdout.write("stray second line\\n");
    `);
    let framed: unknown;
    try {
      await runEngineTrial({ command: ["bun", chatty], input: input() });
    } catch (error) {
      framed = error;
    }
    expect(String(framed)).toContain("exactly one line");
  }, 15_000);

  test("passes structured failures through unchanged", async () => {
    const failing = await fakeEngine("failing.ts", `
      process.stdout.write(JSON.stringify({
        schemaVersion: "1",
        status: "failure",
        failure: { code: "turn_budget_exhausted", message: "stopped" },
      }) + "\\n");
      process.exit(1);
    `);

    const result = await runEngineTrial({ command: ["bun", failing], input: input() });

    expect(result.exitCode).toBe(1);
    if (result.output.status !== "failure") throw new Error(result.output.status);
    expect(result.output.failure.code).toBe("turn_budget_exhausted");
  }, 15_000);
});
