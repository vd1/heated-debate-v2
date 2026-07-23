import { createHash } from "node:crypto";

import { MATRIX_ELIGIBLE_CONTROL_DIMENSIONS } from "./control-dimensions";
import { definePricingSnapshot, type PricingSnapshot } from "./pricing";

export interface StudySpec {
  specVersion: "1";
  studyId: string;
  hypotheses: readonly string[];
  benchmarkCaseIds: readonly string[];
  holdoutCaseIds: readonly string[];
  fixedParameters: Readonly<Record<string, unknown>>;
  variedParameters: readonly { dimensionId: string; values: readonly unknown[] }[];
  repetitions: number;
  /** Opaque versioned references, resolved only when evaluation begins. */
  evaluators: readonly { evaluatorId: string; evaluatorVersion: string }[];
  rubric: { rubricId: string; rubricVersion: string };
  pricingSnapshot: PricingSnapshot;
  /** Preregistered decisions that must not be selected after observing results. */
  samplerSeed: number;
  caseOrderPolicy: "spec-order" | "sorted-by-case-id";
  baseline: Readonly<Record<string, unknown>>;
  holdoutUsePolicy: "final-evaluation-only" | "never";
  failureHandling: "record-and-continue" | "stop-after-max-consecutive";
  unknownCostPolicy: "fail-closed" | "token-only-accounting";
  rewardScalarization: { rewardId: string; rewardVersion: string };
  budgets: {
    perRun: { maxTurns: number; maxTokens: number };
    maxTotalRuns?: number;
    maxTotalAmount?: number;
  };
  stoppingRules: { maxRuns: number; maxConsecutiveFailures?: number };
  plannedAnalysis: string;
  reliabilityThresholds: {
    minimumSampleCount: number;
    maximumJudgeVariance: number;
    maximumOrderingBiasEffect: number;
  };
}

const SPEC_FIELDS = [
  "specVersion", "studyId", "hypotheses", "benchmarkCaseIds", "holdoutCaseIds",
  "fixedParameters", "variedParameters", "repetitions", "evaluators", "rubric",
  "pricingSnapshot", "samplerSeed", "caseOrderPolicy", "baseline", "holdoutUsePolicy",
  "failureHandling", "unknownCostPolicy", "rewardScalarization",
  "budgets", "stoppingRules", "plannedAnalysis", "reliabilityThresholds",
];

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Per-dimension value parsers; every varied value must be canonical for its dimension. */
export function parseDimensionValue(dimensionId: string, value: unknown): unknown {
  switch (dimensionId) {
    case "thinkingLevel":
      if (typeof value !== "string" || !THINKING_LEVELS.has(value)) {
        throw new Error(`thinkingLevel value ${JSON.stringify(value)} is invalid`);
      }
      return value;
    case "temperature":
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 2) {
        throw new Error(`temperature value ${JSON.stringify(value)} is invalid`);
      }
      return value;
    case "maxOutputTokens":
      if (!Number.isSafeInteger(value) || (value as number) <= 0) {
        throw new Error(`maxOutputTokens value ${JSON.stringify(value)} is invalid`);
      }
      return value;
    case "creativitySchedule": {
      const schedule = record(value, "creativitySchedule value");
      exactFields(schedule, ["scheduleId", "scheduleVersion"], "creativitySchedule value");
      if (schedule.scheduleId !== "linear-cooling" || schedule.scheduleVersion !== "1") {
        throw new Error("creativitySchedule value must be linear-cooling@1");
      }
      return { scheduleId: "linear-cooling", scheduleVersion: "1" };
    }
    case "toolCapabilityPolicy":
      return structuredClone(record(value, "toolCapabilityPolicy value"));
    default:
      throw new Error(`varied dimension ${dimensionId} is not matrix-eligible`);
  }
}

