import { describe, expect, test } from "bun:test";

import type { RequestedControls, TurnRequest } from "../../src/domain/agent";
import {
  parseCanonicalEvent,
  type CanonicalEvent,
  type CanonicalTurnReply,
} from "../../src/domain/events";
import {
  replayCanonicalRun,
  replayToolLoop,
  ReplayDriftError,
  type ReplayConfiguration,
} from "../../src/domain/replay";
import { definePricingSnapshot, pricingSnapshotHash } from "../../src/domain/pricing";
import type { RoleDefinition } from "../../src/domain/roles";
import type {
  ToolCallRecord,
  ToolLoopDriver,
  ToolLoopStep,
} from "../../src/domain/tool-loop";
import { createDenyAllToolPolicy, resolveToolPolicy } from "../../src/domain/tool-policy";

const PROPOSER: RoleDefinition = {
  id: "proposer",
  version: "1",
  systemPrompt: "Propose carefully.",
};
const REVIEWER: RoleDefinition = {
  id: "reviewer",
  version: "1",
  systemPrompt: "Review critically.",
};
const CONTROLS: RequestedControls = {
  model: { providerId: "test", modelId: "model-v1" },
  thinkingLevel: "high",
  maxOutputTokens: 128,
};
const CREATIVITY = {
  scheduleId: "linear-cooling" as const,
  scheduleVersion: "1" as const,
  level: 5 as const,
  instruction: "Explore radical alternatives. Question the premise. Propose unconventional approaches even if risky.",
};
const GUIDANCE = `[Creativity: 5/5] ${CREATIVITY.instruction}`;

const CONFIGURATION: ReplayConfiguration = {
  debateId: "run-1",
  topic: "Design a queue.",
  roundCount: 1,
  proposer: { role: PROPOSER, controls: CONTROLS },
  reviewer: { role: REVIEWER, controls: CONTROLS },
};
const PROPOSER_POLICY = createDenyAllToolPolicy({
  role: { id: PROPOSER.id, version: PROPOSER.version },
  phase: "proposal",
});
const REVIEWER_POLICY = createDenyAllToolPolicy({
  role: { id: REVIEWER.id, version: REVIEWER.version },
  phase: "review",
});

const PROPOSAL_REQUEST: TurnRequest = {
  turnId: "run-1:round-1:proposer",
  role: PROPOSER,
  creativity: CREATIVITY,
  context: {
    policyId: "last-exchange",
    policyVersion: "1",
    messages: [{
      role: "user",
      content: `${GUIDANCE}\n\nTopic:\nDesign a queue.`,
    }],
  },
  controls: CONTROLS,
  capabilities: PROPOSER_POLICY,
};

const REVIEW_REQUEST: TurnRequest = {
  turnId: "run-1:round-1:reviewer",
  role: REVIEWER,
  creativity: CREATIVITY,
  context: {
    policyId: "last-exchange",
    policyVersion: "1",
    messages: [{
      role: "user",
      content: `${GUIDANCE}\n\nTopic:\nDesign a queue.\n\nCurrent proposal:\nRecorded proposal`,
    }],
  },
  controls: CONTROLS,
  capabilities: REVIEWER_POLICY,
};

const FINAL_CREATIVITY = {
  scheduleId: "linear-cooling" as const,
  scheduleVersion: "1" as const,
  level: 1 as const,
  instruction: "Converge and finalize the architectural decisions into a clear bulleted plan. DO NOT write code diffs or attempt to apply changes.",
};
const FINAL_GUIDANCE = `[Creativity: 1/5] ${FINAL_CREATIVITY.instruction}`;
const SECOND_PROPOSAL_REQUEST: TurnRequest = {
  turnId: "run-1:round-2:proposer",
  role: PROPOSER,
  creativity: FINAL_CREATIVITY,
  context: {
    policyId: "last-exchange",
    policyVersion: "1",
    messages: [{
      role: "user",
      content: `${FINAL_GUIDANCE}\n\nTopic:\nDesign a queue.\n\nPrevious proposal:\nRecorded proposal\n\nReview:\nRecorded review`,
    }],
  },
  controls: CONTROLS,
  capabilities: PROPOSER_POLICY,
};
const SECOND_REVIEW_REQUEST: TurnRequest = {
  turnId: "run-1:round-2:reviewer",
  role: REVIEWER,
  creativity: FINAL_CREATIVITY,
  context: {
    policyId: "last-exchange",
    policyVersion: "1",
    messages: [{
      role: "user",
      content: `${FINAL_GUIDANCE}\n\nTopic:\nDesign a queue.\n\nPrevious review:\nRecorded review\n\nPrevious proposal:\nRecorded proposal\n\nCurrent proposal:\nSecond proposal`,
    }],
  },
  controls: CONTROLS,
  capabilities: REVIEWER_POLICY,
};

