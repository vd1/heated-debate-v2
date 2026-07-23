import { createHash } from "node:crypto";

import type { ModelIdentity, RequestedControls } from "./agent";
import { pricingSnapshotHash, type PricingSnapshot } from "./pricing";
import { studySpecHash, type StudySpec } from "./study-spec";

export interface ReliabilitySample {
  sampleId: string;
  /** Presentation order of the judged material for ordering-bias analysis. */
  ordering: "forward" | "reversed";
  judgeModel: ModelIdentity;
  /** Model that produced the judged material, for self-preference analysis. */
  debaterModel: ModelIdentity;
  /** Overall normalized score in [0, 1]. */
  score: number;
}

export interface ReliabilityAnalysis {
  analysisVersion: "1";
  sampleCount: number;
  /** Population variance of all scores. */
  judgeVariance: number;
  /** Absolute difference between mean forward and mean reversed scores. */
  orderingBiasEffect: number;
  /** Mean same-model score minus mean cross-model score; 0 when undefined. */
  selfPreferenceEffect: number;
  /** Largest absolute difference between per-judge-model means. */
  judgeDisagreement: number;
}

export function analyzeReliability(samples: readonly ReliabilitySample[]): ReliabilityAnalysis {
  for (const sample of samples) {
    if (!Number.isFinite(sample.score) || sample.score < 0 || sample.score > 1) {
      throw new Error(`sample ${sample.sampleId} score must be within [0, 1]`);
    }
  }
  const scores = samples.map((sample) => sample.score);
  const mean = (values: readonly number[]): number =>
    values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
  const overall = mean(scores);
  const variance = scores.length === 0
    ? 0
    : mean(scores.map((score) => (score - overall) ** 2));

  const forward = samples.filter((sample) => sample.ordering === "forward");
  const reversed = samples.filter((sample) => sample.ordering === "reversed");
  const orderingBiasEffect = forward.length === 0 || reversed.length === 0
    ? 0
    : Math.abs(mean(forward.map((s) => s.score)) - mean(reversed.map((s) => s.score)));

  const same = samples.filter((sample) =>
    sample.judgeModel.providerId === sample.debaterModel.providerId
    && sample.judgeModel.modelId === sample.debaterModel.modelId);
  const cross = samples.filter((sample) =>
    sample.judgeModel.providerId !== sample.debaterModel.providerId
    || sample.judgeModel.modelId !== sample.debaterModel.modelId);
  const selfPreferenceEffect = same.length === 0 || cross.length === 0
    ? 0
    : mean(same.map((s) => s.score)) - mean(cross.map((s) => s.score));

  const byJudge = new Map<string, number[]>();
  for (const sample of samples) {
    const key = `${sample.judgeModel.providerId}/${sample.judgeModel.modelId}`;
    byJudge.set(key, [...(byJudge.get(key) ?? []), sample.score]);
  }
  const judgeMeans = [...byJudge.values()].map(mean);
  const judgeDisagreement = judgeMeans.length < 2
    ? 0
    : Math.max(...judgeMeans) - Math.min(...judgeMeans);

  return Object.freeze({
    analysisVersion: "1",
    sampleCount: samples.length,
    judgeVariance: variance,
    orderingBiasEffect,
    selfPreferenceEffect,
    judgeDisagreement,
  });
}

export interface ThresholdEvaluation {
  thresholdId: string;
  limit: number;
  observed: number;
  passed: boolean;
}

export interface ReliabilityArtifact {
  artifactVersion: "1";
  studySpecHash: string;
  judge: {
    model: ModelIdentity;
    controls: RequestedControls;
    /** Hash of the exact judge prompt template used across samples. */
    promptHash: string;
  };
  pricingSnapshot: { snapshotId: string; snapshotVersion: string; snapshotHash: string };
  sampleIds: readonly string[];
  /** Raw per-sample score vector in sample order. */
  rawScores: readonly number[];
  analysis: ReliabilityAnalysis;
  evaluatedThresholds: readonly ThresholdEvaluation[];
  conclusions: string;
  /** Derived deterministically: accepted only when every threshold passes. */
  status: "accepted" | "rejected";
}

export function createReliabilityArtifact(input: {
  spec: StudySpec;
  judge: { model: ModelIdentity; controls: RequestedControls; promptText: string };
  samples: readonly ReliabilitySample[];
  conclusions: string;
}): ReliabilityArtifact {
  const ids = new Set<string>();
  for (const sample of input.samples) {
    if (ids.has(sample.sampleId)) throw new Error(`duplicate sample ${sample.sampleId}`);
    ids.add(sample.sampleId);
  }
  const analysis = analyzeReliability(input.samples);
  const thresholds = input.spec.reliabilityThresholds;
  const evaluatedThresholds: ThresholdEvaluation[] = [
    {
      thresholdId: "minimumSampleCount",
      limit: thresholds.minimumSampleCount,
      observed: analysis.sampleCount,
      passed: analysis.sampleCount >= thresholds.minimumSampleCount,
    },
    {
      thresholdId: "maximumJudgeVariance",
      limit: thresholds.maximumJudgeVariance,
      observed: analysis.judgeVariance,
      passed: analysis.judgeVariance <= thresholds.maximumJudgeVariance,
    },
    {
      thresholdId: "maximumOrderingBiasEffect",
      limit: thresholds.maximumOrderingBiasEffect,
      observed: analysis.orderingBiasEffect,
      passed: analysis.orderingBiasEffect <= thresholds.maximumOrderingBiasEffect,
    },
  ];
  return deepFreeze({
    artifactVersion: "1",
    studySpecHash: studySpecHash(input.spec),
    judge: {
      model: structuredClone(input.judge.model),
      controls: structuredClone(input.judge.controls),
      promptHash: createHash("sha256").update(input.judge.promptText).digest("hex"),
    },
    pricingSnapshot: pricingSnapshotReference(input.spec.pricingSnapshot),
    sampleIds: input.samples.map((sample) => sample.sampleId),
    rawScores: input.samples.map((sample) => sample.score),
    analysis,
    evaluatedThresholds,
    conclusions: input.conclusions,
    status: evaluatedThresholds.every((item) => item.passed) ? "accepted" : "rejected",
  });
}

/** Optimization gate: requires a matching accepted reliability artifact. */
export function assertAcceptedReliability(
  artifact: ReliabilityArtifact,
  spec: StudySpec,
): void {
  if (artifact.studySpecHash !== studySpecHash(spec)) {
    throw new Error("reliability artifact does not match the study spec");
  }
  if (artifact.status !== "accepted") {
    throw new Error("optimization requires an accepted reliability artifact");
  }
}

function pricingSnapshotReference(snapshot: PricingSnapshot): {
  snapshotId: string;
  snapshotVersion: string;
  snapshotHash: string;
} {
  return {
    snapshotId: snapshot.snapshotId,
    snapshotVersion: snapshot.snapshotVersion,
    snapshotHash: pricingSnapshotHash(snapshot),
  };
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
