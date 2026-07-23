import { describe, expect, test } from "bun:test";

import { ScriptedAgent, type ScriptedReply } from "../../src/domain/agent";
import { FIXTURE_CASES } from "../../src/domain/cases";
import type { DebateEventSink } from "../../src/domain/debate";
import type { CanonicalEvent } from "../../src/domain/events";
import { generateExperimentMatrix, type RunSpecification } from "../../src/domain/matrix";
import {
  assertPreregisteredStudy,
  parseStudySpec,
  type StudySpec,
} from "../../src/domain/study-spec";
import {
  executeStudy,
  type StudyArtifactStore,
} from "../../src/infrastructure/study-runner";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-exec",
  hypotheses: ["h"],
  benchmarkCaseIds: ["fixture-bounded-queue", "fixture-retry-policy"],
  holdoutCaseIds: ["fixture-schema-migration"],
  fixedParameters: { roundCount: 1 },
  variedParameters: [{ dimensionId: "thinkingLevel", values: ["low", "high"] }],
  repetitions: 1,
  evaluators: [{ evaluatorId: "e", evaluatorVersion: "1" }],
  rubric: { rubricId: "r", rubricVersion: "1" },
  pricingSnapshot: {
    snapshotId: "p",
    snapshotVersion: "1",
    currency: "USD",
    effectiveDate: "2026-07-01",
    provenance: "t",
    entries: [{
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
      inputRatePerMillionTokens: 1,
      outputRatePerMillionTokens: 0,
      cacheReadRatePerMillionTokens: 0,
      cacheWriteRatePerMillionTokens: 0,
      reasoningBilling: { mode: "included-in-output" },
    }],
  },
  samplerSeed: 1,
  caseOrderPolicy: "spec-order",
  baseline: { thinkingLevel: "low" },
  holdoutUsePolicy: "never",
  failureHandling: "record-and-continue",
  unknownCostPolicy: "fail-closed",
  rewardScalarization: { rewardId: "reward", rewardVersion: "1" },
  budgets: {
    perRun: { maxTurns: 4, maxTokens: 1_000_000, maxAmount: 1 },
    maxTotalAmount: 10,
  },
  stoppingRules: { maxRuns: 8 },
  plannedAnalysis: "a",
  reliabilityThresholds: {
    minimumSampleCount: 1,
    maximumJudgeVariance: 1,
    maximumOrderingBiasEffect: 1,
  },
};

const MODEL = { providerId: "openai-codex", modelId: "gpt-5.6-sol" };

function reply(text: string): ScriptedReply {
  return {
    text,
    durationMs: 1,
    model: MODEL,
    controls: {
      model: { requested: MODEL, forwarded: MODEL },
      thinkingLevel: { requested: "low", forwarded: "low" },
    },
    usage: { values: {}, explicitlyReported: [] },
    trace: {
      attempts: [{
        attempt: 1,
        status: "succeeded",
        httpStatus: 200,
        usage: { inputTokens: 100_000, outputTokens: 0 },
        usageEvidence: { explicitlyReported: ["outputTokens"], source: "test" },
      }],
    },
  };
}

class MemoryStore implements StudyArtifactStore {
  readonly published = new Map<string, CanonicalEvent[]>();
  readonly claims = new Set<string>();
  claimAttempts = 0;

  claim(runId: string): Promise<boolean> {
    this.claimAttempts += 1;
    if (this.claims.has(runId)) return Promise.resolve(false);
    this.claims.add(runId);
    return Promise.resolve(true);
  }

  release(runId: string): Promise<void> {
    this.claims.delete(runId);
    return Promise.resolve();
  }

  read(run: RunSpecification): Promise<readonly CanonicalEvent[] | null> {
    return Promise.resolve(this.published.get(run.runId) ?? null);
  }

  openSink(run: RunSpecification): Promise<{
    sink: DebateEventSink;
    publish(): Promise<void>;
    discard(): Promise<void>;
  }> {
    const buffered: CanonicalEvent[] = [];
    return Promise.resolve({
      sink: {
        append: (event: CanonicalEvent) => {
          buffered.push(structuredClone(event));
          return Promise.resolve();
        },
        flush: () => Promise.resolve(),
      },
      publish: () => {
        this.published.set(run.runId, [...buffered]);
        return Promise.resolve();
      },
      discard: () => Promise.resolve(),
    });
  }
}

function fixture(overrides: Record<string, unknown> = {}): {
  spec: StudySpec;
  runs: readonly RunSpecification[];
  store: MemoryStore;
  attestation: ReturnType<typeof assertPreregisteredStudy>;
} {
  const spec = parseStudySpec({ ...structuredClone(SPEC_JSON), ...overrides });
  const runs = generateExperimentMatrix(spec, FIXTURE_CASES);
  const attestation = assertPreregisteredStudy(spec, { commit: "abc", cleanWorktree: true });
  return { spec, runs, store: new MemoryStore(), attestation };
}

