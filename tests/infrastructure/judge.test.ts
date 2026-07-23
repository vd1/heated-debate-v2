import { describe, expect, test } from "bun:test";

import { ScriptedAgent, type ScriptedReply, type TurnRequest } from "../../src/domain/agent";
import { runDebate, type DebateEventSink } from "../../src/domain/debate";
import type { CanonicalEvent } from "../../src/domain/events";
import { PROPOSER_ROLE, REVIEWER_ROLE } from "../../src/domain/roles";
import { parseRubric, type EvaluationRecord } from "../../src/domain/rubric";
import { createJudgeEvaluator } from "../../src/infrastructure/judge";

const MODEL = { providerId: "test", modelId: "judge-model" };
const RUBRIC = parseRubric({
  rubricVersion: "1",
  rubricId: "debate-quality",
  dimensions: [
    {
      dimensionId: "specificity",
      description: "Concrete claims.",
      scale: { min: 1, max: 5 },
      direction: "higher-is-better",
      requiredEvidence: "quote",
    },
    {
      dimensionId: "verbosity",
      description: "Unneeded length.",
      scale: { min: 1, max: 5 },
      direction: "lower-is-better",
      requiredEvidence: "none",
    },
  ],
});

function judgeReply(text: string): ScriptedReply {
  return {
    text,
    durationMs: 1,
    model: MODEL,
    controls: {
      model: { requested: MODEL, forwarded: MODEL },
      thinkingLevel: { requested: "high", forwarded: "high" },
    },
    usage: { values: {}, explicitlyReported: [] },
    trace: { attempts: [] },
  };
}

