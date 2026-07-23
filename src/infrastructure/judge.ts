import { createHash } from "node:crypto";

import type { AgentPort, RequestedControls } from "../domain/agent";
import { sanitizeFailure, type CanonicalEvent } from "../domain/events";
import type { EvaluationResult } from "../domain/evaluators";
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
export function renderJudgeSource(events: readonly CanonicalEvent[]): string {
  const roleByTurn = new Map<string, string>();
  const lines: string[] = [];
  for (const event of events) {
    if (event.type === "run.started") {
      lines.push(`Topic: ${event.data.topic}`);
    } else if (event.type === "turn.requested") {
      roleByTurn.set(event.data.request.turnId, event.data.request.role.id);
    } else if (event.type === "turn.completed") {
      const role = roleByTurn.get(event.data.turnId) ?? "unknown";
      lines.push(`[${role}] ${event.data.reply.text}`);
    }
  }
  return lines.join("\n\n");
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

export function artifactEventsHash(events: readonly CanonicalEvent[]): string {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(value, key))}`,
    ).join(",")}}`;
  };
  return createHash("sha256").update(canonical(events)).digest("hex");
}

/**
 * A Pi-backed judge behind the shared evaluator contract: a fresh agent, exact
 * messages built only from the declared artifact, no tools, the raw response
 * preserved even on parse failure, and the linked evaluation record persisted
 * before any result is returned.
 */
export function createJudgeEvaluator(options: JudgeEvaluatorOptions): {
  evaluatorId: typeof JUDGE_EVALUATOR_ID;
  evaluatorVersion: typeof JUDGE_EVALUATOR_VERSION;
  evaluate(events: readonly CanonicalEvent[]): Promise<JudgeEvaluation>;
} {
  const configurationId = createHash("sha256")
    .update(JSON.stringify({
      rubricHash: rubricHash(options.rubric),
      controls: options.controls,
    }))
    .digest("hex")
    .slice(0, 12);

  async function evaluate(events: readonly CanonicalEvent[]): Promise<JudgeEvaluation> {
    const start = events[0];
    if (start?.type !== "run.started") {
      throw new Error("judge evaluation requires an initial run.started event");
    }
    const runId = start.runId;
    const sourceText = renderJudgeSource(events);
    const messages = [{ role: "user" as const, content: judgePrompt(options.rubric, sourceText) }];
    const sourceArtifact = { runId, artifactHash: artifactEventsHash(events) };
    const base = {
      rubric: options.rubric,
      sourceArtifact,
      judge: { evaluatorId: JUDGE_EVALUATOR_ID, evaluatorVersion: JUDGE_EVALUATOR_VERSION },
      declaredInputs: [runId],
      messages,
      controls: options.controls,
      sourceText,
    };
    const completedSequences = events
      .filter((event) => event.type === "turn.completed")
      .map((event) => event.sequence);

    const agent = await options.createAgent();
    let record: EvaluationRecord;
    try {
      const reply = await agent.reply({
        turnId: `${runId}:judge`,
        role: {
          id: "judge",
          version: JUDGE_EVALUATOR_VERSION,
          systemPrompt: "You are a strict, consistent debate judge. Output only the requested JSON.",
        },
        creativity: {
          scheduleId: "linear-cooling",
          scheduleVersion: "1",
          level: 1,
          instruction: "Score precisely and conservatively.",
        },
        context: { policyId: "last-exchange", policyVersion: "1", messages },
        controls: structuredClone(options.controls),
        capabilities: createDenyAllToolPolicy({
          role: { id: "judge", version: JUDGE_EVALUATOR_VERSION },
          phase: "review",
        }),
      });
      record = createEvaluationRecord({ ...base, rawResponse: reply.text });
    } catch (error) {
      record = createEvaluationRecord({
        ...base,
        failure: sanitizeFailure(error, {
          code: "judge_failure",
          secrets: options.secrets ?? [],
        }),
      });
    } finally {
      await agent.dispose();
    }
    await options.persistRecord(record);

    return { result: toResult(options.rubric, configurationId, runId, completedSequences, record), record };
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
