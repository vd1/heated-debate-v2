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
  "pricingSnapshot", "budgets", "stoppingRules", "plannedAnalysis", "reliabilityThresholds",
];

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
  const variedParameters = variedRaw.map((item) => {
    const entry = record(item, "variedParameters entry");
    const dimensionId = nonEmpty(entry.dimensionId, "dimensionId");
    if (!eligible.has(dimensionId)) {
      throw new Error(`varied dimension ${dimensionId} is not matrix-eligible`);
    }
    if (!Array.isArray(entry.values) || entry.values.length < 2) {
      throw new Error(`varied dimension ${dimensionId} needs at least two values`);
    }
    return { dimensionId, values: entry.values as readonly unknown[] };
  });

  if (!Number.isSafeInteger(raw.repetitions) || (raw.repetitions as number) <= 0) {
    throw new Error("repetitions must be a positive safe integer");
  }
  const evaluatorsRaw = raw.evaluators;
  if (!Array.isArray(evaluatorsRaw) || evaluatorsRaw.length === 0) {
    throw new Error("evaluators must be a non-empty array");
  }
  const evaluators = evaluatorsRaw.map((item) => {
    const entry = record(item, "evaluator");
    return {
      evaluatorId: nonEmpty(entry.evaluatorId, "evaluatorId"),
      evaluatorVersion: nonEmpty(entry.evaluatorVersion, "evaluatorVersion"),
    };
  });
  const rubricRaw = record(raw.rubric, "rubric");
  const rubric = {
    rubricId: nonEmpty(rubricRaw.rubricId, "rubricId"),
    rubricVersion: nonEmpty(rubricRaw.rubricVersion, "rubricVersion"),
  };

  const budgetsRaw = record(raw.budgets, "budgets");
  const perRunRaw = record(budgetsRaw.perRun, "budgets.perRun");
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
  const reliabilityThresholds = {
    minimumSampleCount: safeCount(thresholdsRaw.minimumSampleCount, "minimumSampleCount"),
    maximumJudgeVariance: nonNegativeNumber(thresholdsRaw.maximumJudgeVariance, "maximumJudgeVariance"),
    maximumOrderingBiasEffect: nonNegativeNumber(
      thresholdsRaw.maximumOrderingBiasEffect,
      "maximumOrderingBiasEffect",
    ),
  };

  return deepFreeze({
    specVersion: "1",
    studyId,
    hypotheses,
    benchmarkCaseIds,
    holdoutCaseIds,
    fixedParameters: structuredClone(record(raw.fixedParameters, "fixedParameters")),
    variedParameters: structuredClone(variedParameters),
    repetitions: raw.repetitions as number,
    evaluators,
    rubric,
    pricingSnapshot: definePricingSnapshot(raw.pricingSnapshot as PricingSnapshot),
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

/** Every generated run ID references the study-spec hash. */
export function studyRunId(
  spec: StudySpec,
  run: { caseId: string; variantKey: string; repetition: number },
): string {
  if (!spec.benchmarkCaseIds.includes(run.caseId) && !spec.holdoutCaseIds.includes(run.caseId)) {
    throw new Error(`caseId ${run.caseId} is not part of the study`);
  }
  if (!Number.isSafeInteger(run.repetition) || run.repetition <= 0
    || run.repetition > spec.repetitions) {
    throw new Error(`repetition must be an integer from 1 to ${String(spec.repetitions)}`);
  }
  return `${spec.studyId}:${studySpecHash(spec).slice(0, 12)}:${run.caseId}:${run.variantKey}:rep${String(run.repetition)}`;
}

/**
 * Preregistration gate. Whether the spec file is committed is executor/CLI
 * evidence; the domain never inspects Git itself.
 */
export function assertPreregisteredStudy(
  spec: StudySpec,
  evidence: { committed: boolean; allowNonPreregistered?: boolean },
): void {
  void spec;
  if (!evidence.committed && evidence.allowNonPreregistered !== true) {
    throw new Error("study spec must be committed before execution");
  }
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be a JSON object`);
  }
  return value as Record<string, unknown>;
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
