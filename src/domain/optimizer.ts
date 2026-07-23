export interface OptimizerSearchSpace {
  /** Dimension ID to its finite ordered candidate values. */
  dimensions: Readonly<Record<string, readonly unknown[]>>;
}

export interface OptimizerTrial {
  trialId: string;
  point: Readonly<Record<string, unknown>>;
  result:
    | { status: "known"; scalar: number }
    | { status: "failed"; message: string }
    | null;
}

export interface OptimizerStore {
  load(): Promise<readonly OptimizerTrial[]>;
  save(trials: readonly OptimizerTrial[]): Promise<void>;
}

export interface OptimizerFixtureInput {
  searchSpace: OptimizerSearchSpace;
  /** Deterministic seed; the trial sequence is a pure function of it. */
  samplerSeed: number;
  trialCount: number;
  objective(point: Readonly<Record<string, unknown>>): Promise<number>;
  store: OptimizerStore;
}

export interface OptimizerFixtureOutcome {
  trials: readonly OptimizerTrial[];
  best: OptimizerTrial | null;
}

/** Deterministic linear-congruential sequence over the finite grid. */
function* pointSequence(
  space: OptimizerSearchSpace,
  seed: number,
): Generator<Readonly<Record<string, unknown>>> {
  const dimensionIds = Object.keys(space.dimensions).sort();
  const sizes = dimensionIds.map((id) => space.dimensions[id]?.length ?? 0);
  const total = sizes.reduce((product, size) => product * size, 1);
  if (total === 0) throw new Error("search space has an empty dimension");
  let state = seed >>> 0;
  const visited = new Set<number>();
  while (visited.size < total) {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    const index = state % total;
    if (visited.has(index)) continue;
    visited.add(index);
    const point: Record<string, unknown> = {};
    let remainder = index;
    for (let position = 0; position < dimensionIds.length; position += 1) {
      const id = dimensionIds[position];
      const size = sizes[position] ?? 1;
      const values = id === undefined ? [] : space.dimensions[id] ?? [];
      if (id !== undefined) point[id] = values[remainder % size];
      remainder = Math.floor(remainder / size);
    }
    yield Object.freeze(point);
  }
}

function trialIdFor(seed: number, index: number): string {
  return `trial-${String(seed)}-${String(index)}`;
}

/**
 * Toy-objective optimization loop proving trial generation, persistence,
 * resume, and best-trial selection without any model involvement.
 */
export async function runOptimizerFixture(
  input: OptimizerFixtureInput,
): Promise<OptimizerFixtureOutcome> {
  if (!Number.isSafeInteger(input.samplerSeed) || input.samplerSeed < 0) {
    throw new Error("samplerSeed must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(input.trialCount) || input.trialCount <= 0) {
    throw new Error("trialCount must be a positive safe integer");
  }
  const persisted = new Map(
    (await input.store.load()).map((trial) => [trial.trialId, trial]),
  );
  const trials: OptimizerTrial[] = [];
  let index = 0;
  for (const point of pointSequence(input.searchSpace, input.samplerSeed)) {
    if (index >= input.trialCount) break;
    const trialId = trialIdFor(input.samplerSeed, index);
    index += 1;
    const existing = persisted.get(trialId);
    if (existing && existing.result !== null) {
      trials.push(existing);
      continue;
    }
    let trial: OptimizerTrial;
    try {
      const scalar = await input.objective(point);
      if (!Number.isFinite(scalar)) throw new Error("objective returned a non-finite value");
      trial = { trialId, point, result: { status: "known", scalar } };
    } catch (error) {
      trial = {
        trialId,
        point,
        result: {
          status: "failed",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    trials.push(trial);
    await input.store.save(trials);
  }
  const best = trials.reduce<OptimizerTrial | null>((currentBest, trial) => {
    if (trial.result?.status !== "known") return currentBest;
    if (currentBest?.result?.status !== "known") return trial;
    return trial.result.scalar > currentBest.result.scalar ? trial : currentBest;
  }, null);
  return { trials: Object.freeze(trials), best };
}