function reply(text: string): CanonicalTurnReply {
  return {
    text,
    durationMs: 1,
    model: CONTROLS.model,
    controls: {
      model: { requested: CONTROLS.model, forwarded: CONTROLS.model },
      thinkingLevel: { requested: "high", forwarded: "high" },
      maxOutputTokens: { requested: 128, forwarded: 128 },
    },
  };
}

function recordedRun(): CanonicalEvent[] {
  return [
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 0,
      type: "run.started",
      data: {
        debateId: "run-1",
        topic: "Design a queue.",
        roundCount: 1,
        controls: {
          policyId: "run-controls",
          policyVersion: "1",
          evidence: "recorded",
          turnTimeoutMs: null,
          wholeRunTimeoutMs: null,
          budget: null,
          monetary: null,
        },
        experiment: null,
      },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 1,
      type: "turn.requested",
      data: { roundNumber: 1, request: PROPOSAL_REQUEST },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 2,
      type: "turn.completed",
      data: { turnId: PROPOSAL_REQUEST.turnId, reply: reply("Recorded proposal") },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 3,
      type: "turn.requested",
      data: { roundNumber: 1, request: REVIEW_REQUEST },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 4,
      type: "turn.completed",
      data: { turnId: REVIEW_REQUEST.turnId, reply: reply("Recorded review") },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 5,
      type: "run.completed",
      data: { turnCount: 2 },
    },
  ];
}

function recordedTwoRoundRun(): CanonicalEvent[] {
  const firstRound = recordedRun().slice(0, -1);
  const start = firstRound[0];
  if (start?.type !== "run.started") throw new Error("bad fixture");
  const events: CanonicalEvent[] = [
    { ...start, data: { ...start.data, roundCount: 2 } },
    ...firstRound.slice(1),
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 5,
      type: "turn.requested",
      data: { roundNumber: 2, request: SECOND_PROPOSAL_REQUEST },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 6,
      type: "turn.completed",
      data: { turnId: SECOND_PROPOSAL_REQUEST.turnId, reply: reply("Second proposal") },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 7,
      type: "turn.requested",
      data: { roundNumber: 2, request: SECOND_REVIEW_REQUEST },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 8,
      type: "turn.completed",
      data: { turnId: SECOND_REVIEW_REQUEST.turnId, reply: reply("Second review") },
    },
    {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 9,
      type: "run.completed",
      data: { turnCount: 4 },
    },
  ];
  return events.map((event, sequence) => ({ ...event, sequence }));
}

