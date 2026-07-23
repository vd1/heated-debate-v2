import { describe, expect, test } from "bun:test";

import { artifactPathForRun, executeMatrix } from "../../src/domain/executor";
import type { RunSpecification } from "../../src/domain/matrix";

function run(n: number): RunSpecification {
  return {
    purpose: "selection",
    runId: `study:abc123def456:case-${String(n)}:thinkingLevel=low:rep1`,
    caseId: `case-${String(n)}`,
    holdout: false,
    variantKey: "thinkingLevel=low",
    parameters: { thinkingLevel: "low" },
    repetition: 1,
  };
}

const RUNS = [run(1), run(2), run(3), run(4)];
const id = (n: number): string => run(n).runId;

describe("matrix executor", () => {
  test("maps run IDs to deterministic artifact paths", () => {
    const path = artifactPathForRun(run(1));
    expect(path).toMatch(
      /^study\/abc123def456\/case-1\/thinkingLevel=low\/rep1-[0-9a-f]{8}\.jsonl$/,
    );
    // Sanitization is lossy, so distinct variant keys keep distinct paths.
    const slash = artifactPathForRun({
      ...run(1),
      runId: "study:abc123def456:case-1:x=a/b:rep1",
      variantKey: "x=a/b",
    });
    const underscore = artifactPathForRun({
      ...run(1),
      runId: "study:abc123def456:case-1:x=a_b:rep1",
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
