import type { RewardResult } from "./reward";
import { parseStudySpec, type StudySpec } from "./study-spec";

export const ENGINE_SCHEMA_VERSION = "1";

export interface EngineInput {
  schemaVersion: typeof ENGINE_SCHEMA_VERSION;
  spec: StudySpec;
  run: {
    runId: string;
    caseId: string;
    point: Readonly<Record<string, unknown>>;
    repetition: number;
  };
}

export type EngineOutput =
  | { schemaVersion: typeof ENGINE_SCHEMA_VERSION; status: "reward"; reward: RewardResult }
  | {
      schemaVersion: typeof ENGINE_SCHEMA_VERSION;
      status: "failure";
      failure: { code: string; message: string };
    };

/**
 * Parses one engine invocation from untrusted stdin text. Identity-resolution
 * callers may omit run.runId; every execution path requires it.
 */
export function parseEngineInput(
  text: string,
  options: { requireRunId?: boolean } = {},
): EngineInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `engine input is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("engine input must be a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!["schemaVersion", "spec", "run"].includes(key)) {
      throw new Error(`unknown field at engine input: ${key}`);
    }
  }
  if (raw.schemaVersion !== ENGINE_SCHEMA_VERSION) {
    throw new Error(`unsupported engine schema version: ${String(raw.schemaVersion)}`);
  }
  const spec = parseStudySpec(raw.spec);
  const runRaw = raw.run;
  if (typeof runRaw !== "object" || runRaw === null || Array.isArray(runRaw)) {
    throw new Error("engine input run must be a JSON object");
  }
  const run = runRaw as Record<string, unknown>;
  for (const key of Object.keys(run)) {
    if (!["runId", "caseId", "point", "repetition"].includes(key)) {
      throw new Error(`unknown field at engine input run: ${key}`);
    }
  }
  const requireRunId = options.requireRunId ?? true;
  if (run.runId === undefined && !requireRunId) {
    run.runId = "";
  } else if (typeof run.runId !== "string" || run.runId.length === 0) {
    throw new Error("run.runId must be a non-empty string");
  }
  if (typeof run.caseId !== "string" || run.caseId.length === 0) {
    throw new Error("run.caseId must be a non-empty string");
  }
  if (typeof run.point !== "object" || run.point === null || Array.isArray(run.point)) {
    throw new Error("run.point must be a JSON object");
  }
  if (!Number.isSafeInteger(run.repetition) || (run.repetition as number) < 0) {
    throw new Error("run.repetition must be a non-negative safe integer");
  }
  return {
    schemaVersion: ENGINE_SCHEMA_VERSION,
    spec,
    run: {
      runId: run.runId as string,
      caseId: run.caseId,
      point: structuredClone(run.point) as Readonly<Record<string, unknown>>,
      repetition: run.repetition as number,
    },
  };
}

/** Serializes exactly one output line; the only bytes the engine may emit on stdout. */
export function serializeEngineOutput(output: EngineOutput): string {
  const line = JSON.stringify(output);
  if (line.includes("\n")) throw new Error("engine output must serialize to a single line");
  return `${line}\n`;
}

/** Parses engine stdout, rejecting anything but exactly one JSON line. */
export function parseEngineOutput(text: string): EngineOutput {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (trimmed.length === 0) throw new Error("engine output is empty");
  if (trimmed.includes("\n")) {
    throw new Error("engine output must be exactly one line");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(
      `engine output is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("engine output must be a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== ENGINE_SCHEMA_VERSION) {
    throw new Error(`unsupported engine schema version: ${String(raw.schemaVersion)}`);
  }
  if (raw.status === "reward") {
    validateRewardOutput(raw.reward);
    return structuredClone(parsed) as EngineOutput;
  }
  if (raw.status === "failure") {
    const failure = raw.failure;
    if (typeof failure !== "object" || failure === null || Array.isArray(failure)) {
      throw new Error("failure output must carry a failure object");
    }
    const record = failure as Record<string, unknown>;
    if (typeof record.code !== "string" || record.code.length === 0
      || typeof record.message !== "string") {
      throw new Error("failure output must carry code and message strings");
    }
    return structuredClone(parsed) as EngineOutput;
  }
  throw new Error(`unknown engine output status: ${String(raw.status)}`);
}

/** Full reward-contract validation; a bare or partial object is not a reward. */
function validateRewardOutput(value: unknown): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("reward output must carry a reward object");
  }
  const reward = value as Record<string, unknown>;
  if (reward.rewardVersion !== "1") {
    throw new Error("reward.rewardVersion must be \"1\"");
  }
  if (typeof reward.rewardId !== "string" || reward.rewardId.trim().length === 0) {
    throw new Error("reward.rewardId must be a non-empty string");
  }
  if (typeof reward.configHash !== "string" || !/^[0-9a-f]{64}$/.test(reward.configHash)) {
    throw new Error("reward.configHash must be a sha256 hex digest");
  }
  if (reward.status === "unavailable") {
    if (typeof reward.reason !== "string" || reward.reason.length === 0) {
      throw new Error("unavailable reward must carry a reason");
    }
    return;
  }
  if (reward.status !== "known") {
    throw new Error(`reward.status must be known or unavailable, got ${String(reward.status)}`);
  }
  const vector = reward.vector;
  if (typeof vector !== "object" || vector === null || Array.isArray(vector)) {
    throw new Error("known reward must carry a vector object");
  }
  const terms = [
    "qualityTerm", "tokenCostTerm", "latencyTerm",
    "failureTerm", "varianceTerm", "monetaryTerm",
  ];
  for (const term of terms) {
    const termValue = (vector as Record<string, unknown>)[term];
    if (typeof termValue !== "number" || !Number.isFinite(termValue)) {
      throw new Error(`reward.vector.${term} must be a finite number`);
    }
  }
  if (typeof reward.scalar !== "number" || !Number.isFinite(reward.scalar)) {
    throw new Error("reward.scalar must be a finite number");
  }
  const measurements = reward.measurements;
  if (typeof measurements !== "object" || measurements === null || Array.isArray(measurements)) {
    throw new Error("known reward must carry a measurements object");
  }
  const record = measurements as Record<string, unknown>;
  if (record.scope !== "single-run") {
    throw new Error("reward.measurements.scope must be \"single-run\"");
  }
  for (const name of [
    "quality", "tokensUsedFraction", "latencyFraction", "variance", "monetaryFraction",
  ]) {
    const measurement = record[name];
    if (measurement !== null
      && (typeof measurement !== "number" || !Number.isFinite(measurement))) {
      throw new Error(`reward.measurements.${name} must be null or a finite number`);
    }
  }
  if (typeof record.failed !== "boolean") {
    throw new Error("reward.measurements.failed must be a boolean");
  }
}
