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

/** A reward component that was measured or explicitly was not. */
export type Measurement =
  | { status: "known"; value: number }
  | { status: "unavailable"; reason: string };

/**
 * Raw single-run reward inputs. Every component is an explicit measurement:
 * an absent value is declared unavailable, never smuggled in as zero.
 *
 * Units and directions are fixed by this contract: quality is normalized to
 * [0, 1], higher is better; tokensUsedFraction is retry-inclusive tokens over
 * the declared budget, lower is better; latencyFraction is mean turn latency
 * over the declared target, lower is better; variance is reward variance in
 * squared score units, lower is better.
 */
export interface RewardInputs {
  quality: Measurement;
  tokensUsedFraction: Measurement;
  latencyFraction: Measurement;
  failed: boolean;
  variance: Measurement;
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

/** Assembled raw measurements; null marks a declared-unavailable component. */
export interface RewardMeasurements {
  /** The aggregate scope these measurements describe. */
  scope: "single-run";
  quality: number | null;
  tokensUsedFraction: number | null;
  latencyFraction: number | null;
  failed: boolean;
  variance: number | null;
  monetaryFraction: number | null;
}

interface AssembledMeasurements extends RewardMeasurements {
  /** Why each null component is missing, for unavailable results. */
  reasons: Readonly<Record<string, string>>;
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

const MEASUREMENT_CONTRACT = "single-run/1";

/** Full canonical digest over every scalarizer field and the measurement contract. */
export function scalarizerConfigHash(weights: RewardWeights): string {
  const source = { ...weights, measurementContract: MEASUREMENT_CONTRACT };
  const canonical = Object.keys(source).sort().map((key) =>
    `${JSON.stringify(key)}:${JSON.stringify(Reflect.get(source, key))}`).join(",");
  return createHash("sha256").update(`{${canonical}}`).digest("hex");
}

function measurementValue(
  name: string,
  measurement: Measurement,
  maximum?: number,
): number | null {
  if (measurement.status === "unavailable") return null;
  const value = measurement.value;
  if (!Number.isFinite(value) || value < 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(`${name} must be a finite number in range`);
  }
  return value;
}

/**
 * Validates and assembles the raw measurement vector from single-run inputs.
 * Monetary cost derives only from recorded per-attempt usage and the run's
 * immutable snapshot; unpriceable usage is an unavailable component.
 */
export function assembleRewardMeasurements(inputs: RewardInputs): AssembledMeasurements {
  const reasons: Record<string, string> = {};
  const note = (name: string, measurement: Measurement): void => {
    if (measurement.status === "unavailable") reasons[name] = measurement.reason;
  };
  note("quality", inputs.quality);
  note("tokensUsedFraction", inputs.tokensUsedFraction);
  note("latencyFraction", inputs.latencyFraction);
  note("variance", inputs.variance);

  let monetaryFraction: number | null = null;
  if (inputs.monetary === undefined) {
    reasons.monetaryFraction = "no monetary evidence was provided";
  } else {
    if (!Number.isFinite(inputs.monetary.maxAmount) || inputs.monetary.maxAmount <= 0) {
      throw new Error("monetary.maxAmount must be a finite positive number");
    }
    let scaled: bigint | null = 0n;
    for (const attempt of inputs.monetary.attempts) {
      const cost = calculateUsageCost(
        inputs.monetary.snapshot,
        attempt.model,
        attempt.usage,
      );
      if (cost.status === "unknown") {
        reasons.monetaryFraction = `monetary cost is unknown: missing ${cost.missing.join(", ")}`;
        scaled = null;
        break;
      }
      scaled += cost.amountScaled;
    }
    if (scaled !== null) monetaryFraction = Number(scaled) / 1e12 / inputs.monetary.maxAmount;
  }

  return {
    scope: "single-run",
    quality: measurementValue("quality", inputs.quality, 1),
    tokensUsedFraction: measurementValue("tokensUsedFraction", inputs.tokensUsedFraction),
    latencyFraction: measurementValue("latencyFraction", inputs.latencyFraction),
    failed: inputs.failed,
    variance: measurementValue("variance", inputs.variance),
    monetaryFraction,
    reasons: Object.freeze(reasons),
  };
}

/**
 * Versioned scalarization over an assembled measurement vector. A positively
 * weighted unavailable component makes the reward unavailable, never zero.
 */
export function scalarizeReward(
  weights: RewardWeights,
  assembled: AssembledMeasurements,
): RewardResult {
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
  const required: readonly [string, number | null, number][] = [
    ["quality", assembled.quality, weights.qualityWeight],
    ["tokensUsedFraction", assembled.tokensUsedFraction, weights.tokenCostWeight],
    ["latencyFraction", assembled.latencyFraction, weights.latencyWeight],
    ["variance", assembled.variance, weights.variancePenalty],
    ["monetaryFraction", assembled.monetaryFraction, weights.monetaryWeight],
  ];
  for (const [name, value, weight] of required) {
    if (value === null && weight > 0) {
      return {
        rewardVersion: "1",
        rewardId: weights.rewardId,
        configHash,
        status: "unavailable",
        reason: `${name} is unavailable: ${assembled.reasons[name] ?? "no measurement"}`,
      };
    }
  }
  const vector: RewardVector = {
    qualityTerm: weights.qualityWeight * (assembled.quality ?? 0),
    tokenCostTerm: -weights.tokenCostWeight * (assembled.tokensUsedFraction ?? 0),
    latencyTerm: -weights.latencyWeight * (assembled.latencyFraction ?? 0),
    failureTerm: assembled.failed ? -weights.failurePenalty : 0,
    varianceTerm: -weights.variancePenalty * (assembled.variance ?? 0),
    monetaryTerm: -weights.monetaryWeight * (assembled.monetaryFraction ?? 0),
  };
  const scalar = vector.qualityTerm + vector.tokenCostTerm + vector.latencyTerm
    + vector.failureTerm + vector.varianceTerm + vector.monetaryTerm;
  const { reasons, ...measurements } = assembled;
  void reasons;
  // Final backstop: nothing non-finite ever leaves as a known reward.
  for (const [name, value] of [...Object.entries(vector), ["scalar", scalar] as const]) {
    if (!Number.isFinite(value)) {
      throw new Error(`reward ${name} is not a finite number`);
    }
  }
  for (const [name, value] of Object.entries(measurements)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`reward measurement ${name} is not a finite number`);
    }
  }
  return {
    rewardVersion: "1",
    rewardId: weights.rewardId,
    configHash,
    status: "known",
    measurements: Object.freeze(measurements),
    vector: Object.freeze(vector),
    scalar,
  };
}

/** Assembly composed with scalarization; see the two halves for the contract. */
export function computeReward(weights: RewardWeights, inputs: RewardInputs): RewardResult {
  return scalarizeReward(weights, assembleRewardMeasurements(inputs));
}
