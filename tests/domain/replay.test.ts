import { describe, expect, test } from "bun:test";

import type { RequestedControls, TurnRequest } from "../../src/domain/agent";
import type { CanonicalEvent, CanonicalTurnReply } from "../../src/domain/events";
import {
  replayCanonicalRun,
  ReplayDriftError,
  type ReplayConfiguration,
} from "../../src/domain/replay";
import type { RoleDefinition } from "../../src/domain/roles";

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
  capabilities: { toolNames: [] },
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
  capabilities: { toolNames: [] },
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
  capabilities: { toolNames: [] },
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
  capabilities: { toolNames: [] },
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
      schemaVersion: 1,
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
          turnTimeoutMs: null,
          budget: null,
        },
      },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 1,
      type: "turn.requested",
      data: { roundNumber: 1, request: PROPOSAL_REQUEST },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 2,
      type: "turn.completed",
      data: { turnId: PROPOSAL_REQUEST.turnId, reply: reply("Recorded proposal") },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 3,
      type: "turn.requested",
      data: { roundNumber: 1, request: REVIEW_REQUEST },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 4,
      type: "turn.completed",
      data: { turnId: REVIEW_REQUEST.turnId, reply: reply("Recorded review") },
    },
    {
      schemaVersion: 1,
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
      schemaVersion: 1,
      runId: "run-1",
      sequence: 5,
      type: "turn.requested",
      data: { roundNumber: 2, request: SECOND_PROPOSAL_REQUEST },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 6,
      type: "turn.completed",
      data: { turnId: SECOND_PROPOSAL_REQUEST.turnId, reply: reply("Second proposal") },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 7,
      type: "turn.requested",
      data: { roundNumber: 2, request: SECOND_REVIEW_REQUEST },
    },
    {
      schemaVersion: 1,
      runId: "run-1",
      sequence: 8,
      type: "turn.completed",
      data: { turnId: SECOND_REVIEW_REQUEST.turnId, reply: reply("Second review") },
    },
    {
      schemaVersion: 1,
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
          capabilities: { toolNames: ["unexpected-tool"] },
        }),
        path: "capabilities.toolNames.length",
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
      schemaVersion: 1,
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
      schemaVersion: 1,
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
        schemaVersion: 1,
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
