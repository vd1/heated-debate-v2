import { describe, expect, test } from "bun:test";

import {
  benchmarkCaseHash,
  FIXTURE_CASES,
  parseBenchmarkCase,
} from "../../src/domain/cases";

const MINIMAL = {
  caseVersion: "1",
  caseId: "case-queue",
  topic: "Design a bounded queue with backpressure.",
  rubric: { rubricId: "debate-quality", rubricVersion: "1" },
  provenance: "hand-written fixture, 2026-07-23",
};

describe("benchmark cases", () => {
  test("parses a validated frozen case with optional source context", () => {
    const parsed = parseBenchmarkCase({
      ...MINIMAL,
      sourceContext: "The queue backs a realtime ingest pipeline.",
    });

    expect(parsed.caseId).toBe("case-queue");
    expect(parsed.sourceContext).toBe("The queue backs a realtime ingest pipeline.");
    expect(parsed.rubric).toEqual({ rubricId: "debate-quality", rubricVersion: "1" });
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  test("rejects unknown fields, versions, and missing provenance", () => {
    expect(() => parseBenchmarkCase({ ...MINIMAL, caseVersion: "2" })).toThrow(
      "unsupported caseVersion: 2",
    );
    expect(() => parseBenchmarkCase({ ...MINIMAL, extra: 1 })).toThrow(
      "unknown field at case: extra",
    );
    const { provenance, ...withoutProvenance } = MINIMAL;
    void provenance;
    expect(() => parseBenchmarkCase(withoutProvenance)).toThrow(
      "provenance must be a non-empty string",
    );
    expect(() => parseBenchmarkCase({
      ...MINIMAL,
      rubric: { rubricId: "debate-quality" },
    })).toThrow("rubricVersion must be a non-empty string");
  });

  test("hashes canonically and distinguishes source-context presence", () => {
    const bare = parseBenchmarkCase(MINIMAL);
    const withContext = parseBenchmarkCase({ ...MINIMAL, sourceContext: "context" });

    expect(benchmarkCaseHash(bare)).toMatch(/^[0-9a-f]{64}$/);
    expect(benchmarkCaseHash(bare)).not.toBe(benchmarkCaseHash(withContext));
    expect(benchmarkCaseHash(parseBenchmarkCase(MINIMAL))).toBe(benchmarkCaseHash(bare));
  });

  test("ships exactly three valid fixture cases with distinct IDs", () => {
    expect(FIXTURE_CASES).toHaveLength(3);
    const ids = FIXTURE_CASES.map((item) => item.caseId);
    expect(new Set(ids).size).toBe(3);
    for (const fixture of FIXTURE_CASES) {
      // Round-trips through the untrusted parser unchanged.
      expect(parseBenchmarkCase(JSON.parse(JSON.stringify(fixture)))).toEqual(fixture);
    }
  });
});
