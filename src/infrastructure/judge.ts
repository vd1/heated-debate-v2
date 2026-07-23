import { createHash } from "node:crypto";

import { AgentFailure, type AgentPort, type RequestedControls } from "../domain/agent";
import { sanitizeFailure, validateCanonicalSequence, type CanonicalEvent } from "../domain/events";
import type { EvaluationResult, EvaluatorPort } from "../domain/evaluators";
import {
  createEvaluationRecord,
  rubricHash,
  type EvaluationRecord,
  type Rubric,
} from "../domain/rubric";
import { createDenyAllToolPolicy } from "../domain/tool-policy";

export const JUDGE_EVALUATOR_ID = "judge-rubric";
export const JUDGE_EVALUATOR_VERSION = "1";

export interface JudgeEvaluatorOptions {
  rubric: Rubric;
  controls: RequestedControls;
  /**
   * Deterministic presentation permutation for reliability probes. It reorders
   * only how completed turns are SHOWN to the judge; the canonical source
   * chronology is never altered.
   */
  presentation?: { order: "forward" | "reversed" };
  /** A fresh agent per evaluation; the judge disposes it. */
  createAgent(): Promise<AgentPort>;
  /** Atomic persistence for the linked evaluation record. */
  persistRecord(record: EvaluationRecord): Promise<void>;
  secrets?: readonly string[];
}

export interface JudgeEvaluation {
  result: EvaluationResult;
  record: EvaluationRecord;
}

/** Renders the judge's source text solely from the declared canonical events. */
export function renderJudgeSource(
  events: readonly CanonicalEvent[],
  presentation: { order: "forward" | "reversed" } = { order: "forward" },
): string {
  const roleByTurn = new Map<string, string>();
  let topic = "";
  const turnLines: string[] = [];
  for (const event of events) {
    if (event.type === "run.started") {
      topic = `Topic: ${event.data.topic}`;
    } else if (event.type === "turn.requested") {
      roleByTurn.set(event.data.request.turnId, event.data.request.role.id);
    } else if (event.type === "turn.completed") {
      const role = roleByTurn.get(event.data.turnId) ?? "unknown";
      turnLines.push(`[${role}] ${event.data.reply.text}`);
    }
  }
  if (presentation.order === "reversed") turnLines.reverse();
  return [topic, ...turnLines].join("\n\n");
}

function judgePrompt(rubric: Rubric, sourceText: string): string {
  const dimensionLines = rubric.dimensions.map((dimension) =>
    `- ${dimension.dimensionId}: ${dimension.description}`
    + ` Score ${String(dimension.scale.min)}-${String(dimension.scale.max)}`
    + ` (${dimension.direction}).`
    + (dimension.requiredEvidence === "quote"
      ? " Include a verbatim quote from the transcript as evidence."
      : ""));
  return [
    `Score the following debate transcript against rubric ${rubric.rubricId}@${rubric.rubricVersion}.`,
    "Dimensions:",
    ...dimensionLines,
    'Respond with exactly one JSON object of the form {"dimensions": {"<dimensionId>": {"score": <integer>, "evidence": "<quote>"}}} and nothing else.',
    "Transcript:",
    sourceText,
  ].join("\n");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(Reflect.get(value, key))}`,
  ).join(",")}}`;
}

export function artifactEventsHash(events: readonly CanonicalEvent[]): string {
  return createHash("sha256").update(canonicalJson(events)).digest("hex");
}

/**
 * A Pi-backed judge behind the shared evaluator contract: a fresh agent, exact
 * messages built only from the declared artifact, no tools, the raw response
 * preserved even on parse failure, and the linked evaluation record persisted
 * before any result is returned.
 */
