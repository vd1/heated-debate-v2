import { createHash } from "node:crypto";

import { validateCanonicalSequence, type CanonicalEvent } from "./events";

export interface EvaluationEvidence {
  runId: string;
  eventSequences: readonly number[];
}

/** Shared result contract for deterministic and judge-backed evaluators. */
export type EvaluationResult =
  | {
      evaluatorId: string;
      evaluatorVersion: string;
      configurationId: string;
      status: "known";
      score: number;
      range: { min: number; max: number };
      direction: "higher-is-better" | "lower-is-better";
      value: number;
      evidence: EvaluationEvidence;
      detail: string;
    }
  | {
      evaluatorId: string;
      evaluatorVersion: string;
      configurationId: string;
      status: "unavailable";
      range: { min: number; max: number };
      direction: "higher-is-better" | "lower-is-better";
      evidence: EvaluationEvidence;
      reason: string;
    };

export type DeterministicScore =
 EvaluationResult;

/** Shared evaluator boundary; E-JUDGE implements the same port. */
export interface EvaluatorPort {
  evaluatorId: string;
  evaluatorVersion: string;
  evaluate(events: readonly CanonicalEvent[], configuration?: unknown): EvaluationResult;
}

const OPTION_KEYS = ["contractMarkers", "outputShape", "tokenBudget", "latencyTargetMs"];

/** Validates the shared options before any configuration identity is computed. */
export function validateEvaluatorOptions(
  options: DeterministicEvaluatorOptions,
): DeterministicEvaluatorOptions {
  for (const key of Object.keys(options)) {
    if (!OPTION_KEYS.includes(key)) throw new Error(`unknown evaluator option: ${key}`);
  }
  const numeric = [options.tokenBudget, options.latencyTargetMs];
  for (const value of numeric) {
    if (value !== undefined && (typeof value !== "number" || Number.isNaN(value))) {
      throw new Error("evaluator numeric options must be numbers");
    }
  }
  return options;
}

export function evaluatorConfigurationId(options: DeterministicEvaluatorOptions): string {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== "object") return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    return `{${Object.keys(input).sort().map(
      (key) => `${JSON.stringify(key)}:${canonical(Reflect.get(input, key))}`,
    ).join(",")}}`;
  };
  return createHash("sha256").update(canonical(options)).digest("hex").slice(0, 12);
}

export interface DeterministicEvaluatorOptions {
  /** Markers whose presence in a reply indicates contract adherence. */
  contractMarkers?: readonly string[];
  /** Inclusive character bounds for a well-shaped reply. */
  outputShape?: { minChars: number; maxChars: number };
  /** Token budget the usage score normalizes against. */
  tokenBudget?: number;
  /** Per-turn latency target in milliseconds for the latency score. */
  latencyTargetMs?: number;
}

interface RunView {
  expectedTurns: number;
  completedTexts: { role: string; text: string; durationMs: number; sequence: number }[];
  completed: boolean;
  observedTokens: number;
  /** True only when at least one attempt carried any usage evidence. */
  usageObserved: boolean;
  /** True when any attempt lacked input or output totals. */
  partialUsage: boolean;
  attemptSequences: number[];
  runId: string;
  terminalSequence: number | null;
}

