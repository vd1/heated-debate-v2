import { createHash } from "node:crypto";

import type { ModelIdentity, RequestedControls } from "./agent";
import { pricingSnapshotHash, type PricingSnapshot } from "./pricing";
import { studySpecHash, type StudySpec } from "./study-spec";

export interface ReliabilitySample {
  sampleId: string;
  /** Source-artifact run identity; the repeated-measure group for this sample. */
  candidateRunId: string;
  /** Full digest of the persisted evaluation record backing this sample. */
  evaluationRecordHash: string;
  /** Presentation order of the judged material for ordering-bias analysis. */
  ordering: "forward" | "reversed";
  judgeModel: ModelIdentity;
  /** Model that produced the judged material, for self-preference analysis. */
  debaterModel: ModelIdentity;
  /** Overall normalized score in [0, 1]. */
  score: number;
}

/** A statistic that either measured something or states why it could not. */
export type EffectMeasure =
  | { status: "known"; value: number }
  | { status: "unavailable"; reason: string };

export interface ReliabilityAnalysis {
  analysisVersion: "2";
  sampleCount: number;
  /** Population variance of all scores; needs at least two samples. */
  judgeVariance: EffectMeasure;
  /** Absolute difference between mean forward and mean reversed scores. */
  orderingBiasEffect: EffectMeasure;
  /** Mean same-model score minus mean cross-model score. */
  selfPreferenceEffect: EffectMeasure;
  /** Largest absolute difference between per-judge-model means. */
  judgeDisagreement: EffectMeasure;
}

function assertSample(sample: ReliabilitySample): void {
  if (sample.sampleId.trim().length === 0) {
    throw new Error("sampleId must be non-empty");
  }
  if (sample.candidateRunId.trim().length === 0) {
    throw new Error(`sample ${sample.sampleId} candidateRunId must be non-empty`);
  }
  if (!/^[0-9a-f]{64}$/.test(sample.evaluationRecordHash)) {
    throw new Error(`sample ${sample.sampleId} evaluationRecordHash must be a sha256 hex digest`);
  }
  if ((sample.ordering as string) !== "forward" && (sample.ordering as string) !== "reversed") {
    throw new Error(`sample ${sample.sampleId} ordering must be forward or reversed`);
  }
  for (const [name, model] of [
    ["judgeModel", sample.judgeModel],
    ["debaterModel", sample.debaterModel],
  ] as const) {
    if (model.providerId.trim().length === 0 || model.modelId.trim().length === 0) {
      throw new Error(`sample ${sample.sampleId} ${name} identity must be non-empty`);
    }
  }
  if (!Number.isFinite(sample.score) || sample.score < 0 || sample.score > 1) {
    throw new Error(`sample ${sample.sampleId} score must be within [0, 1]`);
  }
}

/**
 * Computes the reliability statistics. A statistic whose comparison population
 * is missing is unavailable, never a passing zero.
 */
export function analyzeReliability(samples: readonly ReliabilitySample[]): ReliabilityAnalysis {
  for (const sample of samples) assertSample(sample);
  const scores = samples.map((sample) => sample.score);
  const mean = (values: readonly number[]): number =>
    values.reduce((sum, value) => sum + value, 0) / values.length;
  const unavailable = (reason: string): EffectMeasure => ({ status: "unavailable", reason });
  const known = (value: number): EffectMeasure => ({ status: "known", value });

  const judgeVariance = scores.length < 2
    ? unavailable("variance needs at least two samples")
    : known(mean(scores.map((score) => (score - mean(scores)) ** 2)));

  const forward = samples.filter((sample) => sample.ordering === "forward");
  const reversed = samples.filter((sample) => sample.ordering === "reversed");
  const orderingBiasEffect = forward.length === 0 || reversed.length === 0
    ? unavailable("ordering bias needs both forward and reversed samples")
    : known(Math.abs(mean(forward.map((s) => s.score)) - mean(reversed.map((s) => s.score))));

  const same = samples.filter((sample) =>
    sample.judgeModel.providerId === sample.debaterModel.providerId
    && sample.judgeModel.modelId === sample.debaterModel.modelId);
  const cross = samples.filter((sample) =>
    sample.judgeModel.providerId !== sample.debaterModel.providerId
    || sample.judgeModel.modelId !== sample.debaterModel.modelId);
  const selfPreferenceEffect = same.length === 0 || cross.length === 0
    ? unavailable("self-preference needs both same-model and cross-model samples")
    : known(mean(same.map((s) => s.score)) - mean(cross.map((s) => s.score)));

  const byJudge = new Map<string, number[]>();
  for (const sample of samples) {
    const key = `${sample.judgeModel.providerId}/${sample.judgeModel.modelId}`;
    byJudge.set(key, [...(byJudge.get(key) ?? []), sample.score]);
  }
  const judgeMeans = [...byJudge.values()].map(mean);
  const judgeDisagreement = judgeMeans.length < 2
    ? unavailable("judge disagreement needs at least two judge models")
    : known(Math.max(...judgeMeans) - Math.min(...judgeMeans));

  return Object.freeze({
    analysisVersion: "2",
    sampleCount: samples.length,
    judgeVariance,
    orderingBiasEffect,
    selfPreferenceEffect,
    judgeDisagreement,
  });
}

