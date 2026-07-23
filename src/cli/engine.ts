import { spawnSync } from "node:child_process";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { ScriptedAgent, type AgentPort, type ScriptedReply } from "../domain/agent";
import { benchmarkCaseHash, defineCaseSet } from "../domain/cases";
import { DebateRunFailure, runDebate } from "../domain/debate";
import {
  parseEngineInput,
  serializeEngineOutput,
  type EngineOutput,
  ENGINE_SCHEMA_VERSION,
} from "../domain/engine-schema";
import { artifactPathForRun } from "../domain/executor";
import {
  experimentConfigHash,
  experimentDebateInput,
} from "../domain/experiment-config";
import { runDeterministicEvaluators } from "../domain/evaluators";
import type { RunSpecification } from "../domain/matrix";
import { computeReward, resolveScalarizer, type Measurement } from "../domain/reward";
import { serializeCanonicalEvent, type CanonicalEvent } from "../domain/events";
import {
  assertPreregisteredStudy,
  studyRunId,
  studySpecHash,
} from "../domain/study-spec";
import { runConfigForSpecification } from "../infrastructure/study-runner";

interface EngineArgs {
  casesPath: string;
  artifactRoot: string;
  agents: "scripted" | "hang" | "pi";
  allowNonPreregistered: boolean;
  attestationOut?: string;
}

function parseArgs(argv: readonly string[]): EngineArgs {
  const args: Partial<EngineArgs> = { allowNonPreregistered: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`missing value for ${flag ?? ""}`);
      return value;
    };
    if (flag === "--cases") args.casesPath = next();
    else if (flag === "--artifact-root") args.artifactRoot = next();
    else if (flag === "--agents") args.agents = next() as EngineArgs["agents"];
    else if (flag === "--allow-non-preregistered") args.allowNonPreregistered = true;
    else if (flag === "--attestation-out") args.attestationOut = next();
    else throw new Error(`unknown flag: ${flag ?? ""}`);
  }
  if (args.casesPath === undefined) throw new Error("--cases is required");
  if (args.artifactRoot === undefined) throw new Error("--artifact-root is required");
  if (args.agents !== "scripted" && args.agents !== "hang" && args.agents !== "pi") {
    throw new Error("--agents must be scripted, hang, or pi");
  }
  return args as EngineArgs;
}

function gitEvidence(): { commit?: string; cleanWorktree?: boolean } {
  const envCommit = process.env.HEATED_DEBATE_GIT_COMMIT;
  const envClean = process.env.HEATED_DEBATE_GIT_CLEAN;
  if (envCommit !== undefined || envClean !== undefined) {
    return {
      ...(envCommit === undefined ? {} : { commit: envCommit }),
      ...(envClean === undefined ? {} : { cleanWorktree: envClean === "1" }),
    };
  }
  const commit = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" });
  if (commit.status !== 0 || status.status !== 0) return {};
  return { commit: commit.stdout.trim(), cleanWorktree: status.stdout.trim().length === 0 };
}

function scriptedReplyFor(model: { providerId: string; modelId: string }, text: string): ScriptedReply {
  return {
    text,
    durationMs: 5,
    model,
    controls: {
      model: { requested: model, forwarded: model },
      thinkingLevel: { requested: "high", forwarded: "high" },
    },
    usage: { values: {}, explicitlyReported: [] },
    trace: {
      attempts: [{
        attempt: 1,
        status: "succeeded",
        httpStatus: 200,
        usage: { inputTokens: 50, outputTokens: 20 },
        usageEvidence: { explicitlyReported: [], source: "engine-scripted" },
      }],
    },
  };
}

async function createAgents(
  mode: EngineArgs["agents"],
  model: { providerId: string; modelId: string },
  roundCount: number,
): Promise<{ proposer: AgentPort; reviewer: AgentPort }> {
  if (mode === "pi") {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const { createPiAgentFromRuntime } = await import("../infrastructure/pi-agent");
    const runtime = await ModelRuntime.create();
    return {
      proposer: await createPiAgentFromRuntime({ runtime, model }),
      reviewer: await createPiAgentFromRuntime({ runtime, model }),
    };
  }
  if (mode === "hang") {
    const hang: AgentPort = {
      reply: () => new Promise(() => {
        // Never settles; used by the interruption contract test.
      }),
      dispose: () => Promise.resolve(),
    };
    return { proposer: hang, reviewer: hang };
  }
  const replies = (prefix: string): ScriptedReply[] =>
    Array.from({ length: roundCount }, (_, round) =>
      scriptedReplyFor(model, `- ${prefix} argument for round ${String(round + 1)}`));
  return {
    proposer: new ScriptedAgent(replies("proposer")),
    reviewer: new ScriptedAgent(replies("reviewer")),
  };
}

