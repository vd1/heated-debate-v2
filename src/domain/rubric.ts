import { createHash } from "node:crypto";

import type { ModelInputMessage } from "./context";
import type {
  AgentTrace,
  ControlReport,
  ModelIdentity,
  NormalizedUsage,
  RequestedControls,
} from "./agent";
import type { SanitizedFailure } from "./events";

export interface RubricDimension {
  dimensionId: string;
  description: string;
  scale: { min: number; max: number };
  direction: "higher-is-better" | "lower-is-better";
  requiredEvidence: "quote" | "none";
}

export interface Rubric {
  rubricVersion: "1";
  rubricId: string;
  dimensions: readonly RubricDimension[];
}

/** Parses untrusted JSON into a validated, frozen rubric. */
export function parseRubric(value: unknown): Rubric {
  const raw = record(value, "rubric");
  exact(raw, ["rubricVersion", "rubricId", "dimensions"], "rubric");
  if (raw.rubricVersion !== "1") {
    throw new Error(`unsupported rubricVersion: ${String(raw.rubricVersion)}`);
  }
  const rubricId = nonEmpty(raw.rubricId, "rubricId");
  if (!Array.isArray(raw.dimensions) || raw.dimensions.length === 0) {
    throw new Error("dimensions must be a non-empty array");
  }
  const seen = new Set<string>();
  const dimensions = raw.dimensions.map((item) => {
    const entry = record(item, "dimension");
    exact(entry, ["dimensionId", "description", "scale", "direction", "requiredEvidence"], "dimension");
    const dimensionId = nonEmpty(entry.dimensionId, "dimensionId");
    if (seen.has(dimensionId)) throw new Error(`duplicate dimension ${dimensionId}`);
    seen.add(dimensionId);
    const scale = record(entry.scale, "dimension.scale");
    exact(scale, ["min", "max"], "dimension.scale");
    if (!Number.isSafeInteger(scale.min) || !Number.isSafeInteger(scale.max)
      || (scale.max as number) <= (scale.min as number)) {
      throw new Error(`dimension ${dimensionId} scale must be integers with max > min`);
    }
    if (entry.direction !== "higher-is-better" && entry.direction !== "lower-is-better") {
      throw new Error(`dimension ${dimensionId} direction is invalid`);
    }
    if (entry.requiredEvidence !== "quote" && entry.requiredEvidence !== "none") {
      throw new Error(`dimension ${dimensionId} requiredEvidence is invalid`);
    }
    const direction: RubricDimension["direction"] = entry.direction;
    const requiredEvidence: RubricDimension["requiredEvidence"] = entry.requiredEvidence;
    return {
      dimensionId,
      description: nonEmpty(entry.description, "dimension.description"),
      scale: { min: scale.min as number, max: scale.max as number },
      direction,
      requiredEvidence,
    };
  });
  return deepFreeze({ rubricVersion: "1", rubricId, dimensions });
}

export function rubricHash(rubric: Rubric): string {
  return createHash("sha256").update(canonicalJson(rubric)).digest("hex");
}

export interface ParsedDimensionScore {
  score: number;
  evidence?: string;
}

export type JudgeOutputOutcome =
  | { status: "valid"; dimensions: Readonly<Record<string, ParsedDimensionScore>> }
  | {
      status: "partial";
      dimensions: Readonly<Record<string, ParsedDimensionScore>>;
      /** Dimensions absent or rejected; they never become zero scores. */
      missing: readonly { dimensionId: string; reason: string }[];
    }
  | { status: "malformed"; reason: string };

/**
 * Parses a judge's raw text against the rubric's schema. Valid, malformed, and
 * partial outputs produce typed outcomes; a missing dimension is reported as
 * missing with its reason and never becomes a zero score.
 */
