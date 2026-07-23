import { describe, expect, test } from "bun:test";

import { ScriptedAgent, type AgentTrace } from "../../src/domain/agent";
import { runDebate } from "../../src/domain/debate";
import {
  canonicalExperimentConfigJson,
  experimentConfigHash,
  experimentDebateInput,
  parseExperimentConfig,
} from "../../src/domain/experiment-config";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";

const MINIMAL = {
  configVersion: "1",
  runId: "run-config-1",
  topic: "Design a queue.",
  roundCount: 2,
};

describe("parseExperimentConfig", () => {
  test("materializes defaults for a minimal untrusted config", () => {
    const config = parseExperimentConfig(JSON.parse(JSON.stringify(MINIMAL)));

    expect(config.configVersion).toBe("1");
    expect(config.topic).toBe("Design a queue.");
    expect(config.roundCount).toBe(2);
    expect(config.contextPolicy).toEqual({ policyId: "last-exchange", policyVersion: "1" });
    expect(config.proposer.role).toEqual(PROPOSER_ROLE);
    expect(config.reviewer.role).toEqual(REVIEWER_ROLE);
    for (const assignment of [config.proposer, config.reviewer]) {
      expect(assignment.controls.model).toEqual({
        providerId: "openai-codex",
        modelId: "gpt-5.6-sol",
      });
      expect(assignment.controls.thinkingLevel).toBe("high");
    }
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.proposer.controls)).toBe(true);
  });

  test("rejects unknown fields, versions, and non-object payloads", () => {
    expect(() => parseExperimentConfig({ ...MINIMAL, configVersion: "2" })).toThrow(
      "unsupported configVersion: 2",
    );
    expect(() => parseExperimentConfig({ ...MINIMAL, extra: 1 })).toThrow(
      "unknown field at config: extra",
    );
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      proposer: { controls: { modell: {} } },
    })).toThrow("unknown field at config.proposer.controls: modell");
    expect(() => parseExperimentConfig("not an object")).toThrow(
      "config must be a JSON object",
    );
  });

  test("keeps explicit values distinct from omitted defaults and applies per-role overrides", () => {
    const config = parseExperimentConfig({
      ...MINIMAL,
      controls: { thinkingLevel: "low", temperature: 0.5 },
      reviewer: { controls: { model: { providerId: "local", modelId: "gemma-3-27b" } } },
    });

    // Config-level explicit values apply to both roles.
    expect(config.proposer.controls.thinkingLevel).toBe("low");
    expect(config.proposer.controls.temperature).toBe(0.5);
    // Omitted model falls back to the default for the proposer.
    expect(config.proposer.controls.model.modelId).toBe("gpt-5.6-sol");
    // Per-role override wins over both default and config-level values.
    expect(config.reviewer.controls.model).toEqual({
      providerId: "local",
      modelId: "gemma-3-27b",
    });
    expect(config.reviewer.controls.thinkingLevel).toBe("low");
  });

  test("enforces cross-field constraints", () => {
    expect(() => parseExperimentConfig({ ...MINIMAL, roundCount: 0 })).toThrow(
      "roundCount must be a positive integer",
    );
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      controls: { temperature: 3 },
    })).toThrow("temperature must be between 0 and 2");
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      budget: { maxTokens: 100 },
    })).toThrow("budget.maxTurns must be a non-negative integer");
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      wholeRunTimeoutMs: 10,
      turnTimeoutMs: 50,
    })).toThrow("wholeRunTimeoutMs must not be smaller than turnTimeoutMs");
  });

  test("rejects fractional, unsafe, and unrepresentable numeric fields", () => {
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      roundCount: Number.MAX_SAFE_INTEGER + 1,
    })).toThrow("roundCount must be a positive integer");
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      controls: { maxOutputTokens: Number.MAX_SAFE_INTEGER + 1 },
    })).toThrow("maxOutputTokens must be a positive integer");
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      budget: { maxTurns: 2, maxTokens: 0.5 },
    })).toThrow("budget.maxTokens must be a non-negative safe integer");
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      budget: {
        maxTurns: 2,
        maxTokens: 100,
        monetary: {
          maxAmount: 0.1234567,
          snapshot: {
            snapshotId: "s", snapshotVersion: "1", currency: "USD",
            effectiveDate: "2026-07-01", provenance: "p",
            entries: [{
              model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
              inputRatePerMillionTokens: 1, outputRatePerMillionTokens: 1,
              cacheReadRatePerMillionTokens: 0, cacheWriteRatePerMillionTokens: 0,
              reasoningBilling: { mode: "included-in-output" },
            }],
          },
        },
      },
    })).toThrow("budget.monetary.maxAmount must have at most 6 decimal places");
  });

  test("requires monetary snapshots to price both assigned models", () => {
    const snapshot = {
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
    const valid = parseExperimentConfig({
      ...MINIMAL,
      budget: {
        maxTurns: 4,
        maxTokens: 1_000_000,
        monetary: { maxAmount: 5, snapshot },
      },
    });
    expect(valid.budget?.monetary?.snapshot.snapshotId).toBe("pricing-test");

    expect(() => parseExperimentConfig({
      ...MINIMAL,
      reviewer: { controls: { model: { providerId: "local", modelId: "gemma-3-27b" } } },
      budget: {
        maxTurns: 4,
        maxTokens: 1_000_000,
        monetary: { maxAmount: 5, snapshot },
      },
    })).toThrow("no pricing entry for local/gemma-3-27b");
  });

  test("distinguishes omitted controls from explicit defaults in canonical identity", () => {
    const omitted = parseExperimentConfig(structuredClone(MINIMAL));
    const explicit = parseExperimentConfig({
      ...MINIMAL,
      controls: {
        model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
        thinkingLevel: "high",
      },
      contextPolicy: { policyId: "last-exchange", policyVersion: "1" },
    });

    // Both resolve to identical execution values...
    expect(explicit.proposer.controls).toEqual(omitted.proposer.controls);
    // ...but their canonical identity differs because the sources differ.
    expect(canonicalExperimentConfigJson(explicit))
      .not.toBe(canonicalExperimentConfigJson(omitted));
    expect(experimentConfigHash(explicit)).not.toBe(experimentConfigHash(omitted));
  });

  test("records protocol and creativity schedule identity and routes them to the scheduler", () => {
    const config = parseExperimentConfig({
      ...MINIMAL,
      protocol: { protocolId: "proposer-reviewer", protocolVersion: "1" },
      creativitySchedule: { scheduleId: "linear-cooling", scheduleVersion: "1" },
    });

    expect(config.protocol).toEqual({ protocolId: "proposer-reviewer", protocolVersion: "1" });
    expect(config.creativitySchedule).toEqual({
      scheduleId: "linear-cooling",
      scheduleVersion: "1",
    });
    // Defaults resolve to the same identities when omitted.
    const defaulted = parseExperimentConfig(structuredClone(MINIMAL));
    expect(defaulted.protocol).toEqual(config.protocol);
    expect(defaulted.creativitySchedule).toEqual(config.creativitySchedule);
    // Unsupported identities are rejected, not silently replaced.
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      creativitySchedule: { scheduleId: "step", scheduleVersion: "1" },
    })).toThrow("creativitySchedule must be linear-cooling@1");
    expect(() => parseExperimentConfig({
      ...MINIMAL,
      protocol: { protocolId: "panel", protocolVersion: "1" },
    })).toThrow("protocol must be proposer-reviewer@1");

    const input = experimentDebateInput(config, {
      proposer: new ScriptedAgent([]),
      reviewer: new ScriptedAgent([]),
    });
    expect(input.creativitySchedule).toEqual(config.creativitySchedule);
  });

  test("round-trips canonically and hashes deterministically", () => {
    const config = parseExperimentConfig({
      ...MINIMAL,
      controls: { thinkingLevel: "low" },
    });

    const json = canonicalExperimentConfigJson(config);
    const reparsed = parseExperimentConfig(JSON.parse(json));

    expect(reparsed).toEqual(config);
    expect(canonicalExperimentConfigJson(reparsed)).toBe(json);
    expect(experimentConfigHash(config)).toMatch(/^[0-9a-f]{64}$/);
    expect(experimentConfigHash(reparsed)).toBe(experimentConfigHash(config));
    expect(experimentConfigHash(parseExperimentConfig(MINIMAL)))
      .not.toBe(experimentConfigHash(config));
  });
});