describe("replayCanonicalRun", () => {
  test("reconstructs the exact chronological turn requests from recorded replies", async () => {
    const result = await replayCanonicalRun({
      events: recordedRun(),
      configuration: CONFIGURATION,
    });

    expect(result.requests).toEqual([PROPOSAL_REQUEST, REVIEW_REQUEST]);
    expect(Object.isFrozen(result.requests)).toBe(true);
  });

  test("replays migrated schema-v1 artifacts without inventing run-control evidence", async () => {
    const historical = recordedRun().map((event) => {
      const raw = structuredClone(event) as unknown as Record<string, unknown>;
      raw.schemaVersion = 1;
      if (raw.type === "run.started") {
        const data = raw.data as Record<string, unknown>;
        delete data.controls;
      } else if (raw.type === "turn.requested") {
        const data = raw.data as { request: { capabilities: unknown } };
        data.request.capabilities = { toolNames: [] };
      }
      return parseCanonicalEvent(JSON.stringify(raw));
    });

    const result = await replayCanonicalRun({
      events: historical,
      configuration: CONFIGURATION,
    });

    expect(result.requests).toEqual([PROPOSAL_REQUEST, REVIEW_REQUEST]);
  });

  test("rejects replay when a historical non-empty allowlist lacks policy evidence", async () => {
    const historical = recordedRun().map((event) => {
      const raw = structuredClone(event) as unknown as Record<string, unknown>;
      raw.schemaVersion = 2;
      if (raw.type === "turn.requested") {
        const data = raw.data as { request: { capabilities: unknown } };
        data.request.capabilities = {
          toolNames: raw.sequence === 1 ? ["web-search"] : [],
        };
      }
      return parseCanonicalEvent(JSON.stringify(raw));
    });

    expect(await rejectionMessage(replayCanonicalRun({
      events: historical,
      configuration: CONFIGURATION,
    }))).toBe(
      "cannot deterministically replay unrecorded tool capabilities for run-1:round-1:proposer",
    );
  });

  test("reconstructs ordered prior-exchange context across two rounds", async () => {
    const result = await replayCanonicalRun({
      events: recordedTwoRoundRun(),
      configuration: { ...CONFIGURATION, roundCount: 2 },
    });

    expect(result.requests).toEqual([
      PROPOSAL_REQUEST,
      REVIEW_REQUEST,
      SECOND_PROPOSAL_REQUEST,
      SECOND_REVIEW_REQUEST,
    ]);
  });

  test("keeps artifact run ID separate from debate protocol ID", async () => {
    const events = recordedRun().map((event) => ({ ...event, runId: "artifact-run-9" }));

    const result = await replayCanonicalRun({ events, configuration: CONFIGURATION });

    expect(result.requests).toEqual([PROPOSAL_REQUEST, REVIEW_REQUEST]);
  });

  test("detects role prompt drift before accepting the replay", async () => {
    const configuration: ReplayConfiguration = {
      ...CONFIGURATION,
      proposer: {
        ...CONFIGURATION.proposer,
        role: { ...PROPOSER, systemPrompt: "A changed prompt." },
      },
    };

    const error = await replayError(recordedRun(), configuration);
    expect(error).toBeInstanceOf(ReplayDriftError);
    expect(error.message).toBe(
      "replay drift for run-1:round-1:proposer at role.systemPrompt",
    );
  });

  test("detects requested-control drift", async () => {
    const configuration: ReplayConfiguration = {
      ...CONFIGURATION,
      reviewer: {
        ...CONFIGURATION.reviewer,
        controls: {
          ...CONTROLS,
          model: { providerId: "test", modelId: "model-v2" },
        },
      },
    };

    const error = await replayError(recordedRun(), configuration);
    expect(error.message).toBe(
      "replay drift for run-1:round-1:reviewer at controls.model.modelId",
    );
  });

  test("table-detects role identity, prompt, controls, and protocol configuration drift", async () => {
    const cases: Array<{ configuration: ReplayConfiguration; path: string }> = [
      {
        configuration: {
          ...CONFIGURATION,
          proposer: {
            ...CONFIGURATION.proposer,
            role: { ...PROPOSER, id: "changed-proposer" },
          },
        },
        path: "role.id",
      },
      {
        configuration: {
          ...CONFIGURATION,
          proposer: {
            ...CONFIGURATION.proposer,
            role: { ...PROPOSER, version: "2" },
          },
        },
        path: "role.version",
      },
      {
        configuration: {
          ...CONFIGURATION,
          proposer: {
            ...CONFIGURATION.proposer,
            role: { ...PROPOSER, systemPrompt: "Changed." },
          },
        },
        path: "role.systemPrompt",
      },
      {
        configuration: {
          ...CONFIGURATION,
          reviewer: {
            ...CONFIGURATION.reviewer,
            controls: { ...CONTROLS, thinkingLevel: "low" },
          },
        },
        path: "controls.thinkingLevel",
      },
      {
        configuration: { ...CONFIGURATION, debateId: "changed-debate" },
        path: "debateId",
      },
      {
        configuration: { ...CONFIGURATION, topic: "Changed topic." },
        path: "topic",
      },
      {
        configuration: { ...CONFIGURATION, roundCount: 2 },
        path: "roundCount",
      },
      {
        configuration: { ...CONFIGURATION, turnTimeoutMs: 1_000 },
        path: "turnTimeoutMs",
      },
      {
        configuration: {
          ...CONFIGURATION,
          budget: { maxTurns: 2, maxTokens: 100 },
        },
        path: "budget",
      },
    ];

    for (const driftCase of cases) {
      const error = await replayError(recordedRun(), driftCase.configuration);
      expect(error.path).toBe(driftCase.path);
    }
  });

  test("table-detects context policy, exact messages, and capabilities drift", async () => {
    const cases: Array<{
      mutate: (request: TurnRequest) => TurnRequest;
      path: string;
    }> = [
      {
        mutate: (request) => ({
          ...request,
          context: { ...request.context, policyId: "changed-policy" },
        }),
        path: "context.policyId",
      },
      {
        mutate: (request) => ({
          ...request,
          context: { ...request.context, policyVersion: "2" },
        }),
        path: "context.policyVersion",
      },
      {
        mutate: (request) => ({
          ...request,
          context: {
            ...request.context,
            messages: [
              { role: "assistant", content: "out of order" },
              ...request.context.messages,
            ],
          },
        }),
        path: "context.messages[0].content",
      },
      {
        mutate: (request) => ({
          ...request,
          context: {
            ...request.context,
            messages: [{ role: "user", content: "changed exact content" }],
          },
        }),
        path: "context.messages[0].content",
      },
      {
        mutate: (request) => ({
          ...request,
          capabilities: {
            ...PROPOSER_POLICY,
            allowedTools: [{ toolId: "unexpected-tool", schemaVersion: "1", maxCalls: 1 }],
          },
        }),
        path: "capabilities.allowedTools.length",
      },
    ];

    for (const driftCase of cases) {
      const events = recordedRun();
      const requested = events[1];
      if (requested?.type !== "turn.requested") throw new Error("bad fixture");
      events[1] = {
        ...requested,
        data: { ...requested.data, request: driftCase.mutate(requested.data.request) },
      };
      const error = await replayError(events, CONFIGURATION);
      expect(error.path).toBe(driftCase.path);
    }
  });

  test("uses recorded replies and detects resulting context drift", async () => {
    const events = recordedRun();
    const completion = events[2];
    if (completion?.type !== "turn.completed") throw new Error("bad fixture");
    events[2] = {
      ...completion,
      data: {
        ...completion.data,
        reply: { ...completion.data.reply, text: "Changed recorded proposal" },
      },
    };

    const error = await replayError(events, CONFIGURATION);
    expect(error.message).toBe(
      "replay drift for run-1:round-1:reviewer at context.messages[0].content",
    );
  });

  test("detects run configuration drift", async () => {
    const error = await replayError(recordedRun(), {
      ...CONFIGURATION,
      topic: "A changed topic.",
    });

    expect(error.message).toBe("replay drift for run-1 at topic");
  });

  test("treats attempts, usage, and latency as observational", async () => {
    const events = recordedRun();
    const completion = events[2];
    if (completion?.type !== "turn.completed") throw new Error("bad fixture");
    events[2] = {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 2,
      type: "adapter.attempt",
      data: {
        turnId: PROPOSAL_REQUEST.turnId,
        attempt: {
          attempt: 1,
          status: "succeeded",
          usage: { inputTokens: 999, outputTokens: 777 },
          usageEvidence: { explicitlyReported: [], source: "changed-observation" },
        },
      },
    };
    events.splice(3, 0, {
      ...completion,
      data: {
        ...completion.data,
        reply: { ...completion.data.reply, durationMs: 999_999 },
      },
    });
    const resequenced = events.map((event, sequence) => ({ ...event, sequence }));

    const result = await replayCanonicalRun({ events: resequenced, configuration: CONFIGURATION });

    expect(result.requests).toEqual([PROPOSAL_REQUEST, REVIEW_REQUEST]);
  });

  test("explicitly rejects turn failure, run failure, and a missing terminal event", async () => {
    const turnFailure = recordedRun();
    turnFailure[2] = {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 2,
      type: "turn.failed",
      data: {
        turnId: PROPOSAL_REQUEST.turnId,
        failure: { code: "provider_error", message: "failed" },
      },
    };
    expect(await rejectionMessage(replayCanonicalRun({
      events: turnFailure,
      configuration: CONFIGURATION,
    }))).toBe(`cannot deterministically replay failed turn ${PROPOSAL_REQUEST.turnId}`);

    const start = recordedRun()[0];
    if (start?.type !== "run.started") throw new Error("bad fixture");
    const runFailure: CanonicalEvent[] = [
      start,
      {
        schemaVersion: 7,
        runId: "run-1",
        sequence: 1,
        type: "run.failed",
        data: { failure: { code: "provider_error", message: "failed" } },
      },
    ];
    expect(await rejectionMessage(replayCanonicalRun({
      events: runFailure,
      configuration: CONFIGURATION,
    }))).toBe("cannot deterministically replay a failed run");

    expect(await rejectionMessage(replayCanonicalRun({
      events: recordedRun().slice(0, -1),
      configuration: CONFIGURATION,
    }))).toBe("canonical replay requires a terminal run.completed event");
  });

  test("rejects a trace with no completion for a requested turn", async () => {
    const events = recordedRun().filter((event) => event.sequence !== 2).map(
      (event, sequence) => ({ ...event, sequence }),
    );

    expect(await rejectionMessage(replayCanonicalRun({
      events,
      configuration: CONFIGURATION,
    }))).toBe("recorded turn run-1:round-1:proposer has no completion");
  });
});