export function canonicalParameterValue(value: unknown): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    return `{${Object.keys(input).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(input, key))}`,
    ).join(",")}}`;
  };
  return canonical(value);
}

/** Parses untrusted JSON into a validated, frozen preregistered study spec. */
export function parseStudySpec(value: unknown): StudySpec {
  const raw = record(value, "spec");
  for (const key of Object.keys(raw)) {
    if (!SPEC_FIELDS.includes(key)) throw new Error(`unknown field at spec: ${key}`);
  }
  if (raw.specVersion !== "1") {
    throw new Error(`unsupported specVersion: ${String(raw.specVersion)}`);
  }
  const studyId = nonEmpty(raw.studyId, "studyId");
  const hypotheses = stringArray(raw.hypotheses, "hypotheses");
  const benchmarkCaseIds = stringArray(raw.benchmarkCaseIds, "benchmarkCaseIds");
  const holdoutCaseIds = stringArray(raw.holdoutCaseIds, "holdoutCaseIds", true);
  assertUnique(benchmarkCaseIds, "benchmarkCaseIds");
  assertUnique(holdoutCaseIds, "holdoutCaseIds");
  for (const caseId of holdoutCaseIds) {
    if (benchmarkCaseIds.includes(caseId)) {
      throw new Error(`holdout case ${caseId} overlaps the benchmark set`);
    }
  }

  const eligible = new Set(MATRIX_ELIGIBLE_CONTROL_DIMENSIONS.map((item) => item.id));
  const variedRaw = raw.variedParameters;
  if (!Array.isArray(variedRaw)) throw new Error("variedParameters must be an array");
  const seenDimensions = new Set<string>();
  const variedParameters = variedRaw.map((item) => {
    const entry = record(item, "variedParameters entry");
    exactFields(entry, ["dimensionId", "values"], "variedParameters entry");
    const dimensionId = nonEmpty(entry.dimensionId, "dimensionId");
    if (!eligible.has(dimensionId)) {
      throw new Error(`varied dimension ${dimensionId} is not matrix-eligible`);
    }
    if (seenDimensions.has(dimensionId)) {
      throw new Error(`duplicate varied dimension ${dimensionId}`);
    }
    seenDimensions.add(dimensionId);
    if (!Array.isArray(entry.values) || entry.values.length < 2) {
      throw new Error(`varied dimension ${dimensionId} needs at least two values`);
    }
    const canonicalValues = new Set<string>();
    const values = entry.values.map((value) => {
      const parsed = parseDimensionValue(dimensionId, value);
      const canonical = canonicalParameterValue(parsed);
      if (canonicalValues.has(canonical)) {
        throw new Error(`duplicate value for varied dimension ${dimensionId}`);
      }
      canonicalValues.add(canonical);
      return parsed;
    });
    return { dimensionId, values };
  });
  const fixedParameters = record(raw.fixedParameters, "fixedParameters");
  for (const key of Object.keys(fixedParameters)) {
    if (seenDimensions.has(key)) {
      throw new Error(`fixed parameter ${key} overlaps a varied dimension`);
    }
  }

  if (!Number.isSafeInteger(raw.repetitions) || (raw.repetitions as number) <= 0) {
    throw new Error("repetitions must be a positive safe integer");
  }
  const evaluatorsRaw = raw.evaluators;
  if (!Array.isArray(evaluatorsRaw) || evaluatorsRaw.length === 0) {
    throw new Error("evaluators must be a non-empty array");
  }
  const evaluators = evaluatorsRaw.map((item) => {
    const entry = record(item, "evaluator");
    exactFields(entry, ["evaluatorId", "evaluatorVersion"], "evaluator");
    return {
      evaluatorId: nonEmpty(entry.evaluatorId, "evaluatorId"),
      evaluatorVersion: nonEmpty(entry.evaluatorVersion, "evaluatorVersion"),
    };
  });
  const rubricRaw = record(raw.rubric, "rubric");
  exactFields(rubricRaw, ["rubricId", "rubricVersion"], "rubric");
  const rubric = {
    rubricId: nonEmpty(rubricRaw.rubricId, "rubricId"),
    rubricVersion: nonEmpty(rubricRaw.rubricVersion, "rubricVersion"),
  };

  const budgetsRaw = record(raw.budgets, "budgets");
  exactFields(budgetsRaw, ["perRun", "maxTotalRuns", "maxTotalAmount"], "budgets");
  const perRunRaw = record(budgetsRaw.perRun, "budgets.perRun");
  exactFields(perRunRaw, ["maxTurns", "maxTokens"], "budgets.perRun");
  const budgets = {
    perRun: {
      maxTurns: safeCount(perRunRaw.maxTurns, "budgets.perRun.maxTurns"),
      maxTokens: safeCount(perRunRaw.maxTokens, "budgets.perRun.maxTokens"),
    },
    ...(budgetsRaw.maxTotalRuns === undefined
      ? {}
      : { maxTotalRuns: safeCount(budgetsRaw.maxTotalRuns, "budgets.maxTotalRuns") }),
    ...(budgetsRaw.maxTotalAmount === undefined
      ? {}
      : { maxTotalAmount: nonNegativeNumber(budgetsRaw.maxTotalAmount, "budgets.maxTotalAmount") }),
  };
  const stoppingRaw = record(raw.stoppingRules, "stoppingRules");
  exactFields(stoppingRaw, ["maxRuns", "maxConsecutiveFailures"], "stoppingRules");
  const stoppingRules = {
    maxRuns: safeCount(stoppingRaw.maxRuns, "stoppingRules.maxRuns"),
    ...(stoppingRaw.maxConsecutiveFailures === undefined
      ? {}
      : {
          maxConsecutiveFailures: safeCount(
            stoppingRaw.maxConsecutiveFailures,
            "stoppingRules.maxConsecutiveFailures",
          ),
        }),
  };
  const thresholdsRaw = record(raw.reliabilityThresholds, "reliabilityThresholds");
  exactFields(
    thresholdsRaw,
    ["minimumSampleCount", "maximumJudgeVariance", "maximumOrderingBiasEffect"],
    "reliabilityThresholds",
  );
  const reliabilityThresholds = {
    minimumSampleCount: safeCount(thresholdsRaw.minimumSampleCount, "minimumSampleCount"),
    maximumJudgeVariance: nonNegativeNumber(thresholdsRaw.maximumJudgeVariance, "maximumJudgeVariance"),
    maximumOrderingBiasEffect: nonNegativeNumber(
      thresholdsRaw.maximumOrderingBiasEffect,
      "maximumOrderingBiasEffect",
    ),
  };

  if (!Number.isSafeInteger(raw.samplerSeed) || (raw.samplerSeed as number) < 0) {
    throw new Error("samplerSeed must be a non-negative safe integer");
  }
  if (raw.caseOrderPolicy !== "spec-order" && raw.caseOrderPolicy !== "sorted-by-case-id") {
    throw new Error("caseOrderPolicy must be spec-order or sorted-by-case-id");
  }
  if (raw.holdoutUsePolicy !== "final-evaluation-only" && raw.holdoutUsePolicy !== "never") {
    throw new Error("holdoutUsePolicy must be final-evaluation-only or never");
  }
  if (raw.failureHandling !== "record-and-continue"
    && raw.failureHandling !== "stop-after-max-consecutive") {
    throw new Error("failureHandling must be record-and-continue or stop-after-max-consecutive");
  }
  if (raw.failureHandling === "stop-after-max-consecutive"
    && stoppingRules.maxConsecutiveFailures === undefined) {
    throw new Error("stop-after-max-consecutive requires stoppingRules.maxConsecutiveFailures");
  }
  if (raw.unknownCostPolicy !== "fail-closed" && raw.unknownCostPolicy !== "token-only-accounting") {
    throw new Error("unknownCostPolicy must be fail-closed or token-only-accounting");
  }
  const rewardRaw = record(raw.rewardScalarization, "rewardScalarization");
  exactFields(rewardRaw, ["rewardId", "rewardVersion"], "rewardScalarization");
  const baseline = record(raw.baseline, "baseline");
  for (const [key, value] of Object.entries(baseline)) {
    const dimension = variedParameters.find((item) => item.dimensionId === key);
    if (!dimension) throw new Error(`baseline dimension ${key} is not varied`);
    const canonical = canonicalParameterValue(parseDimensionValue(key, value));
    if (!dimension.values.some((item) => canonicalParameterValue(item) === canonical)) {
      throw new Error(`baseline value for ${key} is not among the declared values`);
    }
  }

  return deepFreeze({
    specVersion: "1",
    studyId,
    hypotheses,
    benchmarkCaseIds,
    holdoutCaseIds,
    fixedParameters: structuredClone(fixedParameters),
    variedParameters: structuredClone(variedParameters),
    repetitions: raw.repetitions as number,
    evaluators,
    rubric,
    pricingSnapshot: definePricingSnapshot(raw.pricingSnapshot as PricingSnapshot),
    samplerSeed: raw.samplerSeed as number,
    caseOrderPolicy: raw.caseOrderPolicy,
    baseline: structuredClone(baseline),
    holdoutUsePolicy: raw.holdoutUsePolicy,
    failureHandling: raw.failureHandling,
    unknownCostPolicy: raw.unknownCostPolicy,
    rewardScalarization: {
      rewardId: nonEmpty(rewardRaw.rewardId, "rewardId"),
      rewardVersion: nonEmpty(rewardRaw.rewardVersion, "rewardVersion"),
    },
    budgets,
    stoppingRules,
    plannedAnalysis: nonEmpty(raw.plannedAnalysis, "plannedAnalysis"),
    reliabilityThresholds,
  });
}

export function studySpecHash(spec: StudySpec): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    return `{${Object.keys(input).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(input, key))}`,
    ).join(",")}}`;
  };
  return createHash("sha256").update(canonical(spec)).digest("hex");
}

