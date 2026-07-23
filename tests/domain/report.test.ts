import { describe, expect, test } from "bun:test";

import { buildComparisonReport, type TrialMetrics } from "../../src/domain/report";

function trial(overrides: Partial<TrialMetrics>): TrialMetrics {
  return {
    quality: 0.5,
    tokens: 1_000,
    latencyMs: 500,
    failed: false,
    rewardScalar: 0.5,
    ...overrides,
  };
}

describe("comparison report", () => {
  test("summarizes quality, cost, latency, failure rate, and variance per arm", () => {
    const report = buildComparisonReport({
      baseline: [
        trial({ quality: 0.4, tokens: 1_200, latencyMs: 600, rewardScalar: 0.3 }),
        trial({ quality: 0.6, tokens: 800, latencyMs: 400, rewardScalar: 0.5 }),
        trial({ quality: null, tokens: null, latencyMs: null, failed: true, rewardScalar: null }),
      ],
      selected: [
        trial({ quality: 0.8, tokens: 900, latencyMs: 450, rewardScalar: 0.7 }),
        trial({ quality: 0.7, tokens: 1_100, latencyMs: 550, rewardScalar: 0.6 }),
      ],
    });

    expect(report.baseline.trialCount).toBe(3);
    expect(report.baseline.meanQuality).toBeCloseTo(0.5, 10);
    expect(report.baseline.failureRate).toBeCloseTo(1 / 3, 10);
    expect(report.selected.meanQuality).toBeCloseTo(0.75, 10);
    expect(report.selected.failureRate).toBe(0);
    expect(report.deltas.quality).toBeCloseTo(0.25, 10);
    expect(report.deltas.tokens).toBe(0);
    expect(report.selected.rewardVariance).toBeCloseTo(0.0025, 10);
  });

  test("never claims a preference without holdout evidence", () => {
    const report = buildComparisonReport({
      baseline: [trial({ quality: 0.1 })],
      selected: [trial({ quality: 0.9 })],
    });
    // A large benchmark gap is not enough; the selecting judge saw those topics.
    expect(report.conclusion).toBe("insufficient-holdout-evidence");
  });

  test("states holdout preferences only beyond the declared minimum difference", () => {
    const holdoutBase = [trial({ quality: 0.5 })];
    const preferred = buildComparisonReport({
      baseline: [trial({})],
      selected: [trial({})],
      holdout: {
        baseline: holdoutBase,
        selected: [trial({ quality: 0.8 })],
        minimumDifference: 0.1,
      },
    });
    expect(preferred.conclusion).toBe("selected-preferred-on-holdout");

    const tie = buildComparisonReport({
      baseline: [trial({})],
      selected: [trial({})],
      holdout: {
        baseline: holdoutBase,
        selected: [trial({ quality: 0.55 })],
        minimumDifference: 0.1,
      },
    });
    expect(tie.conclusion).toBe("no-holdout-difference");

    const worse = buildComparisonReport({
      baseline: [trial({})],
      selected: [trial({})],
      holdout: {
        baseline: holdoutBase,
        selected: [trial({ quality: 0.2 })],
        minimumDifference: 0.1,
      },
    });
    expect(worse.conclusion).toBe("baseline-preferred-on-holdout");
  });
});
