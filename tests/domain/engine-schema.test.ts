import { describe, expect, test } from "bun:test";

import {
  ENGINE_SCHEMA_VERSION,
  parseEngineInput,
  parseEngineOutput,
  serializeEngineOutput,
} from "../../src/domain/engine-schema";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-engine",
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

const INPUT = {
  schemaVersion: ENGINE_SCHEMA_VERSION,
  spec: SPEC_JSON,
  run: { runId: "run-1", caseId: "c1", point: { thinkingLevel: "low" }, repetition: 0 },
};

describe("engine schema", () => {
  test("round-trips a valid engine input", () => {
    const parsed = parseEngineInput(JSON.stringify(INPUT));
    expect(parsed.spec.studyId).toBe("study-engine");
    expect(parsed.run).toEqual(INPUT.run);
  });

  test("rejects schema-version mismatch and malformed values", () => {
    expect(() => parseEngineInput(JSON.stringify({ ...INPUT, schemaVersion: "9" }))).toThrow(
      "unsupported engine schema version: 9",
    );
    expect(() => parseEngineInput(JSON.stringify({ ...INPUT, extra: 1 }))).toThrow(
      "unknown field at engine input: extra",
    );
    expect(() => parseEngineInput("not json")).toThrow("engine input is not JSON");
    expect(() => parseEngineInput(JSON.stringify({
      ...INPUT,
      run: { ...INPUT.run, repetition: -1 },
    }))).toThrow("run.repetition must be a non-negative safe integer");
  });

  test("frames exactly one output line and rejects anything else", () => {
    const output = serializeEngineOutput({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      status: "failure",
      failure: { code: "budget_exhausted", message: "stopped" },
    });
    expect(output.endsWith("\n")).toBe(true);
    expect(output.slice(0, -1)).not.toContain("\n");
    expect(parseEngineOutput(output)).toEqual({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      status: "failure",
      failure: { code: "budget_exhausted", message: "stopped" },
    });

    expect(() => parseEngineOutput(`${output}diagnostic noise\n`)).toThrow(
      "engine output must be exactly one line",
    );
    expect(() => parseEngineOutput("")).toThrow("engine output is empty");
    expect(() => parseEngineOutput('{"schemaVersion":"1","status":"mystery"}\n')).toThrow(
      "unknown engine output status: mystery",
    );
  });

  test("round-trips a reward output", () => {
    const output = serializeEngineOutput({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      status: "reward",
      reward: {
        rewardVersion: "1",
        rewardId: "reward",
        configHash: "a".repeat(64),
        status: "known",
        measurements: {
          quality: 0.8,
          tokensUsedFraction: 0.1,
          latencyFraction: 0,
          failed: false,
          variance: 0,
          monetaryFraction: null,
        },
        vector: {
          qualityTerm: 0.8,
          tokenCostTerm: -0.1,
          latencyTerm: 0,
          failureTerm: 0,
          varianceTerm: 0,
          monetaryTerm: 0,
        },
        scalar: 0.7,
      },
    });
    const parsed = parseEngineOutput(output);
    if (parsed.status !== "reward") throw new Error(parsed.status);
    expect(parsed.reward.status).toBe("known");
  });
});
