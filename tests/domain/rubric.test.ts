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
    }));
    if (outcome.status !== "valid") throw new Error(outcome.status);
    expect(outcome.dimensions.specificity?.score).toBe(4);
    expect(outcome.dimensions.verbosity?.score).toBe(2);
  });

  test("reports malformed output with a typed reason", () => {
    expect(parseJudgeOutput(rubric, "not json").status).toBe("malformed");
    const noDimensions = parseJudgeOutput(rubric, JSON.stringify({ scores: {} }));
    if (noDimensions.status !== "malformed") throw new Error(noDimensions.status);
    expect(noDimensions.reason).toContain("dimensions object");
  });

  test("missing or invalid dimensions never become zero", () => {
    const outcome = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 9, evidence: "quote" },
        verbosity: { score: 3 },
      },
    }));
    if (outcome.status !== "partial") throw new Error(outcome.status);
    expect(outcome.dimensions.specificity).toBeUndefined();
    expect(outcome.dimensions.verbosity?.score).toBe(3);
    expect(outcome.missing).toEqual([
      { dimensionId: "specificity", reason: "score must be an integer in [1, 5]" },
    ]);

    const noEvidence = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: { specificity: { score: 4 }, verbosity: { score: 3 } },
    }));
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
    declaredInputs: ["run-1.jsonl"],
    messages: [{ role: "user" as const, content: "Score this transcript." }],
  };

  test("links rubric and artifact hashes with the exact judge inputs", () => {
    const outcome = parseJudgeOutput(rubric, JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "q" },
        verbosity: { score: 2 },
      },
    }));
    const recordValue = createEvaluationRecord({ ...BASE, rawResponse: "raw", outcome });

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

  test("requires an outcome or failure and a valid artifact hash", () => {
    expect(() => createEvaluationRecord(BASE)).toThrow(
      "an evaluation record requires an outcome or a sanitized failure",
    );
    expect(() => createEvaluationRecord({
      ...BASE,
      sourceArtifact: { runId: "run-1", artifactHash: "short" },
      failure: { code: "x", message: "y" },
    })).toThrow("sourceArtifact.artifactHash must be a sha256 hex digest");
  });
});
