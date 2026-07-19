import { describe, expect, test } from "bun:test";
import type {
  Api,
  AuthCheck,
  Model,
} from "@earendil-works/pi-ai";

import type { ModelIdentity } from "../../src/domain/agent";
import {
  createPiAgentFromRuntime,
  type PiModelRuntime,
} from "../../src/infrastructure/pi-agent";

const IDENTITY: ModelIdentity = {
  providerId: "openai-codex",
  modelId: "gpt-5.6-sol",
};

const MODEL: Model<"openai-codex-responses"> = {
  id: IDENTITY.modelId,
  name: "GPT-5.6 Sol",
  api: "openai-codex-responses",
  provider: IDENTITY.providerId,
  baseUrl: "https://invalid.example",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 372_000,
  maxTokens: 128_000,
};

class FakeRuntime implements PiModelRuntime {
  constructor(
    private readonly model: Model<Api> | undefined,
    private readonly auth: AuthCheck | undefined,
  ) {}

  getModel(providerId: string, modelId: string): Model<Api> | undefined {
    return this.model?.provider === providerId && this.model.id === modelId
      ? this.model
      : undefined;
  }

  checkAuth(): Promise<AuthCheck | undefined> {
    return Promise.resolve(this.auth);
  }

  streamSimple(): never {
    throw new Error("factory test must not call a provider");
  }
}

describe("createPiAgentFromRuntime", () => {
  test("constructs an agent after resolving model and non-secret auth status", async () => {
    const runtime = new FakeRuntime(MODEL, { type: "oauth", source: "OAuth" });

    const agent = await createPiAgentFromRuntime({ runtime, model: IDENTITY });

    expect(agent.disposed).toBe(false);
    await agent.dispose();
  });

  test("fails clearly when the requested model is unavailable", async () => {
    const runtime = new FakeRuntime(undefined, { type: "oauth", source: "OAuth" });

    const error = await captureError(createPiAgentFromRuntime({ runtime, model: IDENTITY }));

    expect(error.message).toBe("model is unavailable: openai-codex/gpt-5.6-sol");
  });

  test("fails clearly when authentication is unavailable", async () => {
    const runtime = new FakeRuntime(MODEL, undefined);

    const error = await captureError(createPiAgentFromRuntime({ runtime, model: IDENTITY }));

    expect(error.message).toBe("authentication is unavailable for provider: openai-codex");
  });
});

async function captureError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    return new Error(String(error));
  }
  throw new Error("expected operation to reject");
}