function readRun(events: readonly CanonicalEvent[]): RunView {
  validateCanonicalSequence(events);
  const start = events[0];
  if (start?.type !== "run.started") {
    throw new Error("deterministic evaluation requires an initial run.started event");
  }
  const roleByTurn = new Map<string, string>();
  const view: RunView = {
    expectedTurns: start.data.roundCount * 2,
    completedTexts: [],
    completed: false,
    observedTokens: 0,
    usageObserved: false,
    partialUsage: false,
    attemptSequences: [],
    runId: start.runId,
    terminalSequence: null,
  };
  for (const event of events) {
    if (event.type === "turn.requested") {
      roleByTurn.set(event.data.request.turnId, event.data.request.role.id);
    } else if (event.type === "turn.completed") {
      view.completedTexts.push({
        role: roleByTurn.get(event.data.turnId) ?? "unknown",
        text: event.data.reply.text,
        durationMs: event.data.reply.durationMs,
        sequence: event.sequence,
      });
    } else if (event.type === "adapter.attempt") {
      const usage = event.data.attempt.usage;
      view.attemptSequences.push(event.sequence);
      const anyEvidence = usage.inputTokens !== undefined || usage.outputTokens !== undefined
        || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
      if (anyEvidence) view.usageObserved = true;
      // Any attempt without both totals makes the sum a partial measurement,
      // including attempts whose usage is entirely absent.
      if (usage.inputTokens === undefined || usage.outputTokens === undefined) {
        view.partialUsage = true;
      }
      // Matches the domain budget lower bound: input, output, and cache tokens.
      view.observedTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    } else if (event.type === "run.completed") {
      view.completed = true;
      view.terminalSequence = event.sequence;
    } else if (event.type === "run.failed") {
      view.terminalSequence = event.sequence;
    }
  }
  return view;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

function knownResult(
  evaluatorId: string,
  options: DeterministicEvaluatorOptions,
  runId: string,
  score: number,
  value: number,
  eventSequences: readonly number[],
  detail: string,
): DeterministicScore {
  return {
    evaluatorId,
    evaluatorVersion: "3",
    configurationId: evaluatorConfigurationId(validateEvaluatorOptions(options)),
    status: "known",
    score,
    range: { min: 0, max: 1 },
    direction: "higher-is-better",
    value,
    evidence: { runId, eventSequences: [...eventSequences] },
    detail,
  };
}

function unavailableResult(
  evaluatorId: string,
  options: DeterministicEvaluatorOptions,
  runId: string,
  eventSequences: readonly number[],
  reason: string,
): DeterministicScore {
  return {
    evaluatorId,
    evaluatorVersion: "3",
    configurationId: evaluatorConfigurationId(validateEvaluatorOptions(options)),
    status: "unavailable",
    range: { min: 0, max: 1 },
    direction: "higher-is-better",
    evidence: { runId, eventSequences: [...eventSequences] },
    reason,
  };
}

export function evaluateCompletion(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const view = readRun(events);
  const fraction = view.expectedTurns === 0
    ? 0
    : view.completedTexts.length / view.expectedTurns;
  const score = view.completed ? clamp(fraction) : clamp(fraction) * 0.5;
  return knownResult(
    "deterministic-completion",
    options,
    view.runId,
    score,
    view.completedTexts.length,
    [
      ...view.completedTexts.map((turn) => turn.sequence),
      ...(view.terminalSequence === null ? [] : [view.terminalSequence]),
    ],
    `${String(view.completedTexts.length)} of ${String(view.expectedTurns)} turns completed;`
      + ` terminal ${view.completed ? "run.completed" : "run.failed or missing"}`,
  );
}

export function evaluateContractMarkers(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const markers = options.contractMarkers ?? ["- "];
  if (markers.length === 0 || markers.some((marker) => marker.length === 0)) {
    throw new Error("contractMarkers must be non-empty strings");
  }
  const view = readRun(events);
  if (view.completedTexts.length === 0) {
    return unavailableResult(
      "deterministic-contract-markers",
      options,
      view.runId,
      [],
      "no completed replies to measure",
    );
  }
  const adherent = view.completedTexts.filter(
    (turn) => markers.some((marker) => turn.text.includes(marker)),
  ).length;
  return knownResult(
    "deterministic-contract-markers",
    options,
    view.runId,
    adherent / view.completedTexts.length,
    adherent,
    view.completedTexts.map((turn) => turn.sequence),
    `${String(adherent)} of ${String(view.completedTexts.length)} replies contain a marker`,
  );
}

export function evaluateRepetition(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const view = readRun(events);
  let comparisons = 0;
  const byRole = new Map<string, string[]>();
  for (const turn of view.completedTexts) {
    const texts = byRole.get(turn.role) ?? [];
    texts.push(turn.text);
    byRole.set(turn.role, texts);
  }
  let worst = 0;
  for (const texts of byRole.values()) {
    for (let index = 1; index < texts.length; index += 1) {
      const previous = new Set(words(texts[index - 1] ?? ""));
      const current = new Set(words(texts[index] ?? ""));
      if (previous.size === 0 || current.size === 0) continue;
      comparisons += 1;
      const overlap = [...current].filter((word) => previous.has(word)).length;
      const union = new Set([...previous, ...current]).size;
      worst = Math.max(worst, union === 0 ? 0 : overlap / union);
    }
  }
  if (comparisons === 0) {
    return unavailableResult(
      "deterministic-repetition",
      options,
      view.runId,
      view.completedTexts.map((turn) => turn.sequence),
      "no consecutive same-role reply pairs to compare",
    );
  }
  return knownResult(
    "deterministic-repetition",
    options,
    view.runId,
    clamp(1 - worst),
    worst,
    view.completedTexts.map((turn) => turn.sequence),
    `worst consecutive same-role Jaccard similarity ${worst.toFixed(3)}`,
  );
}

export function evaluateOutputShape(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const bounds = options.outputShape ?? { minChars: 1, maxChars: 20_000 };
  if (!Number.isSafeInteger(bounds.minChars) || bounds.minChars < 0
    || !Number.isSafeInteger(bounds.maxChars) || bounds.maxChars < bounds.minChars) {
    throw new Error("outputShape bounds must be safe integers with minChars <= maxChars");
  }
  const view = readRun(events);
  if (view.completedTexts.length === 0) {
    return unavailableResult(
      "deterministic-output-shape",
      options,
      view.runId,
      [],
      "no completed replies to measure",
    );
  }
  const shaped = view.completedTexts.filter((turn) => {
    // Code points, not UTF-16 units; complex grapheme clusters count per point.
    const length = Array.from(turn.text.trim(), () => 0).length;
    return length >= bounds.minChars && length <= bounds.maxChars;
  }).length;
  return knownResult(
    "deterministic-output-shape",
    options,
    view.runId,
    shaped / view.completedTexts.length,
    shaped,
    view.completedTexts.map((turn) => turn.sequence),
    `${String(shaped)} of ${String(view.completedTexts.length)} replies within`
      + ` [${String(bounds.minChars)}, ${String(bounds.maxChars)}] characters`,
  );
}

export function evaluateTokenUsage(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const view = readRun(events);
  const budget = options.tokenBudget;
  if (budget === undefined) {
    return unavailableResult(
      "deterministic-token-usage",
      options,
      view.runId,
      view.attemptSequences,
      "no token budget configured",
    );
  }
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error("tokenBudget must be a positive safe integer");
  }
  if (!view.usageObserved) {
    return unavailableResult(
      "deterministic-token-usage",
      options,
      view.runId,
      view.attemptSequences,
      "no attempt carried usage evidence; missing usage is never zero usage",
    );
  }
  if (view.partialUsage) {
    return unavailableResult(
      "deterministic-token-usage",
      options,
      view.runId,
      view.attemptSequences,
      "an attempt reported partial usage; partial evidence is never an exact total",
    );
  }
  return knownResult(
    "deterministic-token-usage",
    options,
    view.runId,
    clamp(1 - view.observedTokens / budget),
    view.observedTokens,
    view.attemptSequences,
    `${String(view.observedTokens)} observed tokens against a budget of ${String(budget)}`,
  );
}

