import type { AgentPort, ModelIdentity, RequestedControls } from "../domain/agent";
import type { CanonicalEvent } from "../domain/events";
import { calculateUsageCost, scaledCurrencyAmount } from "../domain/pricing";
import type { ReliabilitySample } from "../domain/reliability";
import { evaluationRecordHash, type EvaluationRecord, type Rubric } from "../domain/rubric";
import type { StudySpec } from "../domain/study-spec";
import { createJudgeEvaluator } from "./judge";

export interface ReliabilityCollectionInput {
  spec: StudySpec;
  rubric: Rubric;
  /** The closed canonical source artifact every sample judges. */
  events: readonly CanonicalEvent[];
  judgeControls: RequestedControls;
  /** A fresh judge agent per sample. */
  createAgent(): Promise<AgentPort>;
  persistRecord(record: EvaluationRecord): Promise<void>;
  sampleCount: number;
  budgets?: { maxTotalTokens?: number; maxTotalAmount?: number };
  secrets?: readonly string[];
}

export interface ReliabilityCollection {
  samples: readonly ReliabilitySample[];
  /** Planned evaluations that produced no usable score, with the reason. */
  missingEvaluations: readonly { sampleId: string; reason: string }[];
  /** Executed presentation plan, derived from the preregistered sampler seed. */
  orderings: readonly ("forward" | "reversed")[];
  /** Attempt-inclusive judge tokens across all samples. */
  totalTokens: number;
  /** Judge spend in 1e-12 currency units priced by the study snapshot. */
  totalCostScaled: bigint;
}

/** Deterministic PRNG so the presentation plan derives only from the seed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Balanced forward/reversed assignment, shuffled by the preregistered seed. */
function presentationPlan(seed: number, count: number): ("forward" | "reversed")[] {
  const plan = Array.from(
    { length: count },
    (_, index) => (index % 2 === 0 ? "forward" as const : "reversed" as const),
  );
  const random = mulberry32(seed);
  for (let index = plan.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const held = plan[index];
    const other = plan[swap];
    if (held === undefined || other === undefined) continue;
    plan[index] = other;
    plan[swap] = held;
  }
  return plan;
}

/** The single debater identity recorded by the source artifact's completed turns. */
function debaterModelOf(events: readonly CanonicalEvent[]): ModelIdentity {
  const models = new Map<string, ModelIdentity>();
  for (const event of events) {
    if (event.type !== "turn.completed") continue;
    const model = event.data.reply.model;
    models.set(`${model.providerId}/${model.modelId}`, model);
  }
  if (models.size !== 1) {
    throw new Error(
      `source artifact records ${String(models.size)} debater identities; `
      + "mixed-model candidates need per-candidate strata",
    );
  }
  const [model] = models.values();
  if (!model) throw new Error("source artifact records no debater identity");
  return model;
}

/**
 * The E-RELIABILITY collector: repeated judge evaluations over one closed
 * canonical artifact, presentation-permuted by the preregistered sampler seed,
 * bounded by attempt-inclusive token and monetary budgets, with unavailable
 * evaluations kept visible instead of silently dropped.
 */
export async function collectReliabilitySamples(
  input: ReliabilityCollectionInput,
): Promise<ReliabilityCollection> {
  if (!Number.isSafeInteger(input.sampleCount) || input.sampleCount <= 0) {
    throw new Error("sampleCount must be a positive safe integer");
  }
  const debaterModel = debaterModelOf(input.events);
  const orderings = presentationPlan(input.spec.samplerSeed, input.sampleCount);
  const maxAmountScaled = input.budgets?.maxTotalAmount === undefined
    ? null
    : scaledCurrencyAmount(input.budgets.maxTotalAmount, "budgets.maxTotalAmount");

  const samples: ReliabilitySample[] = [];
  const missingEvaluations: { sampleId: string; reason: string }[] = [];
  let totalTokens = 0;
  let totalCostScaled = 0n;

  for (const [index, ordering] of orderings.entries()) {
    const start = input.events[0];
    const runId = start?.runId ?? "unknown";
    const sampleId = `${runId}:rel-${String(index)}`;
    if (input.budgets?.maxTotalTokens !== undefined
      && totalTokens >= input.budgets.maxTotalTokens) {
      missingEvaluations.push({ sampleId, reason: "token budget exhausted before dispatch" });
      continue;
    }
    if (maxAmountScaled !== null && totalCostScaled >= maxAmountScaled) {
      missingEvaluations.push({ sampleId, reason: "monetary budget exhausted before dispatch" });
      continue;
    }
    const evaluator = createJudgeEvaluator({
      rubric: input.rubric,
      controls: input.judgeControls,
      presentation: { order: ordering },
      createAgent: () => input.createAgent(),
      persistRecord: (record) => input.persistRecord(record),
      ...(input.secrets === undefined ? {} : { secrets: input.secrets }),
    });
    const { result, record } = await evaluator.evaluate(input.events);
    // Attempt-inclusive accounting from the executed evidence.
    const returnedModel = record.execution?.returnedModel ?? input.judgeControls.model;
    for (const attempt of record.execution?.attempts ?? []) {
      const usage = attempt.usage;
      totalTokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0)
        + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        + (usage.reasoningTokens ?? 0);
      const cost = calculateUsageCost(input.spec.pricingSnapshot, returnedModel, usage);
      if (cost.status === "known") {
        totalCostScaled += cost.amountScaled;
      } else if (maxAmountScaled !== null && input.spec.unknownCostPolicy === "fail-closed") {
        throw new Error(
          `judge sample ${sampleId} has unpriceable usage under fail-closed accounting`,
        );
      }
    }
    if (result.status !== "known") {
      missingEvaluations.push({ sampleId, reason: result.reason });
      continue;
    }
    samples.push({
      sampleId,
      candidateRunId: result.evidence.runId,
      evaluationRecordHash: evaluationRecordHash(record),
      ordering,
      judgeModel: returnedModel,
      debaterModel,
      score: result.score,
    });
  }

  return {
    samples,
    missingEvaluations,
    orderings,
    totalTokens,
    totalCostScaled,
  };
}
