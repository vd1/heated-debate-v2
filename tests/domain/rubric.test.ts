import { describe, expect, test } from "bun:test";

import {
  createEvaluationRecord,
  evaluationRecordHash,
  parseJudgeOutput,
  parseRubric,
  rubricHash,
} from "../../src/domain/rubric";

const RUBRIC_JSON = {
  rubricVersion: "1",
  rubricId: "debate-quality",
  dimensions: [
    {
      dimensionId: "specificity",
      description: "Concrete, checkable claims.",
      scale: { min: 1, max: 5 },
      direction: "higher-is-better",
      requiredEvidence: "quote",
    },
    {
      dimensionId: "verbosity",
      description: "Unnecessary length.",
      scale: { min: 1, max: 5 },
      direction: "lower-is-better",
      requiredEvidence: "none",
    },
  ],
};

describe("rubric", () => {
  test("parses a validated frozen rubric and hashes canonically", () => {
    const rubric = parseRubric(structuredClone(RUBRIC_JSON));
    expect(rubric.dimensions).toHaveLength(2);
    expect(Object.isFrozen(rubric.dimensions[0])).toBe(true);
    expect(rubricHash(rubric)).toMatch(/^[0-9a-f]{64}$/);
    expect(rubricHash(parseRubric(structuredClone(RUBRIC_JSON)))).toBe(rubricHash(rubric));
  });

  test("rejects unknown fields, duplicates, and invalid scales", () => {
    expect(() => parseRubric({ ...RUBRIC_JSON, extra: 1 })).toThrow("unknown field at rubric: extra");
    expect(() => parseRubric({
      ...RUBRIC_JSON,
      dimensions: [...RUBRIC_JSON.dimensions, RUBRIC_JSON.dimensions[0]],
    })).toThrow("duplicate dimension specificity");
    expect(() => parseRubric({
      ...RUBRIC_JSON,
      dimensions: [{
        ...RUBRIC_JSON.dimensions[0],
        scale: { min: 5, max: 1 },
      }],
    })).toThrow("scale must be integers with max > min");
  });
});

describe("judge output parsing", () => {
  const rubric = parseRubric(structuredClone(RUBRIC_JSON));

  test("accepts a complete valid output", () => {
    const outcome = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "cites the retry budget" },
        verbosity: { score: 2 },
      },
    }), { sourceText: "It cites the retry budget explicitly." });
    if (outcome.status !== "valid") throw new Error(outcome.status);
    expect(outcome.dimensions.specificity?.score).toBe(4);
    expect(outcome.dimensions.verbosity?.score).toBe(2);
  });

  test("reports malformed output with a typed reason", () => {
    expect(parseJudgeOutput(rubric, "not json", { sourceText: "s" }).status).toBe("malformed");
    const noDimensions = parseJudgeOutput(rubric, JSON.stringify({}), { sourceText: "s" });
    if (noDimensions.status !== "malformed") throw new Error(noDimensions.status);
    expect(noDimensions.reason).toContain("dimensions object");
  });

  test("missing or invalid dimensions never become zero", () => {
    const outcome = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 9, evidence: "quote" },
        verbosity: { score: 3 },
      },
    }), { sourceText: "quote" });
    if (outcome.status !== "partial") throw new Error(outcome.status);
    expect(outcome.dimensions.specificity).toBeUndefined();
    expect(outcome.dimensions.verbosity?.score).toBe(3);
    expect(outcome.missing).toEqual([
      { dimensionId: "specificity", reason: "score must be an integer in [1, 5]" },
    ]);

    const noEvidence = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: { specificity: { score: 4 }, verbosity: { score: 3 } },
    }), { sourceText: "quote" });
    if (noEvidence.status !== "partial") throw new Error(noEvidence.status);
    expect(noEvidence.missing[0]?.reason).toBe("required quote evidence is missing");
  });
});

