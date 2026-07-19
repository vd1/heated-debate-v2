import type {
  AgentPort,
  AgentReply,
  RequestedControls,
  TurnRequest,
} from "./agent";
import { runDebate } from "./debate";
import type { DeepReadonly } from "./exchange";
import {
  validateCanonicalSequence,
  type CanonicalEvent,
  type CanonicalTurnReply,
} from "./events";
import type { RoleDefinition } from "./roles";

export interface ReplayParticipantConfiguration {
  role: RoleDefinition;
  controls: RequestedControls;
}

export interface ReplayConfiguration {
  debateId: string;
  topic: string;
  roundCount: number;
  proposer: ReplayParticipantConfiguration;
  reviewer: ReplayParticipantConfiguration;
}

export interface ReplayCanonicalRunInput {
  events: readonly CanonicalEvent[];
  configuration: ReplayConfiguration;
}

export interface ReplayResult {
  readonly requests: readonly DeepReadonly<TurnRequest>[];
}

export class ReplayDriftError extends Error {
  readonly name = "ReplayDriftError";

  constructor(
    readonly turnId: string,
    readonly path: string,
    readonly expected: unknown,
    readonly actual: unknown,
  ) {
    super(`replay drift for ${turnId} at ${path}`);
  }
}

interface RecordedTurn {
  roundNumber: number;
  request: TurnRequest;
  reply: CanonicalTurnReply;
}

export async function replayCanonicalRun(
  input: ReplayCanonicalRunInput,
): Promise<ReplayResult> {
  validateCanonicalSequence(input.events);
  const trace = readSuccessfulTrace(input.events);
  const configuration = structuredClone(input.configuration);

  assertNoDrift(trace.runId, {
    debateId: trace.debateId,
    topic: trace.topic,
    roundCount: trace.roundCount,
  }, {
    debateId: configuration.debateId,
    topic: configuration.topic,
    roundCount: configuration.roundCount,
  });

  const proposerReplies = trace.turns
    .filter((_, index) => index % 2 === 0)
    .map((turn) => turn.reply);
  const reviewerReplies = trace.turns
    .filter((_, index) => index % 2 === 1)
    .map((turn) => turn.reply);

  const result = await runDebate({
    debateId: configuration.debateId,
    topic: configuration.topic,
    roundCount: configuration.roundCount,
    proposer: {
      ...configuration.proposer,
      agent: new ReplayAgent(proposerReplies),
    },
    reviewer: {
      ...configuration.reviewer,
      agent: new ReplayAgent(reviewerReplies),
    },
  });

  const reconstructed = result.rounds.flatMap((round) => [
    { roundNumber: round.roundNumber, request: round.exchange.proposal.request },
    { roundNumber: round.roundNumber, request: round.exchange.review.request },
  ]);
  if (reconstructed.length !== trace.turns.length) {
    throw new Error(
      `recorded ${String(trace.turns.length)} turns but reconstructed ${String(reconstructed.length)}`,
    );
  }

  for (let index = 0; index < reconstructed.length; index += 1) {
    const recorded = trace.turns[index];
    const replayed = reconstructed[index];
    if (!recorded || !replayed) throw new Error("replay turn indexing failed");
    assertNoDrift(recorded.request.turnId, recorded.roundNumber, replayed.roundNumber, "roundNumber");
    assertNoDrift(recorded.request.turnId, recorded.request, replayed.request);
  }

  return Object.freeze({
    requests: Object.freeze(reconstructed.map((turn) => turn.request)),
  });
}