/**
 * Every generated run ID references the study-spec hash and the case content
 * hash; repetitions are zero-based.
 */
export function studyRunId(
  spec: StudySpec,
  run: { caseId: string; caseHash: string; variantKey: string; repetition: number },
): string {
  if (!spec.benchmarkCaseIds.includes(run.caseId) && !spec.holdoutCaseIds.includes(run.caseId)) {
    throw new Error(`caseId ${run.caseId} is not part of the study`);
  }
  if (!/^[0-9a-f]{64}$/.test(run.caseHash)) {
    throw new Error("caseHash must be a sha256 hex digest");
  }
  if (!Number.isSafeInteger(run.repetition) || run.repetition < 0
    || run.repetition >= spec.repetitions) {
    throw new Error(
      `repetition must be an integer from 0 to ${String(spec.repetitions - 1)}`,
    );
  }
  return [
    spec.studyId,
    studySpecHash(spec).slice(0, 12),
    run.caseId,
    run.caseHash.slice(0, 12),
    run.variantKey,
    `rep${String(run.repetition)}`,
  ].join(":");
}

/**
 * Preregistration gate. Whether the spec file is committed is executor/CLI
 * evidence; the domain never inspects Git itself.
 */
export interface PreregistrationEvidence {
  /** Commit that contains the spec file, as reported by the executor/CLI. */
  commit?: string;
  cleanWorktree?: boolean;
  allowNonPreregistered?: boolean;
}