describe("experimentDebateInput", () => {
  test("maps the config onto a runnable debate whose budget counts retries", async () => {
    const config = parseExperimentConfig({
      ...MINIMAL,
      roundCount: 1,
      controls: { model: { providerId: "test", modelId: "model" } },
      budget: { maxTurns: 4, maxTokens: 100 },
    });
    const retryTrace: AgentTrace = {
      attempts: [
        {
          attempt: 1,
          status: "failed",
          httpStatus: 429,
          usage: { inputTokens: 60, outputTokens: 0 },
          usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
        },
        {
          attempt: 2,
          status: "succeeded",
          httpStatus: 200,
          usage: { inputTokens: 60, outputTokens: 0 },
          usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
        },
      ],
    };
    const scripted = () => new ScriptedAgent([{
      text: "Reply",
      durationMs: 1,
      model: { providerId: "test", modelId: "model" },
      controls: {
        model: {
          requested: { providerId: "test", modelId: "model" },
          forwarded: { providerId: "test", modelId: "model" },
        },
        thinkingLevel: { requested: "high", forwarded: "high" },
      },
      usage: { values: {}, explicitlyReported: [] },
      trace: retryTrace,
    }, {
      text: "Reply 2",
      durationMs: 1,
      model: { providerId: "test", modelId: "model" },
      controls: {
        model: {
          requested: { providerId: "test", modelId: "model" },
          forwarded: { providerId: "test", modelId: "model" },
        },
        thinkingLevel: { requested: "high", forwarded: "high" },
      },
      usage: { values: {}, explicitlyReported: [] },
      trace: retryTrace,
    }]);

    const input = experimentDebateInput(config, {
      proposer: scripted(),
      reviewer: scripted(),
    });

    expect(input.debateId).toBe("run-config-1");
    expect(input.topic).toBe("Design a queue.");
    expect(input.proposer.role).toEqual(PROPOSER_ROLE);
    expect(input.proposer.controls.model).toEqual({ providerId: "test", modelId: "model" });

    // Retry-inclusive accounting: two attempts of 60 input tokens exceed 100
    // after the first turn even though the successful attempt alone would not.
    let caught: unknown;
    try {
      await runDebate(input);
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("token_budget_exhausted");
  });
});
