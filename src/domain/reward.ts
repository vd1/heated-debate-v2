import { createHash } from "node:crypto";

import { calculateUsageCost, type PricingSnapshot } from "./pricing";
import type { ModelIdentity, NormalizedUsage } from "./agent";

export interface RewardWeights {
  rewardVersion: "1";
  rewardId: string;
  qualityWeight: number;
  tokenCostWeight: number;
  latencyWeight: number;
  failurePenalty: number;
  variancePenalty: number;
  monetaryWeight: number;
}

export interface RewardInputs {
  /** Normalized quality in [0, 1]; unavailable quality makes the reward unavailable. */
  quality: { status: "known"; score: number } | { status: "unavailable"; reason: string };
  /** Retry-inclusive observed tokens, normalized by the caller's budget. */
  tokensUsedFraction: number;
  /** Mean turn latency normalized by the caller's target. */
  latencyFraction: number;
  failed: boolean;
  /** Per-run reward variance scope; aggregation across runs happens downstream. */
  variance: number;
  /** Per-attempt usage priced only against the run's immutable snapshot. */
  monetary?: {
    snapshot: PricingSnapshot;
    attempts: readonly { model: ModelIdentity; usage: NormalizedUsage }[];
    maxAmount: number;
  };
}

export interface RewardVector {
  qualityTerm: number;
  tokenCostTerm: number;
  latencyTerm: number;
  failureTerm: number;
  varianceTerm: number;
  monetaryTerm: number;
}

/** Raw measurements before weighting; null marks a component with no evidence. */
export interface RewardMeasurements {
  quality: number;
  tokensUsedFraction: number;
  latencyFraction: number;
  failed: boolean;
  variance: number;
  monetaryFraction: number | null;
}

export type RewardResult =
  | {
      rewardVersion: "1";
      rewardId: string;
      /** Full canonical digest of the exact scalarizer configuration. */
      configHash: string;
      status: "known";
      measurements: RewardMeasurements;
      vector: RewardVector;
      scalar: number;
    }
  | {
      rewardVersion: "1";
      rewardId: string;
      configHash: string;
      status: "unavailable";
      reason: string;
    };

/**
 * Registered scalarizer configurations. Preregistration declares only the
 * ID/version pair; the registry resolves it to the exact weights so the
 * executed objective is constrained by the spec, never by the caller.
 */
const SCALARIZERS: readonly RewardWeights[] = [
  Object.freeze({
    rewardVersion: "1",
    rewardId: "reward",
    qualityWeight: 1,
    tokenCostWeight: 0.1,
    latencyWeight: 0.1,
    failurePenalty: 1,
    variancePenalty: 0,
    monetaryWeight: 0,
  }),
];

export function resolveScalarizer(
  declaration: { rewardId: string; rewardVersion: string },
): RewardWeights {
  const resolved = SCALARIZERS.find((weights) =>
    weights.rewardId === declaration.rewardId
    && weights.rewardVersion === declaration.rewardVersion);
  if (!resolved) {
    throw new Error(
      `no registered scalarizer for ${declaration.rewardId}@${declaration.rewardVersion}`,
    );
  }
  return resolved;
}

/** Full canonical digest over every scalarizer field, key-order independent. */
export function scalarizerConfigHash(weights: RewardWeights): string {
  const canonical = Object.keys(weights).sort().map((key) =>
    `${JSON.stringify(key)}:${JSON.stringify(Reflect.get(weights, key))}`).join(",");
  return createHash("sha256").update(`{${canonical}}`).digest("hex");
}

function assertMeasurement(name: string, value: number, maximum?: number): void {
  if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(`${name} must be a finite number in range`);
  }
}

/**
 * Pure, versioned reward: quality minus weighted token, latency, failure,
 * variance, and monetary penalties. Raw measurements are retained beside the
 * weighted vector and scalar under a full scalarizer configuration hash.
 * Monetary cost derives only from recorded per-attempt usage and the run's
 * immutable pricing snapshot; a positively weighted component without
 * evidence makes the reward unavailable, never silently zero.
 */
export function computeReward(weights: RewardWeights, inputs: RewardInputs): RewardResult {
  if ((weights.rewardVersion as string) !== "1") {
    throw new Error(`unsupported rewardVersion ${weights.rewardVersion as string}`);
  }
  if (weights.rewardId.trim().length === 0) {
    throw new Error("rewardId must be non-empty");
  }
  for (const [name, value] of Object.entries(weights)) {
    if (name === "rewardVersion" || name === "rewardId") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite non-negative number`);
    }
  }
  const configHash = scalarizerConfigHash(weights);
  const unavailable = (reason: string): RewardResult => ({
    rewardVersion: "1",
    rewardId: weights.rewardId,
    configHash,
    status: "unavailable",
    reason,
  });
  if (inputs.quality.status === "known") {
    assertMeasurement("quality.score", inputs.quality.score, 1);
  }
  assertMeasurement("tokensUsedFraction", inputs.tokensUsedFraction);
  assertMeasurement("latencyFraction", inputs.latencyFraction);
  assertMeasurement("variance", inputs.variance);
  if (inputs.quality.status === "unavailable") {
    return unavailable(`quality is unavailable: ${inputs.quality.reason}`);
  }
  let monetaryFraction: number | null = null;
  if (inputs.monetary !== undefined) {
    let scaled = 0n;
    for (const attempt of inputs.monetary.attempts) {
      const cost = calculateUsageCost(
        inputs.monetary.snapshot,
        attempt.model,
        attempt.usage,
      );
      if (cost.status === "unknown") {
        return unavailable(`monetary cost is unknown: missing ${cost.missing.join(", ")}`);
      }
      scaled += cost.amountScaled;
    }
    if (inputs.monetary.maxAmount <= 0) {
      throw new Error("monetary.maxAmount must be positive");
    }
    monetaryFraction = Number(scaled) / 1e12 / inputs.monetary.maxAmount;
  } else if (weights.monetaryWeight > 0) {
    return unavailable(
      "monetary evidence is missing while the scalarizer weights monetary cost",
    );
  }
  const vector: RewardVector = {
    qualityTerm: weights.qualityWeight * inputs.quality.score,
    tokenCostTerm: -weights.tokenCostWeight * inputs.tokensUsedFraction,
    latencyTerm: -weights.latencyWeight * inputs.latencyFraction,
    failureTerm: inputs.failed ? -weights.failurePenalty : 0,
    varianceTerm: -weights.variancePenalty * inputs.variance,
    monetaryTerm: -weights.monetaryWeight * (monetaryFraction ?? 0),
  };
  const scalar = vector.qualityTerm + vector.tokenCostTerm + vector.latencyTerm
    + vector.failureTerm + vector.varianceTerm + vector.monetaryTerm;
  return {
    rewardVersion: "1",
    rewardId: weights.rewardId,
    configHash,
    status: "known",
    measurements: Object.freeze({
      quality: inputs.quality.score,
      tokensUsedFraction: inputs.tokensUsedFraction,
      latencyFraction: inputs.latencyFraction,
      failed: inputs.failed,
      variance: inputs.variance,
      monetaryFraction,
    }),
    vector: Object.freeze(vector),
    scalar,
  };
}