async function replayError(
  events: readonly CanonicalEvent[],
  configuration: ReplayConfiguration,
): Promise<ReplayDriftError> {
  try {
    await replayCanonicalRun({ events, configuration });
  } catch (error) {
    if (error instanceof ReplayDriftError) return error;
    if (error instanceof Error) throw error;
    throw new Error(String(error));
  }
  throw new Error("expected replay to fail");
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}

describe("replayCanonicalRun tool call records", () => {
  const SEARCH_POLICY = resolveToolPolicy({
    policyId: "research",
    policyVersion: "1",
    evidence: "recorded",
    role: { id: PROPOSER.id, version: PROPOSER.version },
    phase: "proposal",
    allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 2 }],
    aggregateCallLimit: 2,
    callTimeoutMs: 5_000,
    maxResultBytes: 16_384,
    deniedCallCharge: "none",
  }, { role: { id: PROPOSER.id, version: PROPOSER.version }, phase: "proposal" });
  const SEARCH_PROPOSAL_REQUEST: TurnRequest = {
    ...PROPOSAL_REQUEST,
    capabilities: SEARCH_POLICY,
  };
  const SEARCH_CONFIGURATION: ReplayConfiguration = {
    ...CONFIGURATION,
    proposer: { ...CONFIGURATION.proposer, capabilities: SEARCH_POLICY },
  };

  const toolRecord = (ordinal: number): CanonicalEvent => ({
    schemaVersion: 7,
    runId: "run-1",
    sequence: 0,
    type: "turn.tool_call",
    data: {
      turnId: PROPOSAL_REQUEST.turnId,
      record: {
        callId: `${PROPOSAL_REQUEST.turnId}:call-${String(ordinal)}`,
        ordinal,
        toolId: "web-search",
        schemaVersion: "1",
        arguments: { query: `queues ${String(ordinal)}` },
        disposition: { status: "accepted" },
        outcome: {
          status: "succeeded",
          output: "results",
          outputBytes: 7,
          truncation: null,
        },
        durationMs: 5,
      },
    },
  });

  function withToolCalls(...ordinals: number[]): CanonicalEvent[] {
    const events = recordedRun();
    const requested = events[1];
    if (requested?.type !== "turn.requested") throw new Error("bad fixture");
    requested.data = {
      ...requested.data,
      request: SEARCH_PROPOSAL_REQUEST,
    };
    events.splice(2, 0, ...ordinals.map((ordinal) => toolRecord(ordinal)));
    return events.map((event, sequence) => ({ ...event, sequence }));
  }

  test("replays a recorded run containing ordered tool call records", async () => {
    const result = await replayCanonicalRun({
      events: withToolCalls(1, 2),
      configuration: SEARCH_CONFIGURATION,
    });

    expect(result.requests).toEqual([SEARCH_PROPOSAL_REQUEST, REVIEW_REQUEST]);
  });

  test("rejects recorded dispositions the recorded policy cannot reproduce", async () => {
    const events = recordedRun();
    events.splice(2, 0, toolRecord(1));
    const resequenced = events.map((event, sequence) => ({ ...event, sequence }));

    expect(await rejectionMessage(replayCanonicalRun({
      events: resequenced,
      configuration: CONFIGURATION,
    }))).toBe(
      "replay drift for run-1:round-1:proposer:call-1 at disposition.reason",
    );
  });

  test("rejects a tool call recorded outside its requested turn", async () => {
    const events = recordedRun();
    const orphan = toolRecord(1);
    if (orphan.type !== "turn.tool_call") throw new Error("bad fixture");
    orphan.data = { ...orphan.data, turnId: "run-1:round-9:proposer" };
    events.splice(2, 0, orphan);
    const resequenced = events.map((event, sequence) => ({ ...event, sequence }));

    expect(await rejectionMessage(replayCanonicalRun({
      events: resequenced,
      configuration: CONFIGURATION,
    }))).toBe("tool call does not match active turn run-1:round-9:proposer");
  });

  test("rejects non-consecutive recorded tool call ordinals", async () => {
    expect(await rejectionMessage(replayCanonicalRun({
      events: withToolCalls(1, 3),
      configuration: CONFIGURATION,
    }))).toBe(
      "tool call run-1:round-1:proposer:call-3 has ordinal 3 but 2 was expected",
    );
  });
});

