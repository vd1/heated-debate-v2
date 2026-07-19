import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentReply,
  TurnRequest,
} from "../../src/domain/agent";
import { readCanonicalJsonl } from "../../src/infrastructure/jsonl-events";
import {
  runLiveDebateHarness,
  type LiveHarnessAgent,
} from "./debate-harness";

class LifecycleAgent implements LiveHarnessAgent {
  disposed = false;
  readonly messageCount = 0;

  reply(): Promise<AgentReply> {
    return Promise.reject(new Error("reply should not run"));
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

class SuccessfulLifecycleAgent implements LiveHarnessAgent {
  disposed = false;
  readonly messageCount = 0;

  constructor(private readonly text: string) {}

  reply(request: TurnRequest): Promise<AgentReply> {
    return Promise.resolve({
      text: this.text,
      durationMs: 1,
      model: request.controls.model,
      controls: {
        model: { requested: request.controls.model, forwarded: request.controls.model },
        thinkingLevel: {
          requested: request.controls.thinkingLevel,
          forwarded: request.controls.thinkingLevel,
        },
        maxOutputTokens: { requested: 128, forwarded: 128 },
      },
      usage: { inputTokens: 2, outputTokens: 1 },
      trace: {
        attempts: [{
          attempt: 1,
          status: "succeeded",
          usage: { inputTokens: 2, outputTokens: 1 },
          usageEvidence: { explicitlyReported: [], source: "test" },
        }],
      },
    });
  }

  dispose(): Promise<void> {
    this.disposed = true;
    return Promise.resolve();
  }
}

test("live harness disposes the proposer if reviewer acquisition fails", async () => {
  const proposer = new LifecycleAgent();

  let error: unknown;
  try {
    await runLiveDebateHarness({
      createAgent(role) {
        return role === "proposer"
          ? Promise.resolve(proposer)
          : Promise.reject(new Error("reviewer creation failed"));
      },
    });
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("reviewer creation failed");
  expect(proposer.disposed).toBe(true);
});

test("live harness persists and closes a canonical artifact with offline agents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heated-debate-harness-artifact-"));
  const path = join(directory, "run.jsonl");
  const proposer = new SuccessfulLifecycleAgent("Proposal");
  const reviewer = new SuccessfulLifecycleAgent("Review");

  try {
    const harness = await runLiveDebateHarness({
      roundCount: 1,
      createAgent: (role) => Promise.resolve(role === "proposer" ? proposer : reviewer),
      artifact: { path, runId: "artifact-run", secrets: ["sentinel-secret"] },
    });
    const persisted = await readCanonicalJsonl(path);

    expect(persisted.tail).toEqual({ status: "clean" });
    expect(persisted.events).toHaveLength(harness.artifact?.eventCount ?? -1);
    expect(persisted.events.at(-1)?.type).toBe("run.completed");
    expect(proposer.disposed).toBe(true);
    expect(reviewer.disposed).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
