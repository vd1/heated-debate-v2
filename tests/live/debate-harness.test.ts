import { expect, test } from "bun:test";

import type {
  AgentReply,
} from "../../src/domain/agent";
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
