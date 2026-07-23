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

export type RewardResult =
  | {
      rewardVersion: "1";
      rewardId: string;
      status: "known";
      vector: RewardVector;
      scalar: number;
    }
  | { rewardVersion: "1"; rewardId: string; status: "unavailable"; reason: string };

/**
 * Pure, versioned reward: quality minus weighted token, latency, failure,
 * variance, and monetary penalties. The full vector is retained beside the
 * scalar. Monetary cost derives only from recorded per-attempt usage and the
 * run's immutable pricing snapshot; unpriceable usage is unavailable.
 */
export function computeReward(weights: RewardWeights, inputs: RewardInputs): RewardResult {
  for (const [name, value] of Object.entries(weights)) {
    if (name === "rewardVersion" || name === "rewardId") continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      throw new Error(`${name} must be a finite non-negative number`);
    }
  }
  if (inputs.quality.status === "unavailable") {
    return {
      rewardVersion: "1",
      rewardId: weights.rewardId,
      status: "unavailable",
      reason: `quality is unavailable: ${inputs.quality.reason}`,
    };
  }
  let monetaryFraction = 0;
  if (inputs.monetary !== undefined) {
    let scaled = 0n;
    for (const attempt of inputs.monetary.attempts) {
      const cost = calculateUsageCost(
        inputs.monetary.snapshot,
        attempt.model,
        attempt.usage,
      );
      if (cost.status === "unknown") {
        return {
          rewardVersion: "1",
          rewardId: weights.rewardId,
          status: "unavailable",
          reason: `monetary cost is unknown: missing ${cost.missing.join(", ")}`,
        };
      }
      scaled += cost.amountScaled;
    }
    if (inputs.monetary.maxAmount <= 0) {
      throw new Error("monetary.maxAmount must be positive");
    }
    monetaryFraction = Number(scaled) / 1e12 / inputs.monetary.maxAmount;
  }
  const vector: RewardVector = {
    qualityTerm: weights.qualityWeight * inputs.quality.score,
    tokenCostTerm: -weights.tokenCostWeight * inputs.tokensUsedFraction,
    latencyTerm: -weights.latencyWeight * inputs.latencyFraction,
    failureTerm: inputs.failed ? -weights.failurePenalty : 0,
    varianceTerm: -weights.variancePenalty * inputs.variance,
    monetaryTerm: -weights.monetaryWeight * monetaryFraction,
  };
  const scalar = vector.qualityTerm + vector.tokenCostTerm + vector.latencyTerm
    + vector.failureTerm + vector.varianceTerm + vector.monetaryTerm;
  return {
    rewardVersion: "1",
    rewardId: weights.rewardId,
    status: "known",
    vector: Object.freeze(vector),
    scalar,
  };
}