describe("replayToolLoop", () => {
  const TOOL_POLICY = resolveToolPolicy({
    policyId: "debate-tools",
    policyVersion: "1",
    evidence: "recorded",
    role: { id: "proposer", version: "1" },
    phase: "proposal",
    allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 2 }],
    aggregateCallLimit: 2,
    callTimeoutMs: 5_000,
    maxResultBytes: 16_384,
    deniedCallCharge: "none",
  }, { role: { id: "proposer", version: "1" }, phase: "proposal" });

  const recordedCall = (ordinal: number): ToolCallRecord => ({
    callId: `run-1:round-1:proposer:call-${String(ordinal)}`,
    ordinal,
    toolId: "web-search",
    schemaVersion: "1",
    arguments: { query: `queues ${String(ordinal)}` },
    disposition: { status: "accepted" },
    outcome: {
      status: "succeeded",
      output: `results ${String(ordinal)}`,
      outputBytes: 9,
      truncation: null,
    },
    durationMs: 5,
  });

  function scriptedDriver(steps: ToolLoopStep[]): {
    driver: ToolLoopDriver;
    observed: Array<ToolCallRecord | undefined>;
  } {
    const observed: Array<ToolCallRecord | undefined> = [];
    let index = 0;
    return {
      observed,
      driver: {
        nextStep: (lastRecord) => {
          observed.push(lastRecord);
          const step = steps[index];
          index += 1;
          if (!step) throw new Error("scripted driver has no step remaining");
          return Promise.resolve(step);
        },
      },
    };
  }

  test("feeds recorded results back positionally without executing tools", async () => {
    const records = [recordedCall(1), recordedCall(2)];
    const { driver, observed } = scriptedDriver([
      { kind: "tool_call", request: { toolId: "web-search", schemaVersion: "1", arguments: { query: "queues 1" } } },
      { kind: "tool_call", request: { toolId: "web-search", schemaVersion: "1", arguments: { query: "queues 2" } } },
      { kind: "final", text: "Recorded proposal" },
    ]);

    const result = await replayToolLoop({
      driver,
      policy: TOOL_POLICY,
      records,
    });

    expect(result.finalText).toBe("Recorded proposal");
    expect(result.records).toEqual(records);
    expect(observed[1]).toEqual(records[0]);
    expect(observed[2]).toEqual(records[1]);
  });

  test("detects argument drift against the recorded call", async () => {
    const { driver } = scriptedDriver([
      { kind: "tool_call", request: { toolId: "web-search", schemaVersion: "1", arguments: { query: "different" } } },
      { kind: "final", text: "Recorded proposal" },
    ]);

    expect(await rejectionMessage(replayToolLoop({
      driver,
      policy: TOOL_POLICY,
      records: [recordedCall(1)],
    }))).toBe("replay drift for run-1:round-1:proposer:call-1 at arguments.query");
  });

  test("rejects a replay that leaves recorded tool calls unconsumed", async () => {
    const { driver } = scriptedDriver([{ kind: "final", text: "Recorded proposal" }]);

    expect(await rejectionMessage(replayToolLoop({
      driver,
      policy: TOOL_POLICY,
      records: [recordedCall(1)],
    }))).toBe("replay consumed 0 of 1 recorded tool calls");
  });

  test("detects final-response drift when an expected final text is provided", async () => {
    const { driver } = scriptedDriver([{ kind: "final", text: "Different answer" }]);

    expect(await rejectionMessage(replayToolLoop({
      driver,
      policy: TOOL_POLICY,
      records: [],
      finalText: "Recorded proposal",
    }))).toBe("replay drift for tool-loop at finalText");
  });

  test("detects recorded dispositions the policy would not reproduce", async () => {
    const denied: ToolCallRecord = {
      ...recordedCall(1),
      disposition: { status: "denied", reason: "tool_not_allowed" },
      outcome: null,
    };
    const { driver } = scriptedDriver([
      { kind: "tool_call", request: { toolId: "web-search", schemaVersion: "1", arguments: { query: "queues 1" } } },
      { kind: "final", text: "Recorded proposal" },
    ]);

    expect(await rejectionMessage(replayToolLoop({
      driver,
      policy: TOOL_POLICY,
      records: [denied],
    }))).toBe("replay drift for run-1:round-1:proposer:call-1 at disposition.reason");
  });
});

