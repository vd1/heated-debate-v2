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

/** Parses one engine invocation from untrusted stdin text. */
export function parseEngineInput(text: string): EngineInput {
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
  if (typeof run.runId !== "string" || run.runId.length === 0) {
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
      runId: run.runId,
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
    if (typeof raw.reward !== "object" || raw.reward === null) {
      throw new Error("reward output must carry a reward object");
    }
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