export function createJudgeEvaluator(
  options: JudgeEvaluatorOptions,
): EvaluatorPort<JudgeEvaluation> & {
  evaluatorId: typeof JUDGE_EVALUATOR_ID;
  evaluatorVersion: typeof JUDGE_EVALUATOR_VERSION;
} {
  // Snapshot everything semantic at construction; later caller mutation can
  // never desynchronize the executed request from the recorded identity.
  const rubric = Object.freeze(structuredClone(options.rubric));
  const controls = Object.freeze(structuredClone(options.controls));
  const role = Object.freeze({
    id: "judge",
    version: JUDGE_EVALUATOR_VERSION,
    systemPrompt: "You are a strict, consistent debate judge. Output only the requested JSON.",
  });
  const creativity = Object.freeze({
    scheduleId: "linear-cooling",
    scheduleVersion: "1",
    level: 1,
    instruction: "Score precisely and conservatively.",
  });
  const contextPolicy = Object.freeze({ policyId: "last-exchange", policyVersion: "1" });
  const presentation = Object.freeze(structuredClone(options.presentation ?? { order: "forward" as const }));
  // The full canonical digest of the complete semantic configuration.
  const configurationId = createHash("sha256")
    .update(canonicalJson({
      evaluatorId: JUDGE_EVALUATOR_ID,
      evaluatorVersion: JUDGE_EVALUATOR_VERSION,
      promptTemplate: "judge-rubric-json-v1",
      rubricHash: rubricHash(rubric),
      controls,
      role,
      creativity,
      contextPolicy,
      capabilities: "deny-all",
      presentation,
    }))
    .digest("hex");

  async function evaluate(events: readonly CanonicalEvent[]): Promise<JudgeEvaluation> {
    // The source must be a closed canonical artifact, not a plausible prefix.
    validateCanonicalSequence(events);
    const start = events[0];
    if (start?.type !== "run.started") {
      throw new Error("judge evaluation requires an initial run.started event");
    }
    // A closed run has EXACTLY ONE terminal event, and it is the final one.
    const terminals = events.filter(
      (event) => event.type === "run.completed" || event.type === "run.failed",
    );
    if (terminals.length !== 1 || terminals[0] !== events.at(-1)) {
      throw new Error(
        "judge evaluation requires exactly one final terminal run.completed or run.failed event",
      );
    }
    const runId = start.runId;
    const sourceText = renderJudgeSource(events, presentation);
    const messages = [{ role: "user" as const, content: judgePrompt(rubric, sourceText) }];
    const sourceArtifact = { runId, artifactHash: artifactEventsHash(events) };
    const base = {
      rubric,
      sourceArtifact,
      judge: {
        evaluatorId: JUDGE_EVALUATOR_ID,
        evaluatorVersion: JUDGE_EVALUATOR_VERSION,
        configurationId,
      },
      declaredInputs: [runId],
      messages,
      controls,
      sourceText,
    };
    const completedSequences = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => event.sequence);

    // Agent acquisition sits inside the failure-record lifecycle: a factory
    // rejection is persisted as a sanitized failure, never silently dropped.
    let agent: AgentPort | undefined;
    let record: EvaluationRecord;
    try {
      agent = await options.createAgent();
      const reply = await agent.reply({
        turnId: `${runId}:judge`,
        role: structuredClone(role),
        creativity: structuredClone(creativity),
        context: { ...contextPolicy, messages },
        controls: structuredClone(controls),
        capabilities: createDenyAllToolPolicy({
          role: { id: role.id, version: role.version },
          phase: "review",
        }),
      });
      record = createEvaluationRecord({
        ...base,
        rawResponse: reply.text,
        execution: {
          returnedModel: reply.model,
          controlReport: reply.controls,
          usage: reply.usage,
          attempts: reply.trace.attempts,
          durationMs: reply.durationMs,
        },
      });
    } catch (error) {
      record = createEvaluationRecord({
        ...base,
        // Attempts inside a failed call carry real spend; keep them.
        ...(error instanceof AgentFailure && error.trace.attempts.length > 0
          ? { failureAttempts: error.trace.attempts }
          : {}),
        failure: sanitizeFailure(error, {
          code: "judge_failure",
          secrets: options.secrets ?? [],
        }),
      });
    }
    // The record persists even when cleanup fails; the cleanup failure is
    // still reported afterwards rather than silently swallowed.
    let cleanupError: unknown;
    if (agent !== undefined) {
      try {
        await agent.dispose();
      } catch (error) {
        cleanupError = error;
      }
    }
    await options.persistRecord(record);
    if (cleanupError !== undefined) {
      const message = cleanupError instanceof Error ? cleanupError.message : JSON.stringify(cleanupError);
      throw new Error(`judge agent cleanup failed: ${message}`);
    }

    return { result: toResult(rubric, configurationId, runId, completedSequences, record), record };
  }

  return {
    evaluatorId: JUDGE_EVALUATOR_ID,
    evaluatorVersion: JUDGE_EVALUATOR_VERSION,
    evaluate,
  };
}

function toResult(
  rubric: Rubric,
  configurationId: string,
  runId: string,
  eventSequences: readonly number[],
  record: EvaluationRecord,
): EvaluationResult {
  const common = {
    evaluatorId: JUDGE_EVALUATOR_ID,
    evaluatorVersion: JUDGE_EVALUATOR_VERSION,
    configurationId,
    range: { min: 0, max: 1 },
    direction: "higher-is-better" as const,
    evidence: { runId, eventSequences: [...eventSequences] },
  };
  if (record.failure !== null || record.outcome === null) {
    return {
      ...common,
      status: "unavailable",
      reason: record.failure?.message ?? "no judge outcome",
    };
  }
  if (record.outcome.status !== "valid") {
    return {
      ...common,
      status: "unavailable",
      reason: record.outcome.status === "malformed"
        ? `judge output malformed: ${record.outcome.reason}`
        : `judge output partial: missing ${record.outcome.missing
            .map((item) => item.dimensionId).join(", ")}`,
    };
  }
  // Normalized mean across dimensions, orienting every scale higher-is-better.
  let sum = 0;
  for (const dimension of rubric.dimensions) {
    const parsed = record.outcome.dimensions[dimension.dimensionId];
    if (!parsed) {
      return { ...common, status: "unavailable", reason: "valid outcome missing a dimension" };
    }
    const span = dimension.scale.max - dimension.scale.min;
    const normalized = (parsed.score - dimension.scale.min) / span;
    sum += dimension.direction === "higher-is-better" ? normalized : 1 - normalized;
  }
  const score = sum / rubric.dimensions.length;
  return {
    ...common,
    status: "known",
    score,
    value: score,
    detail: `normalized mean across ${String(rubric.dimensions.length)} dimensions`,
  };
}
