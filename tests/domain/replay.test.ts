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
      data: { debateId: "run-1", topic: "Design a queue.", roundCount: 1 },
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

describe("replayCanonicalRun", () => {
  test("reconstructs the exact chronological turn requests from recorded replies", async () => {
    const result = await replayCanonicalRun({
      events: recordedRun(),
      configuration: CONFIGURATION,
    });

    expect(result.requests).toEqual([PROPOSAL_REQUEST, REVIEW_REQUEST]);
    expect(Object.isFrozen(result.requests)).toBe(true);
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
): Promise<Error> {
  try {
    await replayCanonicalRun({ events, configuration });
  } catch (error) {
    if (error instanceof Error) return error;
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
