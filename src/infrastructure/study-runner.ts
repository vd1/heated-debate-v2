import type { AgentPort } from "../domain/agent";
import { benchmarkCaseHash, type BenchmarkCase } from "../domain/cases";
import { runDebate, type DebateEventSink } from "../domain/debate";
import { executeMatrix, type MatrixExecutionReport } from "../domain/executor";
import { validateCanonicalSequence, type CanonicalEvent } from "../domain/events";
import {
  experimentConfigHash,
  experimentDebateInput,
  parseExperimentConfig,
  type ExperimentConfig,
} from "../domain/experiment-config";
import type { RunSpecification } from "../domain/matrix";
import { calculateUsageCost, scaledCurrencyAmount } from "../domain/pricing";
import {
  studySpecHash,
  type PreregistrationAttestation,
  type StudySpec,
} from "../domain/study-spec";

export interface StudyArtifactHandle {
  sink: DebateEventSink;
  /** Atomically publish the validated artifact. */
  publish(): Promise<void>;
  /** Remove temporary output after a failed or invalid run. */
  discard(): Promise<void>;
}

export interface StudyArtifactStore {
  /** Atomic claim; a false return means another worker owns the run. */
  claim(runId: string): Promise<boolean>;
  release(runId: string): Promise<void>;
  /** Published artifact events, or null when absent. */
  read(run: RunSpecification): Promise<readonly CanonicalEvent[] | null>;
  openSink(run: RunSpecification): Promise<StudyArtifactHandle>;
}

export interface ExecuteStudyInput {
  spec: StudySpec;
  attestation: PreregistrationAttestation;
  runs: readonly RunSpecification[];
  cases: readonly BenchmarkCase[];
  /** Fresh agents for every run; the executor disposes them. */
  createAgents(run: RunSpecification): Promise<{ proposer: AgentPort; reviewer: AgentPort }>;
  store: StudyArtifactStore;
  concurrency?: number;
}

export interface StudyExecutionOutcome extends MatrixExecutionReport {
  attestation: PreregistrationAttestation;
  /** Total observed spend in 1e-12 currency units across validated artifacts. */
  totalCostScaled: bigint;
}

/** Builds the validated per-run configuration from the spec, case, and point. */
export function runConfigForSpecification(
  spec: StudySpec,
  run: RunSpecification,
  benchmarkCase: BenchmarkCase,
): ExperimentConfig {
  const parameters = run.parameters;
  const controls: Record<string, unknown> = {};
  if (parameters.thinkingLevel !== undefined) controls.thinkingLevel = parameters.thinkingLevel;
  if (parameters.temperature !== undefined) controls.temperature = parameters.temperature;
  if (parameters.maxOutputTokens !== undefined) {
    controls.maxOutputTokens = parameters.maxOutputTokens;
  }
  const roundCount = parameters.roundCount ?? 2;
  return parseExperimentConfig({
    configVersion: "1",
    runId: run.runId,
    topic: benchmarkCase.topic,
    caseId: benchmarkCase.caseId,
    roundCount,
    ...(Object.keys(controls).length === 0 ? {} : { controls }),
    ...(parameters.toolCapabilityPolicy === undefined
      ? {}
      : { proposer: { capabilities: parameters.toolCapabilityPolicy } }),
    budget: {
      maxTurns: spec.budgets.perRun.maxTurns,
      maxTokens: spec.budgets.perRun.maxTokens,
      ...(spec.budgets.perRun.maxAmount === undefined
        ? {}
        : {
            monetary: {
              maxAmount: spec.budgets.perRun.maxAmount,
              snapshot: spec.pricingSnapshot,
              permitTokenOnlyAccounting: spec.unknownCostPolicy === "token-only-accounting",
            },
          }),
    },
  });
}

interface ArtifactValidation {
  state: "completed" | "failed" | "absent";
  costScaled: bigint;
  failureMessage?: string;
}

function validateArtifact(
  spec: StudySpec,
  run: RunSpecification,
  expectedConfigHash: string,
  events: readonly CanonicalEvent[] | null,
): ArtifactValidation {
  if (events === null) return { state: "absent", costScaled: 0n };
  validateCanonicalSequence(events);
  const start = events[0];
  if (start?.type !== "run.started" || start.data.debateId !== run.runId
    || start.runId !== run.runId) {
    throw new Error(`artifact for ${run.runId} records a different run identity`);
  }
  const experiment = start.data.experiment;
  if (experiment === null) {
    throw new Error(`artifact for ${run.runId} records no experiment identity`);
  }
  // Full-digest identity comparison; short prefixes in the run ID are not
  // evidence and never gate resumption on their own.
  if (experiment.specHash !== run.specHash) {
    throw new Error(`artifact for ${run.runId} was recorded under a different study spec`);
  }
  if (experiment.caseHash !== run.caseHash || experiment.caseId !== run.caseId) {
    throw new Error(`artifact for ${run.runId} was recorded against different case content`);
  }
  if (experiment.configHash !== expectedConfigHash) {
    throw new Error(`artifact for ${run.runId} records a different experiment config`);
  }
  const terminal = events.at(-1);
  if (terminal?.type !== "run.completed" && terminal?.type !== "run.failed") {
    throw new Error(`artifact for ${run.runId} has no terminal event`);
  }
  const costScaled = artifactSpend(spec, run, events);
  if (terminal.type === "run.failed") {
    return { state: "failed", costScaled, failureMessage: terminal.data.failure.message };
  }
  return { state: "completed", costScaled };
}

