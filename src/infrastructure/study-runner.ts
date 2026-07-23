import type { AgentPort } from "../domain/agent";
import { benchmarkCaseHash, type BenchmarkCase } from "../domain/cases";
import { runDebate, type DebateEventSink } from "../domain/debate";
import { executeMatrix, type MatrixExecutionReport } from "../domain/executor";
import type { CanonicalEvent } from "../domain/events";
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
  state: "completed" | "absent";
  costScaled: bigint;
}

function validateArtifact(
  spec: StudySpec,
  run: RunSpecification,
  events: readonly CanonicalEvent[] | null,
): ArtifactValidation {
  if (events === null) return { state: "absent", costScaled: 0n };
  const start = events[0];
  if (start?.type !== "run.started" || start.data.debateId !== run.runId) {
    throw new Error(`artifact for ${run.runId} records a different run identity`);
  }
  if (events.at(-1)?.type !== "run.completed") {
    throw new Error(`artifact for ${run.runId} has no run.completed terminal`);
  }
  if (start.data.experiment === null) {
    throw new Error(`artifact for ${run.runId} records no experiment identity`);
  }
  let costScaled = 0n;
  const modelByTurn = new Map<string, { providerId: string; modelId: string }>();
  for (const event of events) {
    if (event.type === "turn.requested") {
      modelByTurn.set(event.data.request.turnId, event.data.request.controls.model);
    } else if (event.type === "adapter.attempt") {
      const model = modelByTurn.get(event.data.turnId);
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
  }
  return { state: "completed", costScaled };
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
  let totalCostScaled = 0n;
  for (const run of input.runs) {
    if (run.specHash !== specHash) {
      throw new Error(`run ${run.runId} was generated from a different study spec`);
    }
    const benchmarkCase = casesById.get(run.caseId);
    if (!benchmarkCase) throw new Error(`case ${run.caseId} is not defined`);
    if (benchmarkCaseHash(benchmarkCase).slice(0, 12) !== run.caseHash.slice(0, 12)) {
      throw new Error(`case content for ${run.caseId} changed since the matrix was generated`);
    }
    const validation = validateArtifact(input.spec, run, await input.store.read(run));
    if (validation.state === "completed") {
      completed.add(run.runId);
      totalCostScaled += validation.costScaled;
    }
  }

  const maxRuns = Math.min(
    input.spec.stoppingRules.maxRuns,
    input.spec.budgets.maxTotalRuns ?? Number.MAX_SAFE_INTEGER,
  );
  const remainingBudget = maxRuns - completed.size;
  if (remainingBudget < 0) {
    throw new Error("validated completions already exceed the study run budget");
  }
  const maxTotalScaled = input.spec.budgets.maxTotalAmount === undefined
    ? null
    : scaledCurrencyAmount(input.spec.budgets.maxTotalAmount, "budgets.maxTotalAmount");
  const perRunScaled = input.spec.budgets.perRun.maxAmount === undefined
    ? 0n
    : scaledCurrencyAmount(input.spec.budgets.perRun.maxAmount, "budgets.perRun.maxAmount");
  let reservedScaled = 0n;

  const report = await executeMatrix({
    runs: input.runs,
    completedRunIds: completed,
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
      if (!(await input.store.claim(run.runId))) {
        reservedScaled -= perRunScaled;
        throw new Error(`run ${run.runId} is already claimed by another worker`);
      }
      const benchmarkCase = casesById.get(run.caseId);
      if (!benchmarkCase) throw new Error(`case ${run.caseId} is not defined`);
      const handle = await input.store.openSink(run);
      const agents = await input.createAgents(run);
      try {
        const config = runConfigForSpecification(input.spec, run, benchmarkCase);
        await runDebate({
          ...experimentDebateInput(config, agents),
          experiment: {
            configHash: experimentConfigHash(config),
            caseId: benchmarkCase.caseId,
          },
          recording: { runId: run.runId, sink: handle.sink },
        });
        await handle.publish();
        const published = validateArtifact(input.spec, run, await input.store.read(run));
        totalCostScaled += published.costScaled;
      } catch (error) {
        await handle.discard();
        throw error;
      } finally {
        reservedScaled -= perRunScaled;
        await agents.proposer.dispose();
        await agents.reviewer.dispose();
        await input.store.release(run.runId);
      }
    },
  });
  return { ...report, attestation: input.attestation, totalCostScaled };
}