describe("evaluation record", () => {
  const rubric = parseRubric(structuredClone(RUBRIC_JSON));
  const BASE = {
    rubric,
    sourceArtifact: { runId: "run-1", artifactHash: "a".repeat(64) },
    judge: { evaluatorId: "judge-default", evaluatorVersion: "1" },
    declaredInputs: ["run-1"],
    messages: [{ role: "user" as const, content: "Score this transcript." }],
    sourceText: "q",
  };

  test("links rubric and artifact hashes and derives the outcome from the raw response", () => {
    const rawResponse = JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "q" },
        verbosity: { score: 2 },
      },
    });
    const recordValue = createEvaluationRecord({ ...BASE, rawResponse });

    expect(recordValue.outcome?.status).toBe("valid");
    expect(recordValue.rubric.rubricHash).toBe(rubricHash(rubric));
    expect(recordValue.sourceArtifact.artifactHash).toBe("a".repeat(64));
    expect(recordValue.failure).toBeNull();
    expect(Object.isFrozen(recordValue)).toBe(true);
    expect(evaluationRecordHash(recordValue)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("preserves the raw response beside a sanitized failure", () => {
    const recordValue = createEvaluationRecord({
      ...BASE,
      rawResponse: "unparseable text",
      failure: { code: "judge_parse_failure", message: "no JSON found" },
    });
    expect(recordValue.rawResponse).toBe("unparseable text");
    expect(recordValue.outcome).toBeNull();
    expect(recordValue.failure?.code).toBe("judge_parse_failure");
  });

  test("requires a raw response or failure and a valid artifact hash", () => {
    expect(() => createEvaluationRecord(BASE)).toThrow(
      "an evaluation record requires a raw response or a sanitized failure",
    );
    expect(() => createEvaluationRecord({
      ...BASE,
      sourceArtifact: { runId: "run-1", artifactHash: "short" },
      failure: { code: "x", message: "y" },
    })).toThrow("sourceArtifact.artifactHash must be a sha256 hex digest");
  });
});

describe("exact judge-output schema and record integrity", () => {
  const rubric = parseRubric(structuredClone(RUBRIC_JSON));

  test("reports unknown outer fields, undeclared dimensions, and entry fields", () => {
    const unknownOuter = parseJudgeOutput(rubric, JSON.stringify({
      extra: "ignored",
      dimensions: {},
    }), { sourceText: "q" });
    if (unknownOuter.status !== "malformed") throw new Error(unknownOuter.status);
    expect(unknownOuter.reason).toBe("unknown field at judge output: extra");

    const undeclared = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "q" },
        verbosity: { score: 2 },
        undeclared: { score: 5 },
      },
    }), { sourceText: "q" });
    if (undeclared.status !== "partial") throw new Error(undeclared.status);
    expect(undeclared.missing).toEqual([
      { dimensionId: "undeclared", reason: "dimension is not declared by the rubric" },
    ]);

    const entryField = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "q", extra: 1 },
        verbosity: { score: 2 },
      },
    }), { sourceText: "q" });
    if (entryField.status !== "partial") throw new Error(entryField.status);
    expect(entryField.missing[0]?.reason).toBe("unknown field extra in dimension entry");
  });

  test("rejects fabricated quote evidence against the declared source", () => {
    const outcome = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "invented words" },
        verbosity: { score: 2 },
      },
    }), { sourceText: "The transcript never says that." });
    if (outcome.status !== "partial") throw new Error(outcome.status);
    expect(outcome.missing[0]?.reason).toBe(
      "quote evidence does not appear in the declared source",
    );
  });

  test("a forged outcome cannot enter the record and states are exclusive", () => {
    const base = {
      rubric,
      sourceArtifact: { runId: "run-1", artifactHash: "a".repeat(64) },
      judge: { evaluatorId: "judge-default", evaluatorVersion: "1" },
      declaredInputs: ["run-1"],
      messages: [{ role: "user" as const, content: "Score this." }],
      sourceText: "q",
    };
    // The outcome is derived from the raw response, so it matches parsing exactly.
    const recordValue = createEvaluationRecord({ ...base, rawResponse: "not json" });
    expect(recordValue.outcome?.status).toBe("malformed");

    expect(() => createEvaluationRecord({
      ...base,
      declaredInputs: ["run-1", "run-1"],
      rawResponse: "{}",
    })).toThrow("duplicate declared input run-1");
    expect(() => createEvaluationRecord({
      ...base,
      messages: [{ role: "user" as const, content: "" }],
      rawResponse: "{}",
    })).toThrow("messages must be user/assistant entries with non-empty content");
    expect(() => createEvaluationRecord({
      ...base,
      controls: {
        model: { providerId: "test", modelId: "m" },
        thinkingLevel: "cold" as never,
      },
      rawResponse: "{}",
    })).toThrow("thinkingLevel is invalid");

    // A failure record carries no parsed outcome even when a raw response exists.
    const failed = createEvaluationRecord({
      ...base,
      rawResponse: "partial text",
      failure: { code: "judge_timeout", message: "timed out" },
    });
    expect(failed.outcome).toBeNull();
    expect(failed.failure?.code).toBe("judge_timeout");
  });
});

