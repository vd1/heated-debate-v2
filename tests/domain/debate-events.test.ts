import { describe, expect, test } from "bun:test";

import type { AgentPort, AgentReply, RequestedControls, TurnRequest } from "../../src/domain/agent";
import { projectDebateEvents } from "../../src/domain/debate-events";
import { runDebate } from "../../src/domain/debate";
import { replayCanonicalRun } from "../../src/domain/replay";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";

const CONTROLS: RequestedControls = {
  model: { providerId: "test", modelId: "model" },
  thinkingLevel: "high",
  maxOutputTokens: 128,
};

class FixedAgent implements AgentPort {
  constructor(
    private readonly text: string,
    private readonly attempts: AgentReply["trace"]["attempts"],
    private readonly toolCalls: AgentReply["toolCalls"] = [],
  ) {}

  reply(request: TurnRequest): Promise<AgentReply> {
    return Promise.resolve({
      text: this.text,
      durationMs: 12,
      model: request.controls.model,
      controls: {
        model: { requested: request.controls.model, forwarded: request.controls.model },
        thinkingLevel: {
          requested: request.controls.thinkingLevel,
          forwarded: request.controls.thinkingLevel,
        },
        maxOutputTokens: { requested: 128, forwarded: 128 },
      },
      usage: { inputTokens: 10, outputTokens: 4 },
      trace: { attempts: structuredClone(this.attempts) },
      toolCalls: structuredClone(this.toolCalls),
    });
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }
}

const FAILED_ATTEMPT: AgentReply["trace"]["attempts"][number] = {
  attempt: 1,
  status: "failed",
  httpStatus: 503,
  usage: {},
  usageEvidence: { explicitlyReported: [], source: "test" },
};
const SUCCEEDED_ATTEMPT: AgentReply["trace"]["attempts"][number] = {
  attempt: 2,
  status: "succeeded",
  httpStatus: 200,
  usage: { inputTokens: 10, outputTokens: 4 },
  usageEvidence: { explicitlyReported: [], source: "test" },
};

describe("projectDebateEvents", () => {
  test("projects exact requests, every attempt, completions, and terminal outcome", async () => {
    const result = await runDebate({
      debateId: "debate-1",
      topic: "Project this debate.",
      roundCount: 1,
      proposer: {
        agent: new FixedAgent("Proposal", [FAILED_ATTEMPT, SUCCEEDED_ATTEMPT]),
        role: PROPOSER_ROLE,
        controls: CONTROLS,
      },
      reviewer: {
        agent: new FixedAgent("Review", [{ ...SUCCEEDED_ATTEMPT, attempt: 1 }]),
        role: REVIEWER_ROLE,
        controls: CONTROLS,
      },
    });

    const events = projectDebateEvents(result, "artifact-run-9");

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.requested",
      "adapter.attempt",
      "adapter.attempt",
      "turn.completed",
      "turn.requested",
      "adapter.attempt",
      "turn.completed",
      "run.completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(events.every((event) => event.runId === "artifact-run-9")).toBe(true);

    const requests = events.filter((event) => event.type === "turn.requested");
    const firstRound = result.rounds[0];
    if (!firstRound) throw new Error("missing round");
    expect(requests.map((event) => event.data.request)).toEqual([
      firstRound.exchange.proposal.request,
      firstRound.exchange.review.request,
    ]);
    const attempts = events.filter((event) => event.type === "adapter.attempt");
    expect(attempts.map((event) => event.data.attempt)).toEqual([
      FAILED_ATTEMPT,
      SUCCEEDED_ATTEMPT,
      { ...SUCCEEDED_ATTEMPT, attempt: 1 },
    ]);
    const completion = events.find((event) => event.type === "turn.completed");
    expect(completion?.data.reply).not.toHaveProperty("usage");
    expect(completion?.data.reply).not.toHaveProperty("trace");

    const replay = await replayCanonicalRun({
      events,
      configuration: {
        debateId: "debate-1",
        topic: "Project this debate.",
        roundCount: 1,
        proposer: { role: PROPOSER_ROLE, controls: CONTROLS },
        reviewer: { role: REVIEWER_ROLE, controls: CONTROLS },
      },
    });
    expect(replay.requests).toEqual(requests.map((event) => event.data.request));
  });

  test("projects tool call records between attempts and completion for their turn", async () => {
    const proposerToolCalls: AgentReply["toolCalls"] = [
      {
        callId: "debate-1:round-1:proposer:call-1",
        ordinal: 1,
        toolId: "web-search",
        schemaVersion: "1",
        arguments: { query: "queues" },
        disposition: { status: "accepted" },
        outcome: {
          status: "succeeded",
          output: "results",
          outputBytes: 7,
          truncation: null,
        },
        durationMs: 25,
      },
      {
        callId: "debate-1:round-1:proposer:call-2",
        ordinal: 2,
        toolId: "filesystem",
        schemaVersion: "1",
        arguments: { path: "/tmp" },
        disposition: { status: "denied", reason: "tool_not_allowed" },
        outcome: null,
        durationMs: 0,
      },
    ];
    const result = await runDebate({
      debateId: "debate-1",
      topic: "Project tool calls.",
      roundCount: 1,
      proposer: {
        agent: new FixedAgent("Proposal", [{ ...SUCCEEDED_ATTEMPT, attempt: 1 }], proposerToolCalls),
        role: PROPOSER_ROLE,
        controls: CONTROLS,
      },
      reviewer: {
        agent: new FixedAgent("Review", [{ ...SUCCEEDED_ATTEMPT, attempt: 1 }]),
        role: REVIEWER_ROLE,
        controls: CONTROLS,
      },
    });

    const events = projectDebateEvents(result, "artifact-run-10");

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.requested",
      "adapter.attempt",
      "turn.tool_call",
      "turn.tool_call",
      "turn.completed",
      "turn.requested",
      "adapter.attempt",
      "turn.completed",
      "run.completed",
    ]);
    const toolCallEvents = events.filter((event) => event.type === "turn.tool_call");
    expect(toolCallEvents.map((event) => event.data.record)).toEqual([...proposerToolCalls]);
    expect(toolCallEvents.every(
      (event) => event.data.turnId === "debate-1:round-1:proposer",
    )).toBe(true);
  });
});
