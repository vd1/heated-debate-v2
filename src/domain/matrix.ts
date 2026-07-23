import { benchmarkCaseHash, type BenchmarkCase } from "./cases";
import {
  canonicalParameterValue,
  studyRunId,
  studySpecHash,
  type StudySpec,
} from "./study-spec";

export type MatrixPurpose = "selection" | "final-evaluation";

export interface RunSpecification {
  purpose: MatrixPurpose;
  runId: string;
  /** Full identity preimage. */
  specHash: string;
  caseId: string;
  caseHash: string;
  holdout: boolean;
  /** Canonical typed variant identity: dimension=canonical-JSON value. */
  variantKey: string;
  /** Fixed parameters overlaid with this variant's varied assignments. */
  parameters: Readonly<Record<string, unknown>>;
  /** Zero-based repetition index. */
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
  if (purpose === "final-evaluation" && spec.holdoutUsePolicy === "never") {
    throw new Error("holdoutUsePolicy forbids a final-evaluation matrix");
  }
  const orderedCaseIds = purpose === "selection"
    ? [...spec.benchmarkCaseIds]
    : [...spec.holdoutCaseIds];
  if (spec.caseOrderPolicy === "sorted-by-case-id") orderedCaseIds.sort();
  for (const caseId of orderedCaseIds) {
    if (!byId.has(caseId)) throw new Error(`case ${caseId} is not defined`);
  }

  const variants = spec.variedParameters.reduce<Record<string, unknown>[]>(
    (accumulated, dimension) => accumulated.flatMap((variant) =>
      dimension.values.map((value) => ({ ...variant, [dimension.dimensionId]: value }))),
    [{}],
  ).map((variant) => ({
    variant,
    variantKey: Object.keys(variant).sort()
      .map((key) => `${key}=${canonicalParameterValue(variant[key])}`)
      .join(","),
  })).sort((left, right) => left.variantKey.localeCompare(right.variantKey));
  const specHash = studySpecHash(spec);

  const runs: RunSpecification[] = [];
  const seen = new Set<string>();
  for (const caseId of orderedCaseIds) {
    const benchmarkCase = byId.get(caseId);
    if (!benchmarkCase) throw new Error(`case ${caseId} is not defined`);
    const caseHash = benchmarkCaseHash(benchmarkCase);
    for (const { variant, variantKey } of variants) {
      for (let repetition = 0; repetition < spec.repetitions; repetition += 1) {
        const runId = studyRunId(spec, { caseId, caseHash, variantKey, repetition });
        if (seen.has(runId)) throw new Error(`duplicate run ID ${runId}`);
        seen.add(runId);
        runs.push(Object.freeze({
          purpose,
          runId,
          specHash,
          caseId,
          caseHash,
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
