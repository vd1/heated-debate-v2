import { describe, expect, test } from "bun:test";

import { definePricingSnapshot } from "../../src/domain/pricing";
import { computeReward, type RewardWeights } from "../../src/domain/reward";

const WEIGHTS: RewardWeights = {
  rewardVersion: "1",
  rewardId: "reward-default",
  qualityWeight: 1,
  tokenCostWeight: 0.2,
  latencyWeight: 0.1,
  failurePenalty: 0.5,
  variancePenalty: 0.3,
  monetaryWeight: 0.4,
};

const SNAPSHOT = definePricingSnapshot({
  snapshotId: "p",
  snapshotVersion: "1",
  currency: "USD",
  effectiveDate: "2026-07-01",
  provenance: "t",
  entries: [{
    model: { providerId: "test", modelId: "m" },
    inputRatePerMillionTokens: 1,
    outputRatePerMillionTokens: 0,
    cacheReadRatePerMillionTokens: 0,
    cacheWriteRatePerMillionTokens: 0,
    reasoningBilling: { mode: "included-in-output" },
  }],
});

describe("reward function", () => {
  test("computes every term and retains the vector", () => {
    const result = computeReward(WEIGHTS, {
      quality: { status: "known", score: 0.8 },
      tokensUsedFraction: 0.5,
      latencyFraction: 0.4,
      failed: true,
      variance: 0.1,
      monetary: {
        snapshot: SNAPSHOT,
        attempts: [{
          model: { providerId: "test", modelId: "m" },
          // 500k input tokens at 1 USD/M = 0.5 USD of a 1 USD cap.
          usage: { inputTokens: 500_000, outputTokens: 0 },
        }],
        maxAmount: 1,
      },
    });

    if (result.status !== "known") throw new Error(result.status);
    expect(result.vector).toEqual({
      qualityTerm: 0.8,
      tokenCostTerm: -0.1,
      latencyTerm: -(0.1 * 0.4),
      failureTerm: -0.5,
      varianceTerm: -(0.3 * 0.1),
      monetaryTerm: -0.2,
    });
    expect(result.scalar).toBeCloseTo(0.8 - 0.1 - 0.04 - 0.5 - 0.03 - 0.2, 10);
  });

  test("is unavailable when quality or monetary evidence is unavailable", () => {
    const noQuality = computeReward(WEIGHTS, {
      quality: { status: "unavailable", reason: "judge output partial" },
      tokensUsedFraction: 0,
      latencyFraction: 0,
      failed: false,
      variance: 0,
    });
    expect(noQuality.status).toBe("unavailable");

    const unknownCost = computeReward(WEIGHTS, {
      quality: { status: "known", score: 1 },
      tokensUsedFraction: 0,
      latencyFraction: 0,
      failed: false,
      variance: 0,
      monetary: {
        snapshot: SNAPSHOT,
        attempts: [{
          model: { providerId: "test", modelId: "m" },
          usage: { outputTokens: 5 },
        }],
        maxAmount: 1,
      },
    });
    if (unknownCost.status !== "unavailable") throw new Error(unknownCost.status);
    expect(unknownCost.reason).toContain("missing inputTokens");
  });

  test("rejects invalid weights", () => {
    expect(() => computeReward({ ...WEIGHTS, latencyWeight: -1 }, {
      quality: { status: "known", score: 1 },
      tokensUsedFraction: 0,
      latencyFraction: 0,
      failed: false,
      variance: 0,
    })).toThrow("latencyWeight must be a finite non-negative number");
  });

  test("zero penalties leave pure quality", () => {
    const result = computeReward({
      ...WEIGHTS,
      tokenCostWeight: 0,
      latencyWeight: 0,
      failurePenalty: 0,
      variancePenalty: 0,
      monetaryWeight: 0,
    }, {
      quality: { status: "known", score: 0.6 },
      tokensUsedFraction: 1,
      latencyFraction: 1,
      failed: true,
      variance: 1,
    });
    if (result.status !== "known") throw new Error(result.status);
    expect(result.scalar).toBe(0.6);
  });
});
