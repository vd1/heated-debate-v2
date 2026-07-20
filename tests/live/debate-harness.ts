import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  AgentPort,
  RequestedControls,
} from "../../src/domain/agent";
import {
  runDebate,
  type DebateResult,
} from "../../src/domain/debate";
import type { ReplayConfiguration } from "../../src/domain/replay";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";
import { JsonlEventWriter } from "../../src/infrastructure/jsonl-events";
import { createPiAgentFromRuntime } from "../../src/infrastructure/pi-agent";
import {
  LIVE_DEBATE_TIMEOUT_MS,
  LIVE_MAX_OUTPUT_TOKENS,
  LIVE_MODEL,
  LIVE_TURN_TIMEOUT_MS,
  withTimeout,
} from "./support";

export interface LiveDebateHarnessResult {
  result: DebateResult;
  configuration: ReplayConfiguration;
  artifact?: { path: string; runId: string; eventCount: number };
  lifecycle: {
    proposer: { disposed: boolean; messageCount: number };
    reviewer: { disposed: boolean; messageCount: number };
  };
}

export interface LiveHarnessAgent extends AgentPort {
  readonly disposed: boolean;
  readonly messageCount: number;
}

export interface LiveDebateHarnessOptions {
  debateId?: string;
  topic?: string;
  roundCount?: number;
  timeoutMs?: number;
  createAgent?: (role: "proposer" | "reviewer") => Promise<LiveHarnessAgent>;
  artifact?: {
    path: string;
    runId: string;
    secrets: readonly string[];
  };
}

export async function runLiveDebateHarness(
  options: LiveDebateHarnessOptions = {},
): Promise<LiveDebateHarnessResult> {
  const controls: RequestedControls = {
    model: LIVE_MODEL,
    thinkingLevel: "high",
    maxOutputTokens: LIVE_MAX_OUTPUT_TOKENS,
  };
  const configuration: ReplayConfiguration = {
    debateId: options.debateId ?? "live-debate",
    topic: options.topic ?? "Propose and review a minimal in-memory FIFO queue with a fixed capacity.",
    roundCount: options.roundCount ?? 2,
    proposer: { role: PROPOSER_ROLE, controls },
    reviewer: { role: REVIEWER_ROLE, controls },
  };
  let proposer: LiveHarnessAgent | undefined;
  let reviewer: LiveHarnessAgent | undefined;
  let result: DebateResult | undefined;
  let artifactResult: LiveDebateHarnessResult["artifact"];
  let artifactWriter: JsonlEventWriter | undefined;
  let artifactEventCount = 0;
  let runError: unknown;

  try {
    const createAgent = options.createAgent ?? await defaultAgentFactory();
    proposer = await createAgent("proposer");
    reviewer = await createAgent("reviewer");
    if (options.artifact) {
      artifactWriter = await JsonlEventWriter.create(options.artifact.path, {
        secrets: options.artifact.secrets,
      });
    }
    result = await withTimeout(
      runDebate({
        ...configuration,
        proposer: { ...configuration.proposer, agent: proposer },
        reviewer: { ...configuration.reviewer, agent: reviewer },
        turnTimeoutMs: LIVE_TURN_TIMEOUT_MS,
        ...(artifactWriter === undefined || options.artifact === undefined
          ? {}
          : {
              recording: {
                runId: options.artifact.runId,
                failureSecrets: options.artifact.secrets,
                sink: {
                  append: async (event) => {
                    await artifactWriter?.append(event);
                    artifactEventCount += 1;
                  },
                  flush: async () => {
                    await artifactWriter?.flush();
                  },
                },
              },
            }),
      }),
      options.timeoutMs ?? LIVE_DEBATE_TIMEOUT_MS,
      "live debate",
    );
    if (options.artifact) {
      artifactResult = {
        path: options.artifact.path,
        runId: options.artifact.runId,
        eventCount: artifactEventCount,
      };
    }
  } catch (error) {
    runError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (artifactWriter) {
    try {
      await artifactWriter.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  for (const agent of [reviewer, proposer]) {
    if (!agent) continue;
    try {
      await agent.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (runError !== undefined || cleanupErrors.length > 0) {
    const errors = [runError, ...cleanupErrors]
      .filter((error) => error !== undefined)
      .map(toError);
    const first = errors[0];
    if (errors.length === 1 && first) throw first;
    throw new AggregateError(errors, "live debate or cleanup failed");
  }
  if (!result || !proposer || !reviewer) {
    throw new Error("live debate completed without result and both agents");
  }

  return {
    result,
    configuration: structuredClone(configuration),
    ...(artifactResult === undefined ? {} : { artifact: artifactResult }),
    lifecycle: {
      proposer: { disposed: proposer.disposed, messageCount: proposer.messageCount },
      reviewer: { disposed: reviewer.disposed, messageCount: reviewer.messageCount },
    },
  };
}

async function defaultAgentFactory(): Promise<
  (role: "proposer" | "reviewer") => Promise<LiveHarnessAgent>
> {
  const runtime = await ModelRuntime.create();
  return async () => createPiAgentFromRuntime({ runtime, model: LIVE_MODEL });
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