describe("replayCanonicalRun with independent tool drivers", () => {
  const SEARCH_POLICY_2 = resolveToolPolicy({
    policyId: "research",
    policyVersion: "1",
    evidence: "recorded",
    role: { id: PROPOSER.id, version: PROPOSER.version },
    phase: "proposal",
    allowedTools: [{ toolId: "web-search", schemaVersion: "1", maxCalls: 2 }],
    aggregateCallLimit: 2,
    callTimeoutMs: 5_000,
    maxResultBytes: 16_384,
    deniedCallCharge: "none",
  }, { role: { id: PROPOSER.id, version: PROPOSER.version }, phase: "proposal" });

  function scriptedTurnDriver(steps: ToolLoopStep[]): (turnId: string) => ToolLoopDriver | undefined {
    return (turnId) => {
      if (turnId !== PROPOSAL_REQUEST.turnId) return undefined;
      let index = 0;
      return {
        nextStep: () => {
          const step = steps[index];
          index += 1;
          if (!step) throw new Error("independent driver has no step remaining");
          return Promise.resolve(step);
        },
      };
    };
  }

  function annotatedToolRun(mutate?: (events: CanonicalEvent[]) => void): CanonicalEvent[] {
    const events = recordedRun();
    const requested = events[1];
    if (requested?.type !== "turn.requested") throw new Error("bad fixture");
    requested.data = {
      ...requested.data,
      request: { ...PROPOSAL_REQUEST, capabilities: SEARCH_POLICY_2 },
    };
    events.splice(2, 0, {
      schemaVersion: 7,
      runId: "run-1",
      sequence: 0,
      type: "turn.tool_call",
      data: {
        turnId: PROPOSAL_REQUEST.turnId,
        record: {
          callId: `${PROPOSAL_REQUEST.turnId}:call-1`,
          ordinal: 1,
          toolId: "web-search",
          schemaVersion: "1",
          arguments: { query: "queues" },
          disposition: { status: "accepted" },
          outcome: { status: "succeeded", output: "results", outputBytes: 7, truncation: null },
          durationMs: 5,
        },
      },
    });
    mutate?.(events);
    return events.map((event, sequence) => ({ ...event, sequence }));
  }

  const MATCHING_STEPS: ToolLoopStep[] = [
    {
      kind: "tool_call",
      request: { toolId: "web-search", schemaVersion: "1", arguments: { query: "queues" } },
    },
    { kind: "final", text: "Recorded proposal" },
  ];

  test("replays against an independent scripted driver", async () => {
    const configuration: ReplayConfiguration = {
      ...CONFIGURATION,
      proposer: { ...CONFIGURATION.proposer, capabilities: SEARCH_POLICY_2 },
    };

    const result = await replayCanonicalRun({
      events: annotatedToolRun(),
      configuration,
      toolLoopDrivers: scriptedTurnDriver(MATCHING_STEPS),
    });

    expect(result.requests).toHaveLength(2);
    expect(result.toolReplayGuarantee).toBe("independent");

    const weaker = await replayCanonicalRun({
      events: annotatedToolRun(),
      configuration,
    });
    expect(weaker.toolReplayGuarantee).toBe("reauthorization-only");

    expect(await rejectionMessage(replayCanonicalRun({
      events: annotatedToolRun(),
      configuration,
      requireIndependentToolReplay: true,
    }))).toBe(
      "independent tool replay required but no driver was supplied for run-1:round-1:proposer",
    );
  });

  test("detects recorded argument drift against the unchanged driver", async () => {
    const configuration: ReplayConfiguration = {
      ...CONFIGURATION,
      proposer: { ...CONFIGURATION.proposer, capabilities: SEARCH_POLICY_2 },
    };
    const events = annotatedToolRun((all) => {
      const call = all[2];
      if (call?.type !== "turn.tool_call") throw new Error("bad fixture");
      call.data = {
        ...call.data,
        record: { ...call.data.record, arguments: { query: "tampered" } },
      };
    });

    expect(await rejectionMessage(replayCanonicalRun({
      events,
      configuration,
      toolLoopDrivers: scriptedTurnDriver(MATCHING_STEPS),
    }))).toBe("replay drift for run-1:round-1:proposer:call-1 at arguments.query");
  });

  test("detects recorded final-text drift against the unchanged driver", async () => {
    const configuration: ReplayConfiguration = {
      ...CONFIGURATION,
      proposer: { ...CONFIGURATION.proposer, capabilities: SEARCH_POLICY_2 },
    };
    const events = annotatedToolRun((all) => {
      const completed = all[3];
      if (completed?.type !== "turn.completed") throw new Error("bad fixture");
      completed.data = {
        ...completed.data,
        reply: { ...completed.data.reply, text: "Tampered proposal" },
      };
    });

    expect(await rejectionMessage(replayCanonicalRun({
      events,
      configuration,
      toolLoopDrivers: scriptedTurnDriver(MATCHING_STEPS),
    }))).toBe("replay drift for run-1:round-1:proposer at finalText");
  });
});

