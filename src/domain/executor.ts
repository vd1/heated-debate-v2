import { createHash } from "node:crypto";

import type { RunSpecification } from "./matrix";
import { studySpecHash, type StudySpec } from "./study-spec";

/** Deterministic artifact path for one run, derived from its run-ID segments. */
export function artifactPathForRun(run: RunSpecification): string {
  const safe = (segment: string): string => segment.replace(/[^A-Za-z0-9_.,=-]/g, "_");
  const [studyId, specHash] = run.runId.split(":", 2);
  // Sanitization is lossy, so the full run ID digest keeps paths injective.
  const digest = createHash("sha256").update(run.runId).digest("hex").slice(0, 8);
  return [
    safe(studyId ?? "study"),
    safe(specHash ?? "spec"),
    safe(run.caseId),
    safe(run.variantKey),
    `rep${String(run.repetition)}-${digest}.jsonl`,
  ].join("/");
}

export interface MatrixExecutionInput {
  runs: readonly RunSpecification[];
  /** Already-persisted run IDs to skip when resuming. */
  completedRunIds?: ReadonlySet<string>;
  concurrency?: number;
  maxTotalRuns?: number;
  maxConsecutiveFailures?: number;
  execute: (run: RunSpecification) => Promise<void>;
}

export interface MatrixExecutionReport {
  executed: readonly string[];
  skipped: readonly string[];
  failed: readonly { runId: string; message: string }[];
  stopped?: string;
}

/**
 * Executes a matrix with bounded concurrency. Individual failures are recorded
 * and execution continues; stopping rules and the study run budget stop the
 * remaining queue, reporting it as skipped.
 */
export async function executeMatrix(input: MatrixExecutionInput): Promise<MatrixExecutionReport> {
  const concurrency = input.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive safe integer");
  }
  const completed = input.completedRunIds ?? new Set<string>();
  const outcomes = new Map<string, { kind: "executed" } | { kind: "skipped" } | { kind: "failed"; message: string }>();
  let consecutiveFailures = 0;
  let executedCount = 0;
  let stopped: string | undefined;
  let next = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (stopped !== undefined) return;
      const index = next;
      if (index >= input.runs.length) return;
      next += 1;
      const run = input.runs[index];
      if (!run) return;
      if (completed.has(run.runId)) {
        outcomes.set(run.runId, { kind: "skipped" });
        continue;
      }
      if (input.maxTotalRuns !== undefined && executedCount >= input.maxTotalRuns) {
        stopped = `study budget of ${String(input.maxTotalRuns)} total runs exhausted`;
        return;
      }
      executedCount += 1;
      try {
        await input.execute(run);
        outcomes.set(run.runId, { kind: "executed" });
        consecutiveFailures = 0;
      } catch (error) {
        outcomes.set(run.runId, {
          kind: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
        consecutiveFailures += 1;
        if (input.maxConsecutiveFailures !== undefined
          && consecutiveFailures >= input.maxConsecutiveFailures) {
          stopped = `${String(consecutiveFailures)} consecutive failures reached the stopping rule`;
          return;
        }
      }
    }
  };

  await Promise.all(Array.from(
    { length: Math.min(concurrency, input.runs.length) },
    () => worker(),
  ));

  const executed: string[] = [];
  const skipped: string[] = [];
  const failed: { runId: string; message: string }[] = [];
  for (const run of input.runs) {
    const outcome = outcomes.get(run.runId);
    if (outcome === undefined) skipped.push(run.runId);
    else if (outcome.kind === "executed") executed.push(run.runId);
    else if (outcome.kind === "skipped") skipped.push(run.runId);
    else failed.push({ runId: run.runId, message: outcome.message });
  }
  return {
    executed,
    skipped,
    failed,
    ...(stopped === undefined ? {} : { stopped }),
  };
}

export interface StudyExecutionInput {
  spec: StudySpec;
  runs: readonly RunSpecification[];
  concurrency?: number;
  /**
   * Resume evidence per run: "completed" only for an artifact whose terminal
   * event and identities were validated by the caller-provided reader.
   */
  readArtifactState: (run: RunSpecification) => Promise<"completed" | "absent" | "invalid">;
  /** Atomic claim so competing workers cannot execute the same run. */
  claim?: (runId: string) => Promise<boolean>;
  execute: (run: RunSpecification) => Promise<void>;
}

/**
 * Study-bound execution: limits and failure handling come from the
 * preregistered spec, never from invocation arguments. Prior validated
 * completions count toward the study run budget, so resume cannot exceed it.
 * Failure stopping halts scheduling at the threshold; already in-flight work
 * (at most concurrency - 1 items) completes and is recorded.
 */
export async function executeStudyRuns(input: StudyExecutionInput): Promise<MatrixExecutionReport> {
  const specHash = studySpecHash(input.spec);
  for (const run of input.runs) {
    if (run.specHash !== specHash) {
      throw new Error(`run ${run.runId} was generated from a different study spec`);
    }
  }
  const maxRuns = Math.min(
    input.spec.stoppingRules.maxRuns,
    input.spec.budgets.maxTotalRuns ?? Number.MAX_SAFE_INTEGER,
  );
  const completed = new Set<string>();
  for (const run of input.runs) {
    const state = await input.readArtifactState(run);
    if (state === "completed") completed.add(run.runId);
    else if (state === "invalid") {
      throw new Error(`artifact for ${run.runId} exists but failed validation`);
    }
  }
  const remainingBudget = maxRuns - completed.size;
  if (remainingBudget < 0) {
    throw new Error("validated completions already exceed the study run budget");
  }
  const claim = input.claim;
  return executeMatrix({
    runs: input.runs,
    completedRunIds: completed,
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    maxTotalRuns: remainingBudget,
    ...(input.spec.failureHandling === "stop-after-max-consecutive"
      && input.spec.stoppingRules.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: input.spec.stoppingRules.maxConsecutiveFailures }
      : {}),
    execute: async (run) => {
      if (claim !== undefined && !(await claim(run.runId))) {
        throw new Error(`run ${run.runId} is already claimed by another worker`);
      }
      await input.execute(run);
    },
  });
}
