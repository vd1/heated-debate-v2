import { describe, expect, test } from "bun:test";

import { definePricingSnapshot } from "../../src/domain/pricing";
import {
  assembleRewardMeasurements,
  computeReward,
  resolveScalarizer,
  scalarizeReward,
  type RewardWeights,
} from "../../src/domain/reward";

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
      quality: { status: "known", value: 0.8 },
      tokensUsedFraction: { status: "known", value: 0.5 },
      latencyFraction: { status: "known", value: 0.4 },
      failed: true,
      variance: { status: "known", value: 0.1 },
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
      tokensUsedFraction: { status: "known", value: 0 },
      latencyFraction: { status: "known", value: 0 },
      failed: false,
      variance: { status: "known", value: 0 },
    });
    expect(noQuality.status).toBe("unavailable");

    const unknownCost = computeReward(WEIGHTS, {
      quality: { status: "known", value: 1 },
      tokensUsedFraction: { status: "known", value: 0 },
      latencyFraction: { status: "known", value: 0 },
      failed: false,
      variance: { status: "known", value: 0 },
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
      quality: { status: "known", value: 1 },
      tokensUsedFraction: { status: "known", value: 0 },
      latencyFraction: { status: "known", value: 0 },
      failed: false,
      variance: { status: "known", value: 0 },
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
      quality: { status: "known", value: 0.6 },
      tokensUsedFraction: { status: "known", value: 1 },
      latencyFraction: { status: "known", value: 1 },
      failed: true,
      variance: { status: "known", value: 1 },
    });
    if (result.status !== "known") throw new Error(result.status);
    expect(result.scalar).toBe(0.6);
  });
});

describe("reward hardening", () => {
  const inputs = {
    quality: { status: "known" as const, value: 0.8 },
    tokensUsedFraction: { status: "known" as const, value: 0.2 },
    latencyFraction: { status: "known" as const, value: 0.1 },
    failed: false,
    variance: { status: "known" as const, value: 0 },
  };

  test("rejects undeclared reward versions and empty reward IDs at runtime", () => {
    const forged = { ...WEIGHTS, rewardVersion: "999" } as unknown as RewardWeights;
    expect(() => computeReward(forged, inputs)).toThrow("rewardVersion");
    expect(() => computeReward({ ...WEIGHTS, rewardId: "" }, inputs)).toThrow("rewardId");
  });

  test("rejects non-finite or out-of-range measurements instead of returning NaN", () => {
    expect(() => computeReward(WEIGHTS, {
      ...inputs, quality: { status: "known", value: Number.NaN },
    })).toThrow("quality");
    expect(() => computeReward(WEIGHTS, {
      ...inputs, quality: { status: "known", value: 1.5 },
    })).toThrow("quality");
    expect(() => computeReward(WEIGHTS, {
      ...inputs, tokensUsedFraction: { status: "known", value: Number.NaN },
    })).toThrow("tokensUsedFraction");
    expect(() => computeReward(WEIGHTS, {
      ...inputs, latencyFraction: { status: "known", value: -1 },
    })).toThrow("latencyFraction");
    expect(() => computeReward(WEIGHTS, {
      ...inputs, variance: { status: "known", value: Number.POSITIVE_INFINITY },
    })).toThrow("variance");
  });

  test("treats missing monetary evidence under a positive weight as unavailable", () => {
    const result = computeReward(WEIGHTS, inputs);
    if (result.status !== "unavailable") throw new Error(result.status);
    expect(result.reason).toContain("monetary");

    // A zero monetary weight declares the component out of scope.
    const unweighted = computeReward({ ...WEIGHTS, monetaryWeight: 0 }, inputs);
    expect(unweighted.status).toBe("known");
  });

  test("carries the full scalarizer configuration hash and raw measurements", () => {
    const result = computeReward({ ...WEIGHTS, monetaryWeight: 0 }, inputs);
    if (result.status !== "known") throw new Error(result.status);
    expect(result.configHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.measurements).toEqual({
      scope: "single-run",
      quality: 0.8,
      tokensUsedFraction: 0.2,
      latencyFraction: 0.1,
      failed: false,
      variance: 0,
      monetaryFraction: null,
    });

    // Different weights under the same ID/version are distinguishable.
    const other = computeReward({ ...WEIGHTS, monetaryWeight: 0, qualityWeight: 2 }, inputs);
    if (other.status !== "known") throw new Error(other.status);
    expect(other.configHash).not.toBe(result.configHash);

    const unavailable = computeReward(WEIGHTS, inputs);
    if (unavailable.status !== "unavailable") throw new Error(unavailable.status);
    expect(unavailable.configHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("resolves the preregistered scalarizer from the study declaration", () => {
    const resolved = resolveScalarizer({ rewardId: "reward", rewardVersion: "1" });
    expect(resolved.rewardId).toBe("reward");
    expect(resolved.rewardVersion).toBe("1");
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(() => resolveScalarizer({ rewardId: "nope", rewardVersion: "1" }))
      .toThrow("no registered scalarizer");
    expect(() => resolveScalarizer({ rewardId: "reward", rewardVersion: "2" }))
      .toThrow("no registered scalarizer");
  });
});

describe("reward measurement states and separation", () => {
  const known = (value: number) => ({ status: "known" as const, value });

  test("rejects a non-finite monetary normalization ceiling", () => {
    expect(() => computeReward(WEIGHTS, {
      quality: known(0.8),
      tokensUsedFraction: known(0.2),
      latencyFraction: known(0.1),
      failed: false,
      variance: known(0),
      monetary: { snapshot: SNAPSHOT, attempts: [], maxAmount: Number.NaN },
    })).toThrow("maxAmount");
  });

  test("never substitutes zero for a positively weighted missing measurement", () => {
    const result = computeReward({ ...WEIGHTS, monetaryWeight: 0 }, {
      quality: known(0.8),
      tokensUsedFraction: { status: "unavailable", reason: "usage was never reported" },
      latencyFraction: known(0.1),
      failed: false,
      variance: known(0),
    });
    if (result.status !== "unavailable") throw new Error(result.status);
    expect(result.reason).toContain("tokensUsedFraction");

    // A zero weight declares the component out of scope; the gap is recorded.
    const unweighted = computeReward(
      { ...WEIGHTS, monetaryWeight: 0, tokenCostWeight: 0 },
      {
        quality: known(0.8),
        tokensUsedFraction: { status: "unavailable", reason: "usage was never reported" },
        latencyFraction: known(0.1),
        failed: false,
        variance: known(0),
      },
    );
    if (unweighted.status !== "known") throw new Error(unweighted.status);
    expect(unweighted.measurements.tokensUsedFraction).toBeNull();
    expect(unweighted.measurements.scope).toBe("single-run");
  });

  test("separates raw measurement assembly from versioned scalarization", () => {
    const inputs = {
      quality: known(0.8),
      tokensUsedFraction: known(0.2),
      latencyFraction: known(0.1),
      failed: false,
      variance: known(0),
    };
    const assembled = assembleRewardMeasurements(inputs);
    expect(assembled.quality).toBe(0.8);
    const scalarized = scalarizeReward({ ...WEIGHTS, monetaryWeight: 0 }, assembled);
    const composed = computeReward({ ...WEIGHTS, monetaryWeight: 0 }, inputs);
    expect(scalarized).toEqual(composed);
  });
});
