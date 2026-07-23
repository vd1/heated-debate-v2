import { validateCanonicalSequence, type CanonicalEvent } from "./events";

export interface DeterministicScore {
  evaluatorId: string;
  evaluatorVersion: "1";
  /** Normalized to [0, 1]; higher is better. */
  score: number;
  /** The underlying raw measurement the score was derived from. */
  value: number;
  detail: string;
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
  completedTexts: { role: string; text: string; durationMs: number }[];
  completed: boolean;
  observedTokens: number;
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
  };
  for (const event of events) {
    if (event.type === "turn.requested") {
      roleByTurn.set(event.data.request.turnId, event.data.request.role.id);
    } else if (event.type === "turn.completed") {
      view.completedTexts.push({
        role: roleByTurn.get(event.data.turnId) ?? "unknown",
        text: event.data.reply.text,
        durationMs: event.data.reply.durationMs,
      });
    } else if (event.type === "adapter.attempt") {
      view.observedTokens += (event.data.attempt.usage.inputTokens ?? 0)
        + (event.data.attempt.usage.outputTokens ?? 0);
    } else if (event.type === "run.completed") {
      view.completed = true;
    }
  }
  return view;
}

const clamp = (value: number): number => Math.min(1, Math.max(0, value));

export function evaluateCompletion(events: readonly CanonicalEvent[]): DeterministicScore {
  const view = readRun(events);
  const fraction = view.expectedTurns === 0
    ? 0
    : view.completedTexts.length / view.expectedTurns;
  const score = view.completed ? clamp(fraction) : clamp(fraction) * 0.5;
  return {
    evaluatorId: "deterministic-completion",
    evaluatorVersion: "1",
    score,
    value: view.completedTexts.length,
    detail: `${String(view.completedTexts.length)} of ${String(view.expectedTurns)} turns completed;`
      + ` terminal ${view.completed ? "run.completed" : "run.failed or missing"}`,
  };
}

export function evaluateContractMarkers(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const markers = options.contractMarkers ?? ["- "];
  const view = readRun(events);
  const adherent = view.completedTexts.filter(
    (turn) => markers.some((marker) => turn.text.includes(marker)),
  ).length;
  const score = view.completedTexts.length === 0 ? 0 : adherent / view.completedTexts.length;
  return {
    evaluatorId: "deterministic-contract-markers",
    evaluatorVersion: "1",
    score,
    value: adherent,
    detail: `${String(adherent)} of ${String(view.completedTexts.length)} replies contain a marker`,
  };
}

export function evaluateRepetition(events: readonly CanonicalEvent[]): DeterministicScore {
  const view = readRun(events);
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
      const current = words(texts[index] ?? "");
      if (previous.size === 0 || current.length === 0) continue;
      const overlap = current.filter((word) => previous.has(word)).length;
      const union = new Set([...previous, ...current]).size;
      worst = Math.max(worst, union === 0 ? 0 : overlap / union);
    }
  }
  return {
    evaluatorId: "deterministic-repetition",
    evaluatorVersion: "1",
    score: clamp(1 - worst),
    value: worst,
    detail: `worst consecutive same-role Jaccard similarity ${worst.toFixed(3)}`,
  };
}

export function evaluateOutputShape(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const bounds = options.outputShape ?? { minChars: 1, maxChars: 20_000 };
  const view = readRun(events);
  const shaped = view.completedTexts.filter((turn) => {
    const length = turn.text.trim().length;
    return length >= bounds.minChars && length <= bounds.maxChars;
  }).length;
  const score = view.completedTexts.length === 0 ? 0 : shaped / view.completedTexts.length;
  return {
    evaluatorId: "deterministic-output-shape",
    evaluatorVersion: "1",
    score,
    value: shaped,
    detail: `${String(shaped)} of ${String(view.completedTexts.length)} replies within`
      + ` [${String(bounds.minChars)}, ${String(bounds.maxChars)}] characters`,
  };
}

export function evaluateTokenUsage(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const view = readRun(events);
  const budget = options.tokenBudget;
  const score = budget === undefined || budget <= 0
    ? 0
    : clamp(1 - view.observedTokens / budget);
  return {
    evaluatorId: "deterministic-token-usage",
    evaluatorVersion: "1",
    score,
    value: view.observedTokens,
    detail: budget === undefined
      ? `${String(view.observedTokens)} observed tokens; no budget provided`
      : `${String(view.observedTokens)} observed tokens against a budget of ${String(budget)}`,
  };
}

export function evaluateLatency(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): DeterministicScore {
  const view = readRun(events);
  const total = view.completedTexts.reduce((sum, turn) => sum + turn.durationMs, 0);
  const mean = view.completedTexts.length === 0 ? 0 : total / view.completedTexts.length;
  const target = options.latencyTargetMs;
  const score = target === undefined || target <= 0 || view.completedTexts.length === 0
    ? 0
    : clamp(1 - mean / target);
  return {
    evaluatorId: "deterministic-latency",
    evaluatorVersion: "1",
    score,
    value: mean,
    detail: target === undefined
      ? `mean turn latency ${mean.toFixed(1)} ms; no target provided`
      : `mean turn latency ${mean.toFixed(1)} ms against a target of ${String(target)} ms`,
  };
}

export function runDeterministicEvaluators(
  events: readonly CanonicalEvent[],
  options: DeterministicEvaluatorOptions = {},
): readonly DeterministicScore[] {
  return Object.freeze([
    evaluateCompletion(events),
    evaluateContractMarkers(events, options),
    evaluateRepetition(events),
    evaluateOutputShape(events, options),
    evaluateTokenUsage(events, options),
    evaluateLatency(events, options),
  ]);
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 0);
}