async function sourceEvents(): Promise<CanonicalEvent[]> {
  const events: CanonicalEvent[] = [];
  const sink: DebateEventSink = {
    append: (event) => {
      events.push(structuredClone(event));
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
  };
  const debateReply = (text: string): ScriptedReply => ({
    ...judgeReply(text),
    model: { providerId: "test", modelId: "model" },
    controls: {
      model: {
        requested: { providerId: "test", modelId: "model" },
        forwarded: { providerId: "test", modelId: "model" },
      },
      thinkingLevel: { requested: "high", forwarded: "high" },
    },
  });
  await runDebate({
    debateId: "judge-source",
    topic: "Design a cache.",
    roundCount: 1,
    proposer: {
      agent: new ScriptedAgent([debateReply("Use an LRU cache with TTL.")]),
      role: PROPOSER_ROLE,
      controls: { model: { providerId: "test", modelId: "model" }, thinkingLevel: "high" },
    },
    reviewer: {
      agent: new ScriptedAgent([debateReply("TTL needs jitter to avoid stampedes.")]),
      role: REVIEWER_ROLE,
      controls: { model: { providerId: "test", modelId: "model" }, thinkingLevel: "high" },
    },
    recording: { runId: "artifact-judge", sink },
  });
  return events;
}

function harness(responseText: string): {
  evaluator: ReturnType<typeof createJudgeEvaluator>;
  records: EvaluationRecord[];
  requests: TurnRequest[];
  agents: ScriptedAgent[];
} {
  const records: EvaluationRecord[] = [];
  const requests: TurnRequest[] = [];
  const agents: ScriptedAgent[] = [];
  const evaluator = createJudgeEvaluator({
    rubric: RUBRIC,
    controls: { model: MODEL, thinkingLevel: "high" },
    createAgent: () => {
      const agent = new ScriptedAgent([judgeReply(responseText)]);
      const wrapped = {
        reply: (request: TurnRequest) => {
          requests.push(structuredClone(request));
          return agent.reply(request);
        },
        dispose: () => agent.dispose(),
      };
      agents.push(agent);
      return Promise.resolve(wrapped);
    },
    persistRecord: (record) => {
      records.push(record);
      return Promise.resolve();
    },
  });
  return { evaluator, records, requests, agents };
}

describe("judge evaluator", () => {
  test("scores a valid response and persists the linked record before returning", async () => {
    const events = await sourceEvents();
    const { evaluator, records, requests, agents } = harness(JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "Use an LRU cache with TTL." },
        verbosity: { score: 2 },
      },
    }));

    const { result, record } = await evaluator.evaluate(events);

    if (result.status !== "known") throw new Error(result.status);
    // specificity 4/5 -> 0.75; verbosity 2 (lower-is-better) -> 0.75; mean 0.75.
    expect(result.score).toBe(0.75);
    expect(result.evidence.runId).toBe("artifact-judge");
    expect(records).toEqual([record]);
    expect(record.outcome?.status).toBe("valid");
    expect(record.sourceArtifact.artifactHash).toMatch(/^[0-9a-f]{64}$/);
    // Fresh agent, no tools, exact recorded messages.
    expect(agents[0]?.disposed).toBe(true);
    const request = requests[0];
    if (!request) throw new Error("missing judge request");
    expect(request.capabilities.evidence === "recorded"
      && request.capabilities.allowedTools).toEqual([]);
    expect(request.context.messages).toEqual(record.messages);
    expect(request.context.messages[0]?.content).toContain("Use an LRU cache with TTL.");
  });

  test("preserves the raw response and reports unavailable on parse failure", async () => {
    const events = await sourceEvents();
    const { evaluator, records } = harness("I think it deserves a 7/10.");

    const { result, record } = await evaluator.evaluate(events);

    expect(result.status).toBe("unavailable");
    expect(record.rawResponse).toBe("I think it deserves a 7/10.");
    expect(record.outcome?.status).toBe("malformed");
    expect(records).toHaveLength(1);
  });

  test("records a sanitized failure when the judge agent fails", async () => {
    const events = await sourceEvents();
    const records: EvaluationRecord[] = [];
    const evaluator = createJudgeEvaluator({
      rubric: RUBRIC,
      controls: { model: MODEL, thinkingLevel: "high" },
      createAgent: () => Promise.resolve({
        reply: () => Promise.reject(new Error("judge backend down secret-key-9")),
        dispose: () => Promise.resolve(),
      }),
      persistRecord: (record) => {
        records.push(record);
        return Promise.resolve();
      },
      secrets: ["secret-key-9"],
    });

    const { result, record } = await evaluator.evaluate(events);

    expect(result.status).toBe("unavailable");
    expect(record.failure?.code).toBe("judge_failure");
    expect(record.failure?.message).not.toContain("secret-key-9");
    expect(record.rawResponse).toBeNull();
    expect(records).toHaveLength(1);
  });

  test("rejects a source artifact that is not a valid canonical sequence", async () => {
    const events = await sourceEvents();
    const { evaluator } = harness(JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "Use an LRU cache with TTL." },
        verbosity: { score: 2 },
      },
    }));
    const completed = events.find((event) => event.type === "turn.completed");
    if (!completed) throw new Error("missing completed turn");
    // A mismatched envelope run ID must fail, not produce a known score.
    (completed as { runId: string }).runId = "someone-else";

    let caught: unknown;
    try {
      await evaluator.evaluate(events);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
  });

  test("snapshots options at construction so later mutation cannot desynchronize identity", async () => {
    const events = await sourceEvents();
    const controls = { model: { ...MODEL }, thinkingLevel: "high" as const };
    const requests: TurnRequest[] = [];
    const evaluator = createJudgeEvaluator({
      rubric: RUBRIC,
      controls,
      createAgent: () => {
        const agent = new ScriptedAgent([judgeReply(JSON.stringify({
          dimensions: {
            specificity: { score: 4, evidence: "Use an LRU cache with TTL." },
            verbosity: { score: 2 },
          },
        }))]);
        return Promise.resolve({
          reply: (request: TurnRequest) => {
            requests.push(structuredClone(request));
            return agent.reply(request);
          },
          dispose: () => agent.dispose(),
        });
      },
      persistRecord: () => Promise.resolve(),
    });
    // Mutation after construction must not leak into execution or identity.
    controls.thinkingLevel = "low" as never;

    const { result, record } = await evaluator.evaluate(events);

    if (result.status !== "known") throw new Error(result.status);
    expect(requests[0]?.controls.thinkingLevel).toBe("high");
    expect(record.controls?.thinkingLevel).toBe("high");
    // The configuration identity is a full canonical digest, not a prefix.
    expect(result.configurationId).toMatch(/^[0-9a-f]{64}$/);
  });

  test("persists a sanitized failure record when agent acquisition fails", async () => {
    const events = await sourceEvents();
    const records: EvaluationRecord[] = [];
    const evaluator = createJudgeEvaluator({
      rubric: RUBRIC,
      controls: { model: MODEL, thinkingLevel: "high" },
      createAgent: () => Promise.reject(new Error("factory down secret-key-9")),
      persistRecord: (record) => {
        records.push(record);
        return Promise.resolve();
      },
      secrets: ["secret-key-9"],
    });

    const { result, record } = await evaluator.evaluate(events);

    expect(result.status).toBe("unavailable");
    expect(records).toHaveLength(1);
    expect(record.failure?.code).toBe("judge_failure");
    expect(record.failure?.message).not.toContain("secret-key-9");
  });

  test("records the executed reply identity, control report, usage, and latency", async () => {
    const events = await sourceEvents();
    const { evaluator } = harness(JSON.stringify({
      dimensions: {
        specificity: { score: 4, evidence: "Use an LRU cache with TTL." },
        verbosity: { score: 2 },
      },
    }));

    const { record } = await evaluator.evaluate(events);

    if (record.execution === null) throw new Error("missing execution evidence");
    expect(record.execution.returnedModel).toEqual(MODEL);
    expect(record.execution.controlReport.thinkingLevel).toEqual({
      requested: "high",
      forwarded: "high",
    });
    expect(record.execution.usage).toEqual({});
    expect(record.execution.durationMs).toBe(1);
    expect(record.execution.attempts).toEqual([]);
  });

  test("rejects fabricated evidence through the derived outcome", async () => {
    const events = await sourceEvents();
    const { evaluator } = harness(JSON.stringify({
      dimensions: {
        specificity: { score: 5, evidence: "a quote that never appears" },
        verbosity: { score: 1 },
      },
    }));

    const { result, record } = await evaluator.evaluate(events);

    expect(result.status).toBe("unavailable");
    expect(record.outcome?.status).toBe("partial");
  });
});
