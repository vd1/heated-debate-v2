import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ScriptedAgent, type ScriptedReply } from "../../src/domain/agent";
import { FIXTURE_CASES } from "../../src/domain/cases";
import { generateExperimentMatrix, type RunSpecification } from "../../src/domain/matrix";
import {
  assertPreregisteredStudy,
  parseStudySpec,
  type StudySpec,
} from "../../src/domain/study-spec";
import { FilesystemStudyArtifactStore } from "../../src/infrastructure/filesystem-store";
import { executeStudy } from "../../src/infrastructure/study-runner";

const SPEC_JSON = {
  specVersion: "1",
  studyId: "study-fs",
  hypotheses: ["h"],
  benchmarkCaseIds: ["fixture-bounded-queue"],
  holdoutCaseIds: [],
  fixedParameters: { roundCount: 1 },
  variedParameters: [{ dimensionId: "thinkingLevel", values: ["low", "high"] }],
  repetitions: 1,
  evaluators: [{ evaluatorId: "e", evaluatorVersion: "1" }],
  rubric: { rubricId: "r", rubricVersion: "1" },
  pricingSnapshot: {
    snapshotId: "p", snapshotVersion: "1", currency: "USD",
    effectiveDate: "2026-07-01", provenance: "t",
    entries: [{
      model: { providerId: "openai-codex", modelId: "gpt-5.6-sol" },
      inputRatePerMillionTokens: 1, outputRatePerMillionTokens: 0,
      cacheReadRatePerMillionTokens: 0, cacheWriteRatePerMillionTokens: 0,
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
  budgets: { perRun: { maxTurns: 4, maxTokens: 1_000_000 } },
  stoppingRules: { maxRuns: 8 },
  plannedAnalysis: "a",
  reliabilityThresholds: {
    minimumSampleCount: 1, maximumJudgeVariance: 1, maximumOrderingBiasEffect: 1,
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

const agentsFactory = () => Promise.resolve({
  proposer: new ScriptedAgent([reply("Proposal")]),
  reviewer: new ScriptedAgent([reply("Review")]),
});

const workdir = await mkdtemp(join(tmpdir(), "heated-fs-store-"));

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}): {
  spec: StudySpec;
  runs: readonly RunSpecification[];
  attestation: ReturnType<typeof assertPreregisteredStudy>;
} {
  const spec = parseStudySpec({ ...structuredClone(SPEC_JSON), ...overrides });
  const runs = generateExperimentMatrix(spec, FIXTURE_CASES);
  const attestation = assertPreregisteredStudy(spec, { commit: "abc", cleanWorktree: true });
  return { spec, runs, attestation };
}

describe("filesystem study artifact store", () => {
  test("publishes durable artifacts and resumes from them across store instances", async () => {
    const root = join(workdir, "roundtrip");
    const { spec, runs, attestation } = fixture();

    const first = await executeStudy({
      spec,
      attestation,
      runs,
      cases: FIXTURE_CASES,
      createAgents: agentsFactory,
      store: new FilesystemStudyArtifactStore(root),
    });
    expect(first.executed).toHaveLength(2);

    let executions = 0;
    // A fresh store instance sees only what the filesystem persisted.
    const resumed = await executeStudy({
      spec,
      attestation,
      runs,
      cases: FIXTURE_CASES,
      createAgents: () => {
        executions += 1;
        return agentsFactory();
      },
      store: new FilesystemStudyArtifactStore(root),
    });
    expect(executions).toBe(0);
    expect(resumed.skipped).toHaveLength(2);
    expect(resumed.totalCostScaled).toBe(first.totalCostScaled);
  }, 20_000);

  test("claims are exclusive leases with stale-lease recovery", async () => {
    const root = join(workdir, "leases");
    const store = new FilesystemStudyArtifactStore(root, { staleLeaseMs: 60_000 });

    expect(await store.claim("run-x")).toBe(true);
    expect(await store.claim("run-x")).toBe(false);
    await store.release("run-x");
    expect(await store.claim("run-x")).toBe(true);

    // Age the lease beyond the stale limit; a new worker may reclaim it.
    const leasePath = store.leasePathFor("run-x");
    const past = new Date(Date.now() - 120_000);
    await utimes(leasePath, past, past);
    expect(await store.claim("run-x")).toBe(true);
    await store.release("run-x");
  });

  test("discard removes temporary output without publishing", async () => {
    const root = join(workdir, "discard");
    const store = new FilesystemStudyArtifactStore(root);
    const { runs } = fixture();
    const run = runs[0];
    if (!run) throw new Error("missing run");

    const handle = await store.openSink(run);
    await handle.discard();
    expect(await store.read(run)).toBeNull();
  });

  test("fails closed when an overlapping locator holds another spec's artifact", async () => {
    const root = join(workdir, "overlap");
    // A degenerate locator maps every run to one path: the store must rely on
    // stored identity, never on the locator, to accept an artifact.
    const collide = (run: RunSpecification): string =>
      `${run.caseId}/collision.jsonl`;
    const specA = fixture();
    const specB = fixture({ hypotheses: ["a different hypothesis"] });

    await executeStudy({
      spec: specA.spec,
      attestation: specA.attestation,
      runs: specA.runs.slice(0, 1),
      cases: FIXTURE_CASES,
      createAgents: agentsFactory,
      store: new FilesystemStudyArtifactStore(root, { pathForRun: collide }),
    });

    let caught: unknown;
    try {
      await executeStudy({
        spec: specB.spec,
        attestation: specB.attestation,
        runs: specB.runs.slice(0, 1),
        cases: FIXTURE_CASES,
        createAgents: agentsFactory,
        store: new FilesystemStudyArtifactStore(root, { pathForRun: collide }),
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toMatch(/different (run identity|study spec)/);
  }, 20_000);
});

describe("attestation validation at the execution boundary", () => {
  test("rejects a manually constructed attestation with a matching spec hash", async () => {
    const root = join(workdir, "attest");
    const { spec, runs, attestation } = fixture();
    const forged = {
      specHash: attestation.specHash,
      mode: "preregistered" as const,
      commit: null,
      cleanWorktree: null,
    };

    let caught: unknown;
    try {
      await executeStudy({
        spec,
        attestation: forged,
        runs,
        cases: FIXTURE_CASES,
        createAgents: agentsFactory,
        store: new FilesystemStudyArtifactStore(root),
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("attestation");
  });
});
