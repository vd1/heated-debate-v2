import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AgentFailure,
  type AgentReply,
  type AgentReplyOptions,
  type TurnRequest,
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
  disposeCalls = 0;
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
        ...(request.controls.maxOutputTokens === undefined
          ? {}
          : {
              maxOutputTokens: {
                requested: request.controls.maxOutputTokens,
                forwarded: request.controls.maxOutputTokens,
              },
            }),
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
      toolCalls: [],
    });
  }

  dispose(): Promise<void> {
    this.disposeCalls += 1;
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

class WholeTimeoutAgent extends SuccessfulLifecycleAgent {
  override reply(_request: TurnRequest, options: AgentReplyOptions = {}): Promise<AgentReply> {
    return new Promise((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => {
        reject(new AgentFailure({
          code: "cancelled",
          message: "whole-run cancellation",
          trace: { attempts: [] },
        }));
      }, { once: true });
    });
  }
}

class GatedReviewerAgent extends SuccessfulLifecycleAgent {
  readonly entered: Promise<void>;
  private markEntered: (() => void) | undefined;
  private rejectReply: ((error: Error) => void) | undefined;

  constructor() {
    super("unused");
    this.entered = new Promise((resolve) => {
      this.markEntered = resolve;
    });
  }

  override reply(): Promise<AgentReply> {
    this.markEntered?.();
    return new Promise((_resolve, reject) => {
      this.rejectReply = reject;
    });
  }

  interrupt(): void {
    this.rejectReply?.(new Error("injected interruption"));
  }
}

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

test("whole-debate timeout cancels and awaits the runner before closing resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heated-debate-harness-timeout-"));
  const path = join(directory, "run.jsonl");
  const proposer = new WholeTimeoutAgent("unused");
  const reviewer = new SuccessfulLifecycleAgent("unused");

  try {
    const error = await rejectionMessage(runLiveDebateHarness({
      timeoutMs: 1_000,
      roundCount: 1,
      createAgent: (role) => Promise.resolve(role === "proposer" ? proposer : reviewer),
      artifact: { path, runId: "artifact-timeout", secrets: [] },
    }));
    expect(error).toBe("live debate timed out after 1000ms");

    const persisted = await readCanonicalJsonl(path);
    expect(persisted.tail).toEqual({ status: "clean" });
    expect(persisted.events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.requested",
      "turn.failed",
      "run.failed",
    ]);
    const started = persisted.events[0];
    if (started?.type !== "run.started") throw new Error("missing run start");
    expect(started.data.controls).toEqual({
      policyId: "run-controls",
      policyVersion: "1",
      evidence: "recorded",
      turnTimeoutMs: 60_000,
      wholeRunTimeoutMs: 1_000,
      budget: null,
    });
    const failures = persisted.events.filter(
      (event) => event.type === "turn.failed" || event.type === "run.failed",
    );
    expect(failures.map((event) => event.data.failure.code)).toEqual([
      "run_timeout",
      "run_timeout",
    ]);
    expect(proposer.disposeCalls).toBe(1);
    expect(reviewer.disposeCalls).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await readCanonicalJsonl(path)).toEqual(persisted);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("live harness commits a readable prefix between turns and retains it on interruption", async () => {
  const directory = await mkdtemp(join(tmpdir(), "heated-debate-harness-prefix-"));
  const path = join(directory, "run.jsonl");
  const proposer = new SuccessfulLifecycleAgent("Proposal");
  const reviewer = new GatedReviewerAgent();
  const running = runLiveDebateHarness({
    roundCount: 1,
    createAgent: (role) => Promise.resolve(role === "proposer" ? proposer : reviewer),
    artifact: { path, runId: "artifact-run", secrets: [] },
  });

  try {
    await reviewer.entered;
    let betweenTurns;
    try {
      betweenTurns = await readCanonicalJsonl(path);
    } finally {
      reviewer.interrupt();
    }
    expect(betweenTurns.tail).toEqual({ status: "clean" });
    expect(betweenTurns.events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.requested",
      "adapter.attempt",
      "turn.completed",
      "turn.requested",
    ]);
    expect(await rejectionMessage(running)).toBe("injected interruption");

    const afterInterruption = await readCanonicalJsonl(path);
    expect(afterInterruption.tail).toEqual({ status: "clean" });
    expect(afterInterruption.events.slice(0, betweenTurns.events.length)).toEqual(
      betweenTurns.events,
    );
    expect(afterInterruption.events.slice(betweenTurns.events.length).map((event) => event.type)).toEqual([
      "turn.failed",
      "run.failed",
    ]);
    expect(proposer.disposed).toBe(true);
    expect(reviewer.disposed).toBe(true);
  } finally {
    reviewer.interrupt();
    try {
      await running;
    } catch {
      // The interruption is the behavior under test.
    }
    await rm(directory, { recursive: true, force: true });
  }
});

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected promise to reject");
}