describe("replayCanonicalRun monetary controls", () => {
  const PRICING = definePricingSnapshot({
    snapshotId: "pricing-test",
    snapshotVersion: "1",
    currency: "USD",
    effectiveDate: "2026-07-01",
    provenance: "test fixture",
    entries: [{
      model: { providerId: "test", modelId: "model-v1" },
      inputRatePerMillionTokens: 1,
      outputRatePerMillionTokens: 10,
      cacheReadRatePerMillionTokens: 0,
      cacheWriteRatePerMillionTokens: 0,
      reasoningBilling: { mode: "included-in-output" },
    }],
  });

  function monetaryRun(): CanonicalEvent[] {
    const events = recordedRun();
    const start = events[0];
    if (start?.type !== "run.started" || start.data.controls.evidence !== "recorded") {
      throw new Error("bad fixture");
    }
    start.data = {
      ...start.data,
      controls: {
        ...start.data.controls,
        budget: { maxTurns: 4, maxTokens: 1_000_000 },
        monetary: {
          maxAmount: 5,
          currency: "USD",
          snapshotId: "pricing-test",
          snapshotVersion: "1",
          snapshotHash: pricingSnapshotHash(PRICING),
          permitTokenOnlyAccounting: false,
        },
      },
    };
    return events;
  }

  test("replays a recorded monetary budget from an equivalent configuration", async () => {
    const result = await replayCanonicalRun({
      events: monetaryRun(),
      configuration: {
        ...CONFIGURATION,
        budget: {
          maxTurns: 4,
          maxTokens: 1_000_000,
          monetary: { maxAmount: 5, snapshot: PRICING },
        },
      },
    });

    expect(result.requests).toHaveLength(2);
  });

  test("detects monetary snapshot drift against the recorded hash", async () => {
    const alteredSnapshot = definePricingSnapshot({
      ...PRICING,
      entries: [{
        model: { providerId: "test", modelId: "model-v1" },
        inputRatePerMillionTokens: 2,
        outputRatePerMillionTokens: 10,
        cacheReadRatePerMillionTokens: 0,
        cacheWriteRatePerMillionTokens: 0,
        reasoningBilling: { mode: "included-in-output" },
      }],
    });

    expect(await rejectionMessage(replayCanonicalRun({
      events: monetaryRun(),
      configuration: {
        ...CONFIGURATION,
        budget: {
          maxTurns: 4,
          maxTokens: 1_000_000,
          monetary: { maxAmount: 5, snapshot: alteredSnapshot },
        },
      },
    }))).toBe("replay drift for run-1 at monetary.snapshotHash");
  });
});