function readSuccessfulTrace(events: readonly CanonicalEvent[]): {
  runId: string;
  debateId: string;
  topic: string;
  roundCount: number;
  turns: RecordedTurn[];
} {
  const first = events[0];
  if (first?.type !== "run.started") throw new Error("canonical replay must start with run.started");
  const last = events.at(-1);
  if (last?.type !== "run.completed") {
    throw new Error("canonical replay requires a terminal run.completed event");
  }
  if (first.runId !== first.data.debateId) {
    throw new Error(`run ID ${first.runId} does not match debate ID ${first.data.debateId}`);
  }

  const turns: RecordedTurn[] = [];
  let active: { roundNumber: number; request: TurnRequest } | undefined;
  const seenTurnIds = new Set<string>();

  for (const event of events.slice(1, -1)) {
    switch (event.type) {
      case "turn.requested":
        if (active) throw new Error(`recorded turn ${active.request.turnId} has no completion`);
        if (seenTurnIds.has(event.data.request.turnId)) {
          throw new Error(`duplicate recorded turn ${event.data.request.turnId}`);
        }
        seenTurnIds.add(event.data.request.turnId);
        active = {
          roundNumber: event.data.roundNumber,
          request: structuredClone(event.data.request),
        };
        break;
      case "adapter.attempt":
        if (!active || active.request.turnId !== event.data.turnId) {
          throw new Error(`attempt does not match active turn ${event.data.turnId}`);
        }
        break;
      case "turn.completed":
        if (!active || active.request.turnId !== event.data.turnId) {
          throw new Error(`completion does not match active turn ${event.data.turnId}`);
        }
        turns.push({
          ...active,
          reply: structuredClone(event.data.reply),
        });
        active = undefined;
        break;
      case "turn.failed":
        throw new Error(`cannot deterministically replay failed turn ${event.data.turnId}`);
      case "run.failed":
        throw new Error("cannot deterministically replay a failed run");
      case "run.started":
        throw new Error("duplicate run.started event");
      case "run.completed":
        throw new Error("run.completed must be the terminal event");
    }
  }
  if (active) throw new Error(`recorded turn ${active.request.turnId} has no completion`);
  if (last.data.turnCount !== turns.length) {
    throw new Error(
      `run.completed records ${String(last.data.turnCount)} turns but trace contains ${String(turns.length)}`,
    );
  }
  if (turns.length !== first.data.roundCount * 2) {
    throw new Error(
      `recorded run requires ${String(first.data.roundCount * 2)} turns but trace contains ${String(turns.length)}`,
    );
  }

  return {
    runId: first.runId,
    debateId: first.data.debateId,
    topic: first.data.topic,
    roundCount: first.data.roundCount,
    turns,
  };
}

class ReplayAgent implements AgentPort {
  private index = 0;

  constructor(private readonly replies: readonly CanonicalTurnReply[]) {}

  reply(): Promise<AgentReply> {
    const reply = this.replies[this.index];
    if (!reply) return Promise.reject(new Error("recorded reply script is exhausted"));
    this.index += 1;
    return Promise.resolve({
      ...structuredClone(reply),
      usage: {},
      trace: { attempts: [] },
      model: structuredClone(reply.model),
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

function assertNoDrift(
  turnId: string,
  expected: unknown,
  actual: unknown,
  rootPath = "",
): void {
  const mismatch = findMismatch(expected, actual, rootPath);
  if (mismatch) {
    throw new ReplayDriftError(turnId, mismatch.path, mismatch.expected, mismatch.actual);
  }
}

function findMismatch(
  expected: unknown,
  actual: unknown,
  path: string,
): { path: string; expected: unknown; actual: unknown } | undefined {
  if (Object.is(expected, actual)) return undefined;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return { path, expected, actual };
    if (expected.length !== actual.length) return { path: `${path}.length`, expected: expected.length, actual: actual.length };
    for (let index = 0; index < expected.length; index += 1) {
      const mismatch = findMismatch(expected[index], actual[index], `${path}[${String(index)}]`);
      if (mismatch) return mismatch;
    }
    return undefined;
  }
  if (!isRecord(expected) || !isRecord(actual)) return { path, expected, actual };

  const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  for (const key of keys) {
    const childPath = path.length === 0 ? key : `${path}.${key}`;
    if (!Object.prototype.hasOwnProperty.call(expected, key)
      || !Object.prototype.hasOwnProperty.call(actual, key)) {
      return { path: childPath, expected: expected[key], actual: actual[key] };
    }
    const mismatch = findMismatch(expected[key], actual[key], childPath);
    if (mismatch) return mismatch;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