export async function runEngine(
  argv: readonly string[],
  stdinText: string,
  emit: (line: string) => void,
  diagnose: (line: string) => void,
): Promise<number> {
  const fail = (code: string, message: string): EngineOutput => ({
    schemaVersion: ENGINE_SCHEMA_VERSION,
    status: "failure",
    failure: { code, message },
  });
  let args: EngineArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    emit(serializeEngineOutput(fail("invalid_arguments", messageOf(error))));
    return 2;
  }
  let input;
  try {
    input = parseEngineInput(stdinText);
  } catch (error) {
    emit(serializeEngineOutput(fail("invalid_input", messageOf(error))));
    return 2;
  }
  try {
    const attestation = assertPreregisteredStudy(input.spec, {
      ...gitEvidence(),
      ...(args.allowNonPreregistered ? { allowNonPreregistered: true } : {}),
    });
    diagnose(`attestation ${JSON.stringify(attestation)}`);
    if (args.attestationOut !== undefined) {
      await writeFile(args.attestationOut, `${JSON.stringify(attestation)}\n`);
    }

    const cases = defineCaseSet(JSON.parse(await Bun.file(args.casesPath).text()) as unknown[]);
    const benchmarkCase = cases.find((item) => item.caseId === input.run.caseId);
    if (!benchmarkCase) throw new Error(`case ${input.run.caseId} is not defined`);
    const caseHash = benchmarkCaseHash(benchmarkCase);
    const expectedRunId = studyRunId(input.spec, {
      caseId: input.run.caseId,
      caseHash,
      point: input.run.point,
      repetition: input.run.repetition,
    });
    if (expectedRunId !== input.run.runId) {
      emit(serializeEngineOutput(fail(
        "run_identity_mismatch",
        `expected ${expectedRunId}`,
      )));
      return 2;
    }
    const run: RunSpecification = Object.freeze({
      purpose: "selection" as const,
      runId: input.run.runId,
      specHash: studySpecHash(input.spec),
      caseId: input.run.caseId,
      caseHash,
      holdout: input.spec.holdoutCaseIds.includes(input.run.caseId),
      variantKey: input.run.runId.split(":")[4] ?? "",
      parameters: Object.freeze({ ...input.spec.fixedParameters, ...input.run.point }),
      repetition: input.run.repetition,
    });

    const config = runConfigForSpecification(input.spec, run, benchmarkCase);
    const artifactPath = join(args.artifactRoot, artifactPathForRun(run));
    await mkdir(dirname(artifactPath), { recursive: true });
    const temporary = `${artifactPath}.tmp`;
    const buffered: CanonicalEvent[] = [];
    const events = {
      append: (event: CanonicalEvent) => {
        buffered.push(structuredClone(event));
        return Promise.resolve();
      },
      flush: async () => {
        await writeFile(
          temporary,
          buffered.map((event) => serializeCanonicalEvent(event, { secrets: [] })).join("\n") + "\n",
        );
      },
    };

    const interruption = { received: false };
    const controller = new AbortController();
    const onSignal = (): void => {
      interruption.received = true;
      controller.abort();
    };
    process.once("SIGTERM", onSignal);
    process.once("SIGINT", onSignal);
    // Created last before dispatch: runDebate owns agent disposal from the
    // moment it is called, success or failure.
    const agents = await createAgents(args.agents, config.proposer.controls.model, config.roundCount);
    try {
      await runDebate({
        ...experimentDebateInput(config, agents),
        experiment: {
          configHash: experimentConfigHash(config),
          caseId: benchmarkCase.caseId,
          specHash: run.specHash,
          caseHash: run.caseHash,
        },
        recording: { runId: run.runId, sink: events },
        signal: controller.signal,
        wholeRunTimeoutMs: config.wholeRunTimeoutMs ?? 120_000,
      });
    } catch (error) {
      if (interruption.received) {
        // Interruptions are retryable; they leave no artifact behind.
        await rm(temporary, { force: true });
        emit(serializeEngineOutput(fail("interrupted", "engine received a termination signal")));
        return 130;
      }
      if (buffered.at(-1)?.type === "run.failed") {
        // Terminal failures are evidence: persist the run.failed artifact so
        // resumption and spend accounting can see it.
        await events.flush();
        await rename(temporary, artifactPath);
        diagnose(`artifact ${artifactPath}`);
      } else {
        await rm(temporary, { force: true });
      }
      throw error;
    } finally {
      process.removeListener("SIGTERM", onSignal);
      process.removeListener("SIGINT", onSignal);
    }
    await events.flush();
    await rename(temporary, artifactPath);
    diagnose(`artifact ${artifactPath}`);

    const scores = runDeterministicEvaluators(buffered, {
      tokenBudget: input.spec.budgets.perRun.maxTokens,
      latencyTargetMs: 60_000,
    });
    // Every measurement carries its evidence state; a missing score reaches
    // the scalarizer as unavailable, never as a manufactured zero.
    const measurement = (evaluatorId: string, invert: boolean): Measurement => {
      const found = scores.find((score) => score.evaluatorId === evaluatorId);
      if (found?.status !== "known") {
        return {
          status: "unavailable",
          reason: found?.status === "unavailable"
            ? found.reason
            : `${evaluatorId} produced no score`,
        };
      }
      return { status: "known", value: invert ? 1 - found.score : found.score };
    };
    // The executed objective is the preregistered scalarizer, nothing else.
    const reward = computeReward(resolveScalarizer(input.spec.rewardScalarization), {
      quality: measurement("deterministic-completion", false),
      tokensUsedFraction: measurement("deterministic-token-usage", true),
      latencyFraction: measurement("deterministic-latency", true),
      failed: false,
      variance: {
        status: "unavailable",
        reason: "a single run carries no reward-variance sample",
      },
    });
    emit(serializeEngineOutput({
      schemaVersion: ENGINE_SCHEMA_VERSION,
      status: "reward",
      reward,
    }));
    return 0;
  } catch (error) {
    const code = error instanceof DebateRunFailure ? error.code : "engine_failure";
    emit(serializeEngineOutput(fail(code, messageOf(error))));
    return 1;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const stdinText = await Bun.stdin.text();
  const exitCode = await runEngine(
    process.argv.slice(2),
    stdinText,
    (line) => {
      process.stdout.write(line);
    },
    (line) => {
      process.stderr.write(`${line}\n`);
    },
  );
  process.exit(exitCode);
}
