import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentReply,
  ControlTrace,
} from "../../src/domain/agent";
import { replayCanonicalRun } from "../../src/domain/replay";
import { readCanonicalJsonl } from "../../src/infrastructure/jsonl-events";
import { runLiveDebateHarness } from "./debate-harness";
import {
  LIVE_DEBATE_TIMEOUT_MS,
  LIVE_ENABLED,
  LIVE_MODEL,
} from "./support";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

describe("two-round live debate", () => {
  if (!LIVE_ENABLED) {
    test.skip("requires HEATED_DEBATE_LIVE=1", () => {});
    return;
  }

  test("persists, parses, and replays four bounded canonical turns", async () => {
    const directory = await mkdtemp(join(tmpdir(), "heated-debate-live-artifact-"));
    temporaryDirectories.push(directory);
    const artifactPath = join(directory, "live-debate.jsonl");
    const secretSentinel = "configured-live-secret-sentinel-7f693b";
    const configuredSecrets = [
      secretSentinel,
      process.env.OPENAI_API_KEY,
      process.env.ANTHROPIC_API_KEY,
      process.env.OPENROUTER_API_KEY,
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    const { result, lifecycle, configuration, artifact } = await runLiveDebateHarness({
      artifact: {
        path: artifactPath,
        runId: "live-artifact-run",
        secrets: configuredSecrets,
      },
    });
    const turns = result.rounds.flatMap((round) => [round.exchange.proposal, round.exchange.review]);

    expect(result.rounds).toHaveLength(2);
    expect(turns).toHaveLength(4);
    expect(turns.map((turn) => turn.request.turnId)).toEqual([
      "live-debate:round-1:proposer",
      "live-debate:round-1:reviewer",
      "live-debate:round-2:proposer",
      "live-debate:round-2:reviewer",
    ]);
    expect(turns.map((turn) => turn.request.creativity.level)).toEqual([5, 5, 1, 1]);

    for (const turn of turns) {
      expect(turn.request.context.policyId).toBe("last-exchange");
      expect(turn.request.context.policyVersion).toBe("1");
      expect(turn.request.context.messages.length).toBeGreaterThan(0);
      expect(turn.request.context.messages.at(-1)?.role).toBe("user");
      expect(turn.reply.text.trim().length).toBeGreaterThan(0);
      expect(turn.reply.model.providerId).toBe(LIVE_MODEL.providerId);
      expect(turn.reply.controls.model.requested).toEqual(LIVE_MODEL);
      assertControlTrace(turn.reply.controls.model);
      expect(turn.reply.controls.thinkingLevel.requested).toBe("high");
      assertControlTrace(turn.reply.controls.thinkingLevel);
      expect(turn.reply.controls.maxOutputTokens?.requested).toBe(128);
      assertControlTrace(turn.reply.controls.maxOutputTokens);
      expect(turn.reply.trace.attempts.length).toBeGreaterThan(0);
      if (turn.reply.controls.model.providerVerified) {
        expect(turn.reply.controls.model.providerVerified).toEqual(turn.reply.model);
      }
      assertNormalizedUsage(turn.reply);
    }

    const round1 = result.rounds[0];
    const round2 = result.rounds[1];
    expect(round1?.exchange.review.request.context.messages[0]?.content).toContain(
      round1?.exchange.proposal.reply.text ?? "missing proposal",
    );
    expect(round2?.exchange.proposal.request.context.messages[0]?.content).toContain(
      round1?.exchange.proposal.reply.text ?? "missing proposal",
    );
    expect(round2?.exchange.proposal.request.context.messages[0]?.content).toContain(
      round1?.exchange.review.reply.text ?? "missing review",
    );
    expect(round2?.exchange.review.request.context.messages[0]?.content).toContain(
      round2?.exchange.proposal.reply.text ?? "missing proposal",
    );

    expect(lifecycle).toEqual({
      proposer: { disposed: true, messageCount: 0 },
      reviewer: { disposed: true, messageCount: 0 },
    });

    const persisted = await readCanonicalJsonl(artifactPath);
    expect(persisted.tail).toEqual({ status: "clean" });
    expect(artifact).toBeDefined();
    if (!artifact) throw new Error("live harness did not return artifact metadata");
    expect(persisted.events).toHaveLength(artifact.eventCount);
    expect(persisted.events[0]?.type).toBe("run.started");
    expect(persisted.events.at(-1)?.type).toBe("run.completed");
    expect(persisted.events.filter((event) => event.type === "turn.requested")).toHaveLength(4);
    expect(persisted.events.filter((event) => event.type === "turn.completed")).toHaveLength(4);

    for (const turn of turns) {
      const recordedAttempts = persisted.events
        .filter((event) => event.type === "adapter.attempt")
        .filter((event) => event.data.turnId === turn.request.turnId)
        .map((event) => event.data.attempt);
      expect(recordedAttempts).toEqual([...turn.reply.trace.attempts]);
    }

    const replay = await replayCanonicalRun({ events: persisted.events, configuration });
    expect(replay.requests).toEqual(turns.map((turn) => turn.request));
    const serializedArtifact = await readFile(artifactPath, "utf8");
    for (const secret of configuredSecrets) expect(serializedArtifact).not.toContain(secret);

    console.info(`LIVE_DEBATE_RESULT ${JSON.stringify({
      debateId: result.debateId,
      roundCount: result.rounds.length,
      turnIds: turns.map((turn) => turn.request.turnId),
      models: turns.map((turn) => turn.reply.model),
      controls: turns.map((turn) => turn.reply.controls),
      usage: turns.map((turn) => turn.reply.usage),
      lifecycle,
    })}`);
  }, LIVE_DEBATE_TIMEOUT_MS + 15_000);
});

function assertControlTrace<T>(trace: ControlTrace<T> | undefined): void {
  expect(trace).toBeDefined();
  if (!trace) return;

  if (trace.unsupported) {
    expect(trace.forwarded).toBeUndefined();
    expect(trace.adjusted).toBeUndefined();
    expect(trace.providerVerified).toBeUndefined();
    return;
  }

  expect(trace.forwarded).toBeDefined();
  if (trace.adjusted) {
    expect(trace.forwarded).toEqual(trace.adjusted.value);
  } else {
    expect(trace.forwarded).toEqual(trace.requested);
  }
}

function assertNormalizedUsage(reply: AgentReply): void {
  for (const tokens of Object.values(reply.usage)) {
    expect(tokens).toBeGreaterThanOrEqual(0);
  }
}