describe("evidence declaration and record control hardening", () => {
  const rubric = parseRubric(structuredClone(RUBRIC_JSON));
  const base = {
    rubric,
    sourceArtifact: { runId: "run-1", artifactHash: "a".repeat(64) },
    judge: { evaluatorId: "judge-default", evaluatorVersion: "1" },
    declaredInputs: ["run-1"],
    messages: [{ role: "user" as const, content: "Score this." }],
    sourceText: "q",
  };

  test("requires the declared source whenever the rubric demands quotes", () => {
    expect(() => parseJudgeOutput(rubric, "{}")).toThrow("sourceText");
  });

  test("rejects present evidence that is not a verbatim string", () => {
    const outcome = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "q" },
        verbosity: { score: 2, evidence: 3 },
      },
    }), { sourceText: "q" });
    if (outcome.status !== "partial") throw new Error(outcome.status);
    expect(outcome.dimensions.verbosity).toBeUndefined();
    expect(outcome.missing[0]?.reason).toContain("verbatim string");
  });

  test("rejects duplicate keys instead of accepting the last value", () => {
    const raw = '{"dimensions": {"specificity": {"score": 4, "score": 5, "evidence": "q"},'
      + ' "verbosity": {"score": 2}}}';
    const outcome = parseJudgeOutput(rubric, raw, { sourceText: "q" });
    if (outcome.status !== "malformed") throw new Error(outcome.status);
    expect(outcome.reason).toContain("duplicate");
  });

  test("validates requested controls with the exact canonical parser", () => {
    expect(() => createEvaluationRecord({
      ...base,
      controls: {
        model: { providerId: "test", modelId: "m" },
        thinkingLevel: "high" as const,
        temperature: Number.NaN,
      },
      rawResponse: "{}",
    })).toThrow("temperature");
    expect(() => createEvaluationRecord({
      ...base,
      controls: {
        model: { providerId: "test", modelId: "m" },
        thinkingLevel: "high" as const,
        maxOutputTokens: -5,
      },
      rawResponse: "{}",
    })).toThrow("maxOutputTokens");
  });

  test("rejects undeclared message fields", () => {
    expect(() => createEvaluationRecord({
      ...base,
      messages: [{ role: "user", content: "x", extra: 1 } as never],
      rawResponse: "{}",
    })).toThrow("message");
  });

  test("declared inputs must reference the source artifact", () => {
    expect(() => createEvaluationRecord({
      ...base,
      declaredInputs: ["some-unrelated-run"],
      rawResponse: "{}",
    })).toThrow("does not reference the source artifact");
  });
});
