import type { BenchmarkCase } from "./cases";
import { studyRunId, type StudySpec } from "./study-spec";

export type MatrixPurpose = "selection" | "final-evaluation";

export interface RunSpecification {
  purpose: MatrixPurpose;
  runId: string;
  caseId: string;
  holdout: boolean;
  variantKey: string;
  /** Fixed parameters overlaid with this variant's varied assignments. */
  parameters: Readonly<Record<string, unknown>>;
  repetition: number;
}

/**
 * Generates the deterministic cases x parameter configurations x repetitions
 * matrix. Ordering is stable: spec case order, declared variant order, then
 * ascending repetition; run IDs embed the study-spec hash and must be unique.
 */
export function generateExperimentMatrix(
  spec: StudySpec,
  cases: readonly BenchmarkCase[],
  options: { purpose?: MatrixPurpose } = {},
): readonly RunSpecification[] {
  const purpose = options.purpose ?? "selection";
  const byId = new Map<string, BenchmarkCase>();
  for (const benchmarkCase of cases) {
    if (byId.has(benchmarkCase.caseId)) {
      throw new Error(`duplicate case definition ${benchmarkCase.caseId}`);
    }
    byId.set(benchmarkCase.caseId, benchmarkCase);
  }
  // Selection matrices never execute holdout cases; final evaluation is a
  // separate explicitly requested matrix over the holdout set only.
  const orderedCaseIds = purpose === "selection"
    ? [...spec.benchmarkCaseIds]
    : [...spec.holdoutCaseIds];
  for (const caseId of orderedCaseIds) {
    if (!byId.has(caseId)) throw new Error(`case ${caseId} is not defined`);
  }

  const variants = spec.variedParameters.reduce<Record<string, unknown>[]>(
    (accumulated, dimension) => accumulated.flatMap((variant) =>
      dimension.values.map((value) => ({ ...variant, [dimension.dimensionId]: value }))),
    [{}],
  );

  const runs: RunSpecification[] = [];
  const seen = new Set<string>();
  for (const caseId of orderedCaseIds) {
    for (const variant of variants) {
      const variantKey = Object.keys(variant).sort()
        .map((key) => `${key}=${String(variant[key])}`)
        .join(",");
      for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
        const runId = studyRunId(spec, { caseId, variantKey, repetition });
        if (seen.has(runId)) throw new Error(`duplicate run ID ${runId}`);
        seen.add(runId);
        runs.push(Object.freeze({
          purpose,
          runId,
          caseId,
          holdout: spec.holdoutCaseIds.includes(caseId),
          variantKey,
          parameters: Object.freeze({ ...spec.fixedParameters, ...variant }),
          repetition,
        }));
      }
    }
  }
  return Object.freeze(runs);
}
