export interface TrialMetrics {
  quality: number | null;
  tokens: number | null;
  latencyMs: number | null;
  failed: boolean;
  rewardScalar: number | null;
}

export interface ArmSummary {
  trialCount: number;
  meanQuality: number | null;
  meanTokens: number | null;
  meanLatencyMs: number | null;
  failureRate: number;
  rewardVariance: number | null;
}

export interface ComparisonReport {
  reportVersion: "1";
  baseline: ArmSummary;
  selected: ArmSummary;
  deltas: {
    quality: number | null;
    tokens: number | null;
    latencyMs: number | null;
    failureRate: number;
  };
  /**
   * Never claims superiority from training topics or the selecting judge
   * alone: a holdout comparison is required for any preference statement.
   */
  conclusion:
    | "selected-preferred-on-holdout"
    | "baseline-preferred-on-holdout"
    | "no-holdout-difference"
    | "insufficient-holdout-evidence";
}

function summarize(trials: readonly TrialMetrics[]): ArmSummary {
  const known = (values: readonly (number | null)[]): number | null => {
    const present = values.filter((value): value is number => value !== null);
    if (present.length === 0) return null;
    return present.reduce((sum, value) => sum + value, 0) / present.length;
  };
  const rewards = trials.map((trial) => trial.rewardScalar)
    .filter((value): value is number => value !== null);
  const meanReward = rewards.length === 0
    ? null
    : rewards.reduce((sum, value) => sum + value, 0) / rewards.length;
  const rewardVariance = meanReward === null
    ? null
    : rewards.reduce((sum, value) => sum + (value - meanReward) ** 2, 0) / rewards.length;
  return {
    trialCount: trials.length,
    meanQuality: known(trials.map((trial) => trial.quality)),
    meanTokens: known(trials.map((trial) => trial.tokens)),
    meanLatencyMs: known(trials.map((trial) => trial.latencyMs)),
    failureRate: trials.length === 0
      ? 0
      : trials.filter((trial) => trial.failed).length / trials.length,
    rewardVariance,
  };
}

/** Baseline versus selected comparison across quality, cost, latency, failure, and variance. */
export function buildComparisonReport(input: {
  baseline: readonly TrialMetrics[];
  selected: readonly TrialMetrics[];
  holdout?: {
    baseline: readonly TrialMetrics[];
    selected: readonly TrialMetrics[];
    /** Minimum mean-quality gap treated as a real difference. */
    minimumDifference: number;
  };
}): ComparisonReport {
  const baseline = summarize(input.baseline);
  const selected = summarize(input.selected);
  const delta = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : left - right;

  let conclusion: ComparisonReport["conclusion"] = "insufficient-holdout-evidence";
  if (input.holdout !== undefined
    && input.holdout.baseline.length > 0 && input.holdout.selected.length > 0) {
    const holdoutBaseline = summarize(input.holdout.baseline).meanQuality;
    const holdoutSelected = summarize(input.holdout.selected).meanQuality;
    if (holdoutBaseline !== null && holdoutSelected !== null) {
      const gap = holdoutSelected - holdoutBaseline;
      conclusion = Math.abs(gap) < input.holdout.minimumDifference
        ? "no-holdout-difference"
        : gap > 0
          ? "selected-preferred-on-holdout"
          : "baseline-preferred-on-holdout";
    }
  }
  return Object.freeze({
    reportVersion: "1",
    baseline,
    selected,
    deltas: {
      quality: delta(selected.meanQuality, baseline.meanQuality),
      tokens: delta(selected.meanTokens, baseline.meanTokens),
      latencyMs: delta(selected.meanLatencyMs, baseline.meanLatencyMs),
      failureRate: selected.failureRate - baseline.failureRate,
    },
    conclusion,
  });
}
