import { describe, expect, test } from "bun:test";

import {
  runOptimizerFixture,
  type OptimizerStore,
  type OptimizerTrial,
} from "../../src/domain/optimizer";

class MemoryOptimizerStore implements OptimizerStore {
  saved: readonly OptimizerTrial[] = [];
  saveCount = 0;

  load(): Promise<readonly OptimizerTrial[]> {
    return Promise.resolve(this.saved);
  }

  save(trials: readonly OptimizerTrial[]): Promise<void> {
    this.saved = structuredClone(trials);
    this.saveCount += 1;
    return Promise.resolve();
  }
}

const SPACE = {
  dimensions: {
    thinkingLevel: ["low", "medium", "high"],
    temperature: [0.2, 0.7],
  },
};

// A toy objective with one clear optimum: high thinking at low temperature.
const objective = (point: Readonly<Record<string, unknown>>): Promise<number> => {
  const thinking = { low: 0, medium: 0.5, high: 1 }[point.thinkingLevel as string] ?? 0;
  const temperature = point.temperature as number;
  return Promise.resolve(thinking - Math.abs(temperature - 0.2));
};

describe("optimizer fixture", () => {
  test("generates deterministic trials and selects the best", async () => {
    const store = new MemoryOptimizerStore();
    const first = await runOptimizerFixture({
      searchSpace: SPACE,
      samplerSeed: 42,
      trialCount: 6,
      objective,
      store,
    });

    expect(first.trials).toHaveLength(6);
    expect(new Set(first.trials.map((trial) => trial.trialId)).size).toBe(6);
    if (first.best?.result?.status !== "known") throw new Error("missing best");
    expect(first.best.point).toEqual({ thinkingLevel: "high", temperature: 0.2 });
    expect(first.best.result.scalar).toBe(1);

    // The same seed reproduces the identical trial sequence.
    const again = await runOptimizerFixture({
      searchSpace: SPACE,
      samplerSeed: 42,
      trialCount: 6,
      objective,
      store: new MemoryOptimizerStore(),
    });
    expect(again.trials).toEqual(first.trials);
  });

  test("persists after each trial and resumes without re-running", async () => {
    const store = new MemoryOptimizerStore();
    let calls = 0;
    const counted = (point: Readonly<Record<string, unknown>>): Promise<number> => {
      calls += 1;
      return objective(point);
    };
    await runOptimizerFixture({
      searchSpace: SPACE,
      samplerSeed: 7,
      trialCount: 4,
      objective: counted,
      store,
    });
    expect(calls).toBe(4);
    expect(store.saveCount).toBe(4);

    const resumed = await runOptimizerFixture({
      searchSpace: SPACE,
      samplerSeed: 7,
      trialCount: 6,
      objective: counted,
      store,
    });
    // Only the two new trials execute.
    expect(calls).toBe(6);
    expect(resumed.trials).toHaveLength(6);
  });

  test("records objective failures and keeps selecting from known trials", async () => {
    const store = new MemoryOptimizerStore();
    const flaky = (point: Readonly<Record<string, unknown>>): Promise<number> =>
      point.thinkingLevel === "medium"
        ? Promise.reject(new Error("objective crashed"))
        : objective(point);

    const outcome = await runOptimizerFixture({
      searchSpace: SPACE,
      samplerSeed: 3,
      trialCount: 6,
      objective: flaky,
      store,
    });

    expect(outcome.trials.filter((trial) => trial.result?.status === "failed")).toHaveLength(2);
    if (outcome.best?.result?.status !== "known") throw new Error("missing best");
    expect(outcome.best.point.thinkingLevel).toBe("high");
  });
});