const agentsFactory = () => Promise.resolve({
  proposer: new ScriptedAgent([reply("Proposal")]),
  reviewer: new ScriptedAgent([reply("Review")]),
});

describe("study runner", () => {
  test("executes runs end to end, publishing validated artifacts with cost accounting", async () => {
    const { spec, runs, store, attestation } = fixture();

    const outcome = await executeStudy({
      spec,
      attestation,
      runs,
      cases: FIXTURE_CASES,
      createAgents: agentsFactory,
      store,
    });

    // 2 benchmark cases x 2 variants x 1 repetition.
    expect(outcome.executed).toHaveLength(4);
    expect(store.published.size).toBe(4);
    const first = store.published.get(runs[0]?.runId ?? "");
    expect(first?.[0]?.type).toBe("run.started");
    expect(first?.at(-1)?.type).toBe("run.completed");
    // 8 attempts x 100k input tokens at 1 USD/M = 0.8 USD in 1e-12 units.
    expect(outcome.totalCostScaled).toBe(800_000_000_000n);
  });

  test("resume validates artifacts and counts their cost without re-executing", async () => {
    const { spec, runs, store, attestation } = fixture();
    await executeStudy({
      spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
    });

    let executions = 0;
    const resumed = await executeStudy({
      spec,
      attestation,
      runs,
      cases: FIXTURE_CASES,
      createAgents: () => {
        executions += 1;
        return agentsFactory();
      },
      store,
    });

    expect(executions).toBe(0);
    expect(resumed.skipped).toHaveLength(4);
    expect(resumed.totalCostScaled).toBe(800_000_000_000n);
  });

  test("fails closed on artifact identity mismatch and stale case content", async () => {
    const { spec, runs, store, attestation } = fixture();
    await executeStudy({
      spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
    });
    const firstId = runs[0]?.runId ?? "";
    const events = store.published.get(firstId) ?? [];
    const start = events[0];
    if (start?.type !== "run.started") throw new Error("bad fixture");
    start.data = { ...start.data, debateId: "someone-else" };

    let caught: unknown;
    try {
      await executeStudy({
        spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("different run identity");

    let stale: unknown;
    try {
      await executeStudy({
        spec,
        attestation,
        runs: runs.map((run) => ({ ...run, caseHash: "d".repeat(64) })),
        cases: FIXTURE_CASES,
        createAgents: agentsFactory,
        store: new MemoryStore(),
      });
    } catch (error) {
      stale = error;
    }
    expect(String(stale)).toContain("changed since the matrix was generated");
  });

  test("reserves the per-run maximum against the aggregate monetary budget", async () => {
    // Each run reserves up to 1 USD; after the first run's 0.2 USD spend the
    // 1.05 USD ceiling cannot cover another full reservation.
    const { spec, runs, store, attestation } = fixture({
      budgets: {
        perRun: { maxTurns: 4, maxTokens: 1_000_000, maxAmount: 1 },
        maxTotalAmount: 1.05,
      },
    });

    const outcome = await executeStudy({
      spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
    });

    expect(outcome.executed.length + outcome.failed.length).toBeLessThanOrEqual(4);
    expect(outcome.failed.some(
      (item) => item.message === "study monetary budget cannot cover another run",
    )).toBe(true);
    expect(store.published.size).toBeLessThan(4);
  });

  test("persists terminal-failure artifacts with their spend and releases claims", async () => {
    const { spec, runs, store, attestation } = fixture();

    const outcome = await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      // The proposer spends one priced attempt; the exhausted reviewer fails
      // the run afterwards, so real spend precedes the terminal failure.
      createAgents: () => Promise.resolve({
        proposer: new ScriptedAgent([reply("Proposal")]),
        reviewer: new ScriptedAgent([]),
      }),
      store,
    });

    expect(outcome.failed).toHaveLength(1);
    expect(store.claims.size).toBe(0);
    const artifact = store.published.get(runs[0]?.runId ?? "");
    expect(artifact?.at(-1)?.type).toBe("run.failed");
    // 1 attempt x 100k input tokens at 1 USD/M, charged despite the failure.
    expect(outcome.totalCostScaled).toBe(100_000_000_000n);
  });

  test("resume treats persisted failures as terminal and counts their spend", async () => {
    const { spec, runs, store, attestation } = fixture();
    await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: () => Promise.resolve({
        proposer: new ScriptedAgent([reply("Proposal")]),
        reviewer: new ScriptedAgent([]),
      }),
      store,
    });

    let executions = 0;
    const resumed = await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: () => {
        executions += 1;
        return agentsFactory();
      },
      store,
    });

    expect(executions).toBe(0);
    expect(resumed.failed).toHaveLength(1);
    expect(resumed.executed).toHaveLength(0);
    expect(resumed.totalCostScaled).toBe(100_000_000_000n);
  });

  test("discards infrastructure failures without publishing an artifact", async () => {
    const { spec, runs, store, attestation } = fixture();

    const outcome = await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: () => Promise.reject(new Error("credentials missing")),
      store,
    });

    expect(outcome.failed).toHaveLength(1);
    expect(store.published.size).toBe(0);
    // The claim and reservation must not leak when agent creation fails.
    expect(store.claims.size).toBe(0);
  });

  test("disposes every agent and releases the claim when one disposal throws", async () => {
    const { spec, runs, store, attestation } = fixture();
    const disposed: string[] = [];
    class LeakyAgent extends ScriptedAgent {
      constructor(private readonly name: string, replies: ScriptedReply[]) {
        super(replies);
      }
      override dispose(): Promise<void> {
        disposed.push(this.name);
        if (this.name === "proposer") return Promise.reject(new Error("hung session"));
        return Promise.resolve();
      }
    }

    const outcome = await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: () => Promise.resolve({
        proposer: new LeakyAgent("proposer", [reply("Proposal")]),
        reviewer: new LeakyAgent("reviewer", [reply("Review")]),
      }),
      store,
    });

    // runDebate owns disposal and disposes the reviewer first; each exactly once.
    expect([...disposed].sort()).toEqual(["proposer", "reviewer"]);
    expect(store.claims.size).toBe(0);
    expect(outcome.failed.some((item) => item.message.includes("hung session"))).toBe(true);
  });

  test("rejects resumed artifacts recorded under a different study spec", async () => {
    const { spec, runs, store, attestation } = fixture();
    await executeStudy({
      spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
    });
    const events = store.published.get(runs[0]?.runId ?? "") ?? [];
    const start = events[0];
    if (start?.type !== "run.started" || start.data.experiment === null) {
      throw new Error("bad fixture");
    }
    start.data = {
      ...start.data,
      experiment: { ...start.data.experiment, specHash: "b".repeat(64) },
    };

    let caught: unknown;
    try {
      await executeStudy({
        spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("different study spec");
  });

  test("rejects resumed artifacts whose config hash does not match the run", async () => {
    const { spec, runs, store, attestation } = fixture();
    await executeStudy({
      spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
    });
    const events = store.published.get(runs[0]?.runId ?? "") ?? [];
    const start = events[0];
    if (start?.type !== "run.started" || start.data.experiment === null) {
      throw new Error("bad fixture");
    }
    start.data = {
      ...start.data,
      experiment: { ...start.data.experiment, configHash: "c".repeat(64) },
    };

    let caught: unknown;
    try {
      await executeStudy({
        spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("experiment config");
  });

  test("rejects resumed artifacts with a corrupted canonical sequence", async () => {
    const { spec, runs, store, attestation } = fixture();
    await executeStudy({
      spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
    });
    const events = store.published.get(runs[0]?.runId ?? "") ?? [];
    // Drop a mid-stream event; the artifact is no longer a canonical run.
    events.splice(1, 1);

    let caught: unknown;
    try {
      await executeStudy({
        spec, attestation, runs, cases: FIXTURE_CASES, createAgents: agentsFactory, store,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  test("prices resumed artifacts by the returned model identity", async () => {
    const returned = { providerId: "openai-codex", modelId: "gpt-5.6-luna" };
    const { spec, runs, store, attestation } = fixture({
      pricingSnapshot: {
        ...structuredClone(SPEC_JSON.pricingSnapshot),
        entries: [
          ...structuredClone(SPEC_JSON.pricingSnapshot.entries),
          {
            model: returned,
            inputRatePerMillionTokens: 3,
            outputRatePerMillionTokens: 0,
            cacheReadRatePerMillionTokens: 0,
            cacheWriteRatePerMillionTokens: 0,
            reasoningBilling: { mode: "included-in-output" },
          },
        ],
      },
    });
    // The provider returned luna despite the requested sol identity.
    const returnedReply = (text: string): ScriptedReply => ({ ...reply(text), model: returned });

    const outcome = await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: () => Promise.resolve({
        proposer: new ScriptedAgent([returnedReply("Proposal")]),
        reviewer: new ScriptedAgent([returnedReply("Review")]),
      }),
      store,
    });

    // 2 attempts x 100k input tokens priced at the RETURNED 3 USD/M rate.
    expect(outcome.totalCostScaled).toBe(600_000_000_000n);

    const resumed = await executeStudy({
      spec,
      attestation,
      runs: runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: agentsFactory,
      store,
    });
    expect(resumed.totalCostScaled).toBe(600_000_000_000n);
  });
});