/**
 * Observed spend across the recorded attempts. Attempts are priced by the
 * model identity the provider RETURNED for their turn; the requested identity
 * is only a fallback for turns that never completed.
 */
function artifactSpend(
  spec: StudySpec,
  run: RunSpecification,
  events: readonly CanonicalEvent[],
): bigint {
  const requestedByTurn = new Map<string, { providerId: string; modelId: string }>();
  const returnedByTurn = new Map<string, { providerId: string; modelId: string }>();
  for (const event of events) {
    if (event.type === "turn.requested") {
      requestedByTurn.set(event.data.request.turnId, event.data.request.controls.model);
    } else if (event.type === "turn.completed") {
      returnedByTurn.set(event.data.turnId, event.data.reply.model);
    }
  }
  let costScaled = 0n;
  for (const event of events) {
    if (event.type !== "adapter.attempt") continue;
    const model = returnedByTurn.get(event.data.turnId)
      ?? requestedByTurn.get(event.data.turnId);
    if (!model) continue;
    const cost = calculateUsageCost(spec.pricingSnapshot, model, event.data.attempt.usage);
    if (cost.status === "known") {
      costScaled += cost.amountScaled;
    } else if (spec.unknownCostPolicy === "fail-closed") {
      throw new Error(
        `artifact for ${run.runId} contains unpriceable usage under fail-closed accounting`,
      );
    }
  }
  return costScaled;
}

/**
 * The D-EXECUTOR boundary: owns artifact reading and validation, fresh agents,
 * the domain runner, atomic claims, temporary publication, monetary
 * reservations, and cleanup. Resume trusts only validated artifacts.
 */
export async function executeStudy(input: ExecuteStudyInput): Promise<StudyExecutionOutcome> {
  const specHash = studySpecHash(input.spec);
  if (input.attestation.specHash !== specHash) {
    throw new Error("attestation does not match the study spec");
  }
  const casesById = new Map(input.cases.map((item) => [item.caseId, item]));
  const completed = new Set<string>();
  // Persisted run.failed artifacts are terminal: their spend is real and the
  // run is never silently re-executed against the same identity.
  const terminalFailures = new Map<string, string>();
  const expectedConfigHashes = new Map<string, string>();
  let totalCostScaled = 0n;
  for (const run of input.runs) {
    if (run.specHash !== specHash) {
      throw new Error(`run ${run.runId} was generated from a different study spec`);
    }
    const benchmarkCase = casesById.get(run.caseId);
    if (!benchmarkCase) throw new Error(`case ${run.caseId} is not defined`);
    if (benchmarkCaseHash(benchmarkCase) !== run.caseHash) {
      throw new Error(`case content for ${run.caseId} changed since the matrix was generated`);
    }
    const expectedConfigHash = experimentConfigHash(
      runConfigForSpecification(input.spec, run, benchmarkCase),
    );
    expectedConfigHashes.set(run.runId, expectedConfigHash);
    const validation = validateArtifact(
      input.spec,
      run,
      expectedConfigHash,
      await input.store.read(run),
    );
    if (validation.state === "completed") {
      completed.add(run.runId);
      totalCostScaled += validation.costScaled;
    } else if (validation.state === "failed") {
      terminalFailures.set(run.runId, validation.failureMessage ?? "recorded run failure");
      totalCostScaled += validation.costScaled;
    }
  }

  const maxRuns = Math.min(
    input.spec.stoppingRules.maxRuns,
    input.spec.budgets.maxTotalRuns ?? Number.MAX_SAFE_INTEGER,
  );
  const remainingBudget = maxRuns - completed.size - terminalFailures.size;
  if (remainingBudget < 0) {
    throw new Error("validated completions already exceed the study run budget");
  }
  const maxTotalScaled = input.spec.budgets.maxTotalAmount === undefined
    ? null
    : scaledCurrencyAmount(input.spec.budgets.maxTotalAmount, "budgets.maxTotalAmount");
  if (maxTotalScaled !== null && totalCostScaled > maxTotalScaled) {
    throw new Error("validated prior spend already exceeds the study monetary budget");
  }
  const perRunScaled = input.spec.budgets.perRun.maxAmount === undefined
    ? 0n
    : scaledCurrencyAmount(input.spec.budgets.perRun.maxAmount, "budgets.perRun.maxAmount");
  let reservedScaled = 0n;

  const report = await executeMatrix({
    runs: input.runs,
    completedRunIds: new Set([...completed, ...terminalFailures.keys()]),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
    maxTotalRuns: remainingBudget,
    ...(input.spec.failureHandling === "stop-after-max-consecutive"
      && input.spec.stoppingRules.maxConsecutiveFailures !== undefined
      ? { maxConsecutiveFailures: input.spec.stoppingRules.maxConsecutiveFailures }
      : {}),
    execute: async (run) => {
      // Reserve the declared per-run maximum before dispatch.
      if (maxTotalScaled !== null
        && totalCostScaled + reservedScaled + perRunScaled > maxTotalScaled) {
        throw new Error("study monetary budget cannot cover another run");
      }
      reservedScaled += perRunScaled;
      try {
        if (!(await input.store.claim(run.runId))) {
          throw new Error(`run ${run.runId} is already claimed by another worker`);
        }
        try {
          await executeClaimedRun(input, run, casesById, expectedConfigHashes, (spent) => {
            totalCostScaled += spent;
          });
        } finally {
          await input.store.release(run.runId);
        }
      } finally {
        reservedScaled -= perRunScaled;
      }
    },
  });
  // Runs resumed from persisted failure artifacts stay failed in the report;
  // "skipped" would misstate what the evidence records.
  const skipped = report.skipped.filter((runId) => !terminalFailures.has(runId));
  const failed = [
    ...report.failed,
    ...[...terminalFailures].map(([runId, message]) => ({ runId, message })),
  ];
  return { ...report, skipped, failed, attestation: input.attestation, totalCostScaled };
}