export interface ThresholdEvaluation {
  thresholdId: string;
  limit: number;
  /** Null when the underlying statistic was unavailable. */
  observed: number | null;
  passed: boolean;
  reason?: string;
}

export interface ReliabilityArtifact {
  artifactVersion: "2";
  studySpecHash: string;
  judge: {
    model: ModelIdentity;
    controls: RequestedControls;
    /** Hash of the exact judge prompt template used across samples. */
    promptHash: string;
  };
  pricingSnapshot: { snapshotId: string; snapshotVersion: string; snapshotHash: string };
  /** Full per-sample evidence, in collection order. */
  samples: readonly ReliabilitySample[];
  /** Evaluations that produced no usable score; never silently dropped. */
  missingEvaluations: readonly { sampleId: string; reason: string }[];
  analysis: ReliabilityAnalysis;
  evaluatedThresholds: readonly ThresholdEvaluation[];
  conclusions: string;
  /** Derived deterministically: accepted only when every threshold passes. */
  status: "accepted" | "rejected";
}

function evaluateThresholds(
  spec: StudySpec,
  analysis: ReliabilityAnalysis,
): ThresholdEvaluation[] {
  const thresholds = spec.reliabilityThresholds;
  const upperBound = (
    thresholdId: string,
    limit: number,
    measure: EffectMeasure,
    absolute = false,
  ): ThresholdEvaluation => measure.status === "unavailable"
    ? { thresholdId, limit, observed: null, passed: false, reason: measure.reason }
    : {
        thresholdId,
        limit,
        observed: measure.value,
        passed: (absolute ? Math.abs(measure.value) : measure.value) <= limit,
      };
  const evaluated: ThresholdEvaluation[] = [
    {
      thresholdId: "minimumSampleCount",
      limit: thresholds.minimumSampleCount,
      observed: analysis.sampleCount,
      passed: analysis.sampleCount >= thresholds.minimumSampleCount,
    },
    upperBound("maximumJudgeVariance", thresholds.maximumJudgeVariance, analysis.judgeVariance),
    upperBound(
      "maximumOrderingBiasEffect",
      thresholds.maximumOrderingBiasEffect,
      analysis.orderingBiasEffect,
    ),
  ];
  if (thresholds.maximumSelfPreferenceEffect !== undefined) {
    evaluated.push(upperBound(
      "maximumSelfPreferenceEffect",
      thresholds.maximumSelfPreferenceEffect,
      analysis.selfPreferenceEffect,
      true,
    ));
  }
  if (thresholds.maximumJudgeDisagreement !== undefined) {
    evaluated.push(upperBound(
      "maximumJudgeDisagreement",
      thresholds.maximumJudgeDisagreement,
      analysis.judgeDisagreement,
    ));
  }
  return evaluated;
}

export function createReliabilityArtifact(input: {
  spec: StudySpec;
  judge: { model: ModelIdentity; controls: RequestedControls; promptText: string };
  samples: readonly ReliabilitySample[];
  missingEvaluations?: readonly { sampleId: string; reason: string }[];
  conclusions: string;
}): ReliabilityArtifact {
  const ids = new Set<string>();
  for (const sample of input.samples) {
    if (ids.has(sample.sampleId)) throw new Error(`duplicate sample ${sample.sampleId}`);
    ids.add(sample.sampleId);
  }
  const analysis = analyzeReliability(input.samples);
  const evaluatedThresholds = evaluateThresholds(input.spec, analysis);
  return deepFreeze({
    artifactVersion: "2",
    studySpecHash: studySpecHash(input.spec),
    judge: {
      model: structuredClone(input.judge.model),
      controls: structuredClone(input.judge.controls),
      promptHash: createHash("sha256").update(input.judge.promptText).digest("hex"),
    },
    pricingSnapshot: pricingSnapshotReference(input.spec.pricingSnapshot),
    samples: structuredClone(input.samples),
    missingEvaluations: structuredClone(input.missingEvaluations ?? []),
    analysis,
    evaluatedThresholds,
    conclusions: input.conclusions,
    status: evaluatedThresholds.every((item) => item.passed) ? "accepted" : "rejected",
  });
}

/**
 * Optimization gate: requires a matching accepted reliability artifact whose
 * analysis, threshold evaluations, and verdict all RECOMPUTE from the stored
 * samples. A manually constructed object with a matching hash and status
 * cannot pass.
 */
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
  const analysis = analyzeReliability(artifact.samples);
  if (canonicalJson(analysis) !== canonicalJson(artifact.analysis)) {
    throw new Error("reliability artifact analysis does not recompute from its samples");
  }
  const evaluatedThresholds = evaluateThresholds(spec, analysis);
  if (canonicalJson(evaluatedThresholds) !== canonicalJson(artifact.evaluatedThresholds)) {
    throw new Error("reliability artifact thresholds do not recompute from the study spec");
  }
  if (!evaluatedThresholds.every((item) => item.passed)) {
    throw new Error("reliability artifact status does not recompute as accepted");
  }
  if (pricingSnapshotHash(spec.pricingSnapshot) !== artifact.pricingSnapshot.snapshotHash) {
    throw new Error("reliability artifact pricing snapshot does not match the study spec");
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

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
  ).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
