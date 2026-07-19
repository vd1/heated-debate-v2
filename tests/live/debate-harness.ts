import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  AgentPort,
  RequestedControls,
} from "../../src/domain/agent";
import { projectDebateEvents } from "../../src/domain/debate-events";
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
  LIVE_MODEL,
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
    maxOutputTokens: 128,
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
  let runError: unknown;

  try {
    const createAgent = options.createAgent ?? await defaultAgentFactory();
    proposer = await createAgent("proposer");
    reviewer = await createAgent("reviewer");
    result = await withTimeout(
      runDebate({
        ...configuration,
        proposer: { ...configuration.proposer, agent: proposer },
        reviewer: { ...configuration.reviewer, agent: reviewer },
      }),
      options.timeoutMs ?? LIVE_DEBATE_TIMEOUT_MS,
      "live debate",
    );
    if (options.artifact) {
      const events = projectDebateEvents(result, options.artifact.runId);
      await persistArtifact(options.artifact.path, events, options.artifact.secrets);
      artifactResult = {
        path: options.artifact.path,
        runId: options.artifact.runId,
        eventCount: events.length,
      };
    }
  } catch (error) {
    runError = error;
  }

  const cleanupErrors: unknown[] = [];
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

async function persistArtifact(
  path: string,
  events: ReturnType<typeof projectDebateEvents>,
  secrets: readonly string[],
): Promise<void> {
  const writer = await JsonlEventWriter.create(path, { secrets });
  let appendError: unknown;
  try {
    for (const event of events) await writer.append(event);
    await writer.flush();
  } catch (error) {
    appendError = error;
  }

  let closeError: unknown;
  try {
    await writer.close();
  } catch (error) {
    closeError = error;
  }
  const errors = [appendError, closeError].filter((error) => error !== undefined).map(toError);
  if (errors.length === 1 && errors[0]) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "live artifact write or close failed");
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