/**
 * Runs a single claimed specification: buffers the canonical stream, validates
 * it BEFORE publication, persists terminal-failure artifacts with their spend,
 * and never leaks sinks or agents on partial setup failures.
 */
async function executeClaimedRun(
  input: ExecuteStudyInput,
  run: RunSpecification,
  casesById: ReadonlyMap<string, BenchmarkCase>,
  expectedConfigHashes: ReadonlyMap<string, string>,
  charge: (spentScaled: bigint) => void,
): Promise<void> {
  const benchmarkCase = casesById.get(run.caseId);
  if (!benchmarkCase) throw new Error(`case ${run.caseId} is not defined`);
  const expectedConfigHash = expectedConfigHashes.get(run.runId);
  if (expectedConfigHash === undefined) {
    throw new Error(`run ${run.runId} has no expected config hash`);
  }
  const handle = await input.store.openSink(run);
  let published = false;
  try {
    const buffered: CanonicalEvent[] = [];
    const sink: DebateEventSink = {
      append: async (event) => {
        buffered.push(structuredClone(event));
        await handle.sink.append(event);
      },
      flush: () => handle.sink.flush(),
    };
    // Parse the config before agents exist so a config error leaks nothing.
    const config = runConfigForSpecification(input.spec, run, benchmarkCase);
    const agents = await input.createAgents(run);
    let dispatched = false;
    try {
      const debateInput = {
        ...experimentDebateInput(config, agents),
        experiment: {
          configHash: expectedConfigHash,
          caseId: benchmarkCase.caseId,
          specHash: run.specHash,
          caseHash: run.caseHash,
        },
        recording: { runId: run.runId, sink },
      };
      dispatched = true;
      // runDebate owns agent disposal from this point, success or failure.
      await runDebate(debateInput);
      const validation = validateArtifact(input.spec, run, expectedConfigHash, buffered);
      if (validation.state !== "completed") {
        throw new Error(`run ${run.runId} produced a ${validation.state} artifact`);
      }
      await handle.publish();
      published = true;
      charge(validation.costScaled);
    } catch (error) {
      if (!dispatched) {
        await Promise.allSettled([agents.proposer.dispose(), agents.reviewer.dispose()]);
      }
      if (!published && buffered.at(-1)?.type === "run.failed") {
        // Domain-terminal failure: the spend is real and the evidence must
        // survive, so validate and publish the failure artifact too.
        try {
          const validation = validateArtifact(input.spec, run, expectedConfigHash, buffered);
          await handle.publish();
          published = true;
          charge(validation.costScaled);
        } catch {
          charge(partialSpend(input.spec, run, buffered));
        }
      } else if (!published) {
        // Infrastructure failure: no terminal event, nothing to publish, but
        // any attempts already dispatched still spent money.
        charge(partialSpend(input.spec, run, buffered));
      }
      throw flattenError(error);
    }
  } finally {
    if (!published) await handle.discard();
  }
}

/** Surfaces AggregateError causes in the report instead of a bare summary line. */
function flattenError(error: unknown): unknown {
  if (!(error instanceof AggregateError)) return error;
  const parts = error.errors.map((item) => (item instanceof Error ? item.message : String(item)));
  return new Error([error.message, ...parts].join(": "));
}

/** Best-effort priced spend from a partial stream that never reached a terminal. */
function partialSpend(
  spec: StudySpec,
  run: RunSpecification,
  events: readonly CanonicalEvent[],
): bigint {
  try {
    return artifactSpend(spec, run, events);
  } catch {
    // Unpriceable partial usage cannot fail the already-failing run; the
    // reservation for this run has already bounded its worst case.
    return 0n;
  }
}