export interface PreregistrationAttestation {
  specHash: string;
  mode: "preregistered" | "development";
  commit: string | null;
  cleanWorktree: boolean | null;
}

/** Returns traceable execution evidence; Git facts come from the executor/CLI. */
export function assertPreregisteredStudy(
  spec: StudySpec,
  evidence: PreregistrationEvidence,
): PreregistrationAttestation {
  if (evidence.commit !== undefined && evidence.commit.trim().length === 0) {
    throw new Error("commit evidence must be a non-empty identity");
  }
  const committed = evidence.commit !== undefined && evidence.cleanWorktree === true;
  if (!committed && evidence.allowNonPreregistered !== true) {
    throw new Error(
      "study spec must be committed in a clean worktree before execution",
    );
  }
  return Object.freeze({
    specHash: studySpecHash(spec),
    mode: committed ? "preregistered" : "development",
    commit: evidence.commit ?? null,
    cleanWorktree: evidence.cleanWorktree ?? null,
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${path} must be a plain JSON object`);
  }
  return value as Record<string, unknown>;
}

function exactFields(value: Record<string, unknown>, known: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new Error(`unknown field at ${path}: ${key}`);
  }
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function stringArray(value: unknown, path: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
    || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error(`${path} must be a non-empty string array`);
  }
  return value as string[];
}

function assertUnique(values: readonly string[], path: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${path} must not contain duplicates`);
  }
}

function safeCount(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${path} must be a finite non-negative number`);
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