export function parseJudgeOutput(
  rubric: Rubric,
  rawText: string,
  options: { sourceText?: string } = {},
): JudgeOutputOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    return {
      status: "malformed",
      reason: `judge output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status: "malformed", reason: "judge output must be a JSON object" };
  }
  const outer = parsed as Record<string, unknown>;
  for (const key of Object.keys(outer)) {
    if (key !== "dimensions") {
      return { status: "malformed", reason: `unknown field at judge output: ${key}` };
    }
  }
  const dimensionsRaw = outer.dimensions;
  if (typeof dimensionsRaw !== "object" || dimensionsRaw === null || Array.isArray(dimensionsRaw)) {
    return { status: "malformed", reason: "judge output must contain a dimensions object" };
  }
  const entries = dimensionsRaw as Record<string, unknown>;

  const dimensions: Record<string, ParsedDimensionScore> = {};
  const missing: { dimensionId: string; reason: string }[] = [];
  const declared = new Set(rubric.dimensions.map((dimension) => dimension.dimensionId));
  for (const key of Object.keys(entries)) {
    if (!declared.has(key)) {
      // Undeclared dimensions are reported, never silently discarded.
      missing.push({ dimensionId: key, reason: "dimension is not declared by the rubric" });
    }
  }
  for (const dimension of rubric.dimensions) {
    const entry = entries[dimension.dimensionId];
    if (entry === undefined) {
      missing.push({ dimensionId: dimension.dimensionId, reason: "absent from judge output" });
      continue;
    }
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      missing.push({ dimensionId: dimension.dimensionId, reason: "entry is not an object" });
      continue;
    }
    const item = entry as Record<string, unknown>;
    const unknownField = Object.keys(item).find((key) => key !== "score" && key !== "evidence");
    if (unknownField !== undefined) {
      missing.push({
        dimensionId: dimension.dimensionId,
        reason: `unknown field ${unknownField} in dimension entry`,
      });
      continue;
    }
    const score = item.score;
    if (!Number.isSafeInteger(score)
      || (score as number) < dimension.scale.min || (score as number) > dimension.scale.max) {
      missing.push({
        dimensionId: dimension.dimensionId,
        reason: `score must be an integer in [${String(dimension.scale.min)}, ${String(dimension.scale.max)}]`,
      });
      continue;
    }
    const evidence = item.evidence;
    if (dimension.requiredEvidence === "quote") {
      if (typeof evidence !== "string" || evidence.trim().length === 0) {
        missing.push({
          dimensionId: dimension.dimensionId,
          reason: "required quote evidence is missing",
        });
        continue;
      }
      if (options.sourceText !== undefined && !options.sourceText.includes(evidence)) {
        missing.push({
          dimensionId: dimension.dimensionId,
          reason: "quote evidence does not appear in the declared source",
        });
        continue;
      }
    }
    dimensions[dimension.dimensionId] = {
      score: score as number,
      ...(typeof evidence === "string" && evidence.length > 0 ? { evidence } : {}),
    };
  }
  if (missing.length === 0) return { status: "valid", dimensions: Object.freeze(dimensions) };
  return {
    status: "partial",
    dimensions: Object.freeze(dimensions),
    missing: Object.freeze(missing),
  };
}

/** Evidence of the executed judge request, from the reply actually returned. */
export interface ExecutedJudgeEvidence {
  returnedModel: ModelIdentity;
  controlReport: ControlReport;
  usage: NormalizedUsage;
  attempts: AgentTrace["attempts"];
  durationMs: number;
}

export interface EvaluationRecord {
  recordVersion: "1";
  rubric: { rubricId: string; rubricVersion: string; rubricHash: string };
  sourceArtifact: { runId: string; artifactHash: string };
  judge: { evaluatorId: string; evaluatorVersion: string };
  /** Artifact references declared as judge inputs. */
  declaredInputs: readonly string[];
  /** The exact messages given to the judge. */
  messages: readonly ModelInputMessage[];
  controls: RequestedControls | null;
  /** Returned model, control report, usage, and attempts for the executed request. */
  execution: ExecutedJudgeEvidence | null;
  rawResponse: string | null;
  outcome: JudgeOutputOutcome | null;
  failure: SanitizedFailure | null;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/**
 * Validates and freezes a canonical evaluation record. The parsing outcome is
 * derived from the stored raw response and rubric, never supplied, so a forged
 * outcome cannot enter the record. Success and failure are mutually exclusive.
 */
export function createEvaluationRecord(input: {
  rubric: Rubric;
  sourceArtifact: { runId: string; artifactHash: string };
  judge: { evaluatorId: string; evaluatorVersion: string };
  declaredInputs: readonly string[];
  messages: readonly ModelInputMessage[];
  controls?: RequestedControls;
  execution?: ExecutedJudgeEvidence;
  rawResponse?: string;
  sourceText?: string;
  failure?: SanitizedFailure;
}): EvaluationRecord {
  const rubric = parseRubric(structuredClone(input.rubric));
  nonEmpty(input.sourceArtifact.runId, "sourceArtifact.runId");
  if (!/^[0-9a-f]{64}$/.test(input.sourceArtifact.artifactHash)) {
    throw new Error("sourceArtifact.artifactHash must be a sha256 hex digest");
  }
  nonEmpty(input.judge.evaluatorId, "judge.evaluatorId");
  nonEmpty(input.judge.evaluatorVersion, "judge.evaluatorVersion");
  if (input.declaredInputs.length === 0) {
    throw new Error("declaredInputs must reference at least one artifact");
  }
  const seenInputs = new Set<string>();
  for (const reference of input.declaredInputs) {
    nonEmpty(reference, "declaredInputs entry");
    if (seenInputs.has(reference)) {
      throw new Error(`duplicate declared input ${reference}`);
    }
    seenInputs.add(reference);
  }
  if (input.messages.length === 0) {
    throw new Error("messages must contain the exact judge prompt");
  }
  for (const message of input.messages) {
    const role: string = message.role;
    if ((role !== "user" && role !== "assistant")
      || typeof message.content !== "string" || message.content.length === 0) {
      throw new Error("messages must be user/assistant entries with non-empty content");
    }
  }
  if (input.controls !== undefined) {
    nonEmpty(input.controls.model.providerId, "controls.model.providerId");
    nonEmpty(input.controls.model.modelId, "controls.model.modelId");
    if (!THINKING_LEVELS.has(input.controls.thinkingLevel)) {
      throw new Error("controls.thinkingLevel is invalid");
    }
  }
  if (input.execution !== undefined) {
    nonEmpty(input.execution.returnedModel.providerId, "execution.returnedModel.providerId");
    nonEmpty(input.execution.returnedModel.modelId, "execution.returnedModel.modelId");
    if (!Number.isFinite(input.execution.durationMs) || input.execution.durationMs < 0) {
      throw new Error("execution.durationMs must be a finite non-negative number");
    }
    if (input.rawResponse === undefined) {
      throw new Error("execution evidence requires the returned raw response");
    }
  }
  if (input.failure !== undefined) {
    if (input.rawResponse !== undefined && input.rawResponse.length === 0) {
      throw new Error("rawResponse must be non-empty when present");
    }
    nonEmpty(input.failure.code, "failure.code");
  } else if (input.rawResponse === undefined) {
    throw new Error("an evaluation record requires a raw response or a sanitized failure");
  }
  const outcome = input.failure !== undefined || input.rawResponse === undefined
    ? null
    : parseJudgeOutput(rubric, input.rawResponse, input.sourceText === undefined
        ? {}
        : { sourceText: input.sourceText });
  return deepFreeze({
    recordVersion: "1",
    rubric: {
      rubricId: rubric.rubricId,
      rubricVersion: rubric.rubricVersion,
      rubricHash: rubricHash(rubric),
    },
    sourceArtifact: { ...input.sourceArtifact },
    judge: { ...input.judge },
    declaredInputs: [...input.declaredInputs],
    messages: structuredClone(input.messages),
    controls: input.controls === undefined ? null : structuredClone(input.controls),
    execution: input.execution === undefined ? null : structuredClone(input.execution),
    rawResponse: input.rawResponse ?? null,
    outcome,
    failure: input.failure === undefined ? null : structuredClone(input.failure),
  });
}

export function evaluationRecordHash(recordValue: EvaluationRecord): string {
  return createHash("sha256").update(canonicalJson(recordValue)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
  ).join(",")}}`;
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

function exact(value: Record<string, unknown>, known: readonly string[], path: string): void {
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) deepFreeze(Reflect.get(value, key));
  return Object.freeze(value);
}