describe("replay tool-loop guarantee reporting", () => {
  test("states the achieved guarantee and fails closed when independence is required", async () => {
    const full = await replayCanonicalRun({
      events: recordedRun(),
      configuration: CONFIGURATION,
    });
    expect(full.toolReplayGuarantee).toBe("no-tool-calls");
  });
});

describe("replay experiment identity", () => {
  function experimentRun(hash: string, caseId: string | null): CanonicalEvent[] {
    const events = recordedRun();
    const start = events[0];
    if (start?.type !== "run.started") throw new Error("bad fixture");
    start.data = { ...start.data, experiment: { configHash: hash, caseId } };
    return events;
  }

  test("compares recorded experiment identity when the configuration states one", async () => {
    const hash = "a".repeat(64);
    const ok = await replayCanonicalRun({
      events: experimentRun(hash, "case-a"),
      configuration: { ...CONFIGURATION, experiment: { configHash: hash, caseId: "case-a" } },
    });
    expect(ok.requests).toHaveLength(2);

    expect(await rejectionMessage(replayCanonicalRun({
      events: experimentRun("b".repeat(64), "case-a"),
      configuration: { ...CONFIGURATION, experiment: { configHash: hash, caseId: "case-a" } },
    }))).toBe("replay drift for run-1 at experiment.configHash");

    expect(await rejectionMessage(replayCanonicalRun({
      events: experimentRun(hash, "case-b"),
      configuration: { ...CONFIGURATION, experiment: { configHash: hash, caseId: "case-a" } },
    }))).toBe("replay drift for run-1 at experiment.caseId");

    // A migrated artifact with no recorded identity drifts against an expectation.
    expect(await rejectionMessage(replayCanonicalRun({
      events: recordedRun(),
      configuration: { ...CONFIGURATION, experiment: { configHash: hash } },
    }))).toBe("replay drift for run-1 at experiment");

    // Without an expectation, historical artifacts stay replayable.
    const historical = await replayCanonicalRun({
      events: recordedRun(),
      configuration: CONFIGURATION,
    });
    expect(historical.requests).toHaveLength(2);
  });
});
