import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type {
  AgentPort,
  RequestedControls,
} from "../../src/domain/agent";
import {
  runDebate,
  type DebateResult,
} from "../../src/domain/debate";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";
import { createPiAgentFromRuntime } from "../../src/infrastructure/pi-agent";
import {
  LIVE_DEBATE_TIMEOUT_MS,
  LIVE_MODEL,
  withTimeout,
} from "./support";

export interface LiveDebateHarnessResult {
  result: DebateResult;
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
}

export async function runLiveDebateHarness(
  options: LiveDebateHarnessOptions = {},
): Promise<LiveDebateHarnessResult> {
  const controls: RequestedControls = {
    model: LIVE_MODEL,
    thinkingLevel: "high",
    maxOutputTokens: 128,
  };
  let proposer: LiveHarnessAgent | undefined;
  let reviewer: LiveHarnessAgent | undefined;
  let result: DebateResult | undefined;
  let runError: unknown;

  try {
    const createAgent = options.createAgent ?? await defaultAgentFactory();
    proposer = await createAgent("proposer");
    reviewer = await createAgent("reviewer");
    result = await withTimeout(
      runDebate({
        debateId: options.debateId ?? "live-debate",
        topic: options.topic ?? "Propose and review a minimal in-memory FIFO queue with a fixed capacity.",
        roundCount: options.roundCount ?? 2,
        proposer: { agent: proposer, role: PROPOSER_ROLE, controls },
        reviewer: { agent: reviewer, role: REVIEWER_ROLE, controls },
      }),
      options.timeoutMs ?? LIVE_DEBATE_TIMEOUT_MS,
      "live debate",
    );
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