export function evaluateLatency(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const view = readRun(events);
  const total = view.completedTexts.reduce((sum, turn) => sum + turn.durationMs, 0);
  const mean = view.completedTexts.length === 0 ? 0 : total / view.completedTexts.length;
  const target = options.latencyTargetMs;
  if (target === undefined) {
    return unavailableResult(
      "deterministic-latency",
      options,
      view.runId,
      [],
      "no latency target configured",
    );
  }
  if (!Number.isFinite(target) || target <= 0) {
    throw new Error("latencyTargetMs must be a finite positive number");
  }
  if (view.completedTexts.length === 0) {
    return unavailableResult(
      "deterministic-latency",
      options,
      view.runId,
      [],
      "no completed turns to measure",
    );
  }
  return knownResult(
    "deterministic-latency",
    options,
    view.runId,
    clamp(1 - mean / target),
    mean,
    view.completedTexts.map((turn) => turn.sequence),
    `mean turn latency ${mean.toFixed(1)} ms against a target of ${String(target)} ms`,
  );
}

export const DETERMINISTIC_EVALUATORS: readonly EvaluatorPort[] = Object.freeze([
  { evaluatorId: "deterministic-completion", evaluatorVersion: "3", evaluate: evaluateCompletion },
  {
    evaluatorId: "deterministic-contract-markers",
    evaluatorVersion: "3",
    evaluate: evaluateContractMarkers,
  },
  { evaluatorId: "deterministic-repetition", evaluatorVersion: "3", evaluate: evaluateRepetition },
  {
    evaluatorId: "deterministic-output-shape",
    evaluatorVersion: "3",
    evaluate: evaluateOutputShape,
  },
  { evaluatorId: "deterministic-token-usage", evaluatorVersion: "3", evaluate: evaluateTokenUsage },
  { evaluatorId: "deterministic-latency", evaluatorVersion: "3", evaluate: evaluateLatency },
]);

export function runDeterministicEvaluators(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): readonly DeterministicScore[] {
  return Object.freeze(
    DETERMINISTIC_EVALUATORS.map((port) => port.evaluate(events, options)),
  );
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 0);
}
