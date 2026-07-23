import { defineCaseSet } from "../domain/cases";
import { ENGINE_SCHEMA_VERSION, type EngineOutput } from "../domain/engine-schema";
import { generateExperimentMatrix, type RunSpecification } from "../domain/matrix";
import {
  assertPreregisteredStudy,
  parseStudySpec,
  studySpecHash,
  type PreregistrationEvidence,
} from "../domain/study-spec";
import { runEngineTrial } from "./engine-client";

export interface StudyTrial {
  runId: string;
  caseId: string;
  point: Readonly<Record<string, unknown>>;
  repetition: number;
  /** The study-spec commit and hash persisted with every trial. */
  specHash: string;
  commit: string | null;
  output: EngineOutput;
}

export interface BoundedStudyInput {
  /** The committed study-spec file content, verbatim. */
  specText: string;
  /** The case-collection file content, verbatim. */
  casesText: string;
  casesPath: string;
  engineCommand: readonly string[];
  artifactRoot: string;
  evidence: PreregistrationEvidence;
  persistTrial(trial: StudyTrial): Promise<void>;
  timeoutMs?: number;
}

export interface BoundedStudyOutcome {
  specHash: string;
  attestationMode: "preregistered" | "development";
  trials: readonly StudyTrial[];
}

function variedPoint(
  run: RunSpecification,
  fixedKeys: readonly string[],
): Readonly<Record<string, unknown>> {
  const point: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(run.parameters)) {
    if (!fixedKeys.includes(key)) point[key] = value;
  }
  return point;
}

/**
 * F-STUDY driver: runs the preregistered selection matrix through the engine
 * executable, one bounded trial per run, persisting the study-spec commit and
 * hash with every trial. Holdout cases never enter the selection matrix.
 */
export async function runBoundedStudy(input: BoundedStudyInput): Promise<BoundedStudyOutcome> {
  const spec = parseStudySpec(JSON.parse(input.specText));
  const attestation = assertPreregisteredStudy(spec, input.evidence);
  const cases = defineCaseSet(JSON.parse(input.casesText) as unknown[]);
  const runs = generateExperimentMatrix(spec, cases);
  const fixedKeys = Object.keys(spec.fixedParameters);
  const specHash = studySpecHash(spec);

  const trials: StudyTrial[] = [];
  for (const run of runs.slice(0, spec.stoppingRules.maxRuns)) {
    const point = variedPoint(run, fixedKeys);
    const result = await runEngineTrial({
      command: [
        ...input.engineCommand,
        "--cases", input.casesPath,
        "--artifact-root", input.artifactRoot,
        ...(attestation.mode === "development" ? ["--allow-non-preregistered"] : []),
      ],
      input: {
        schemaVersion: ENGINE_SCHEMA_VERSION,
        spec,
        run: { runId: run.runId, caseId: run.caseId, point, repetition: run.repetition },
      },
      // The engine re-verifies preregistration from the same evidence.
      env: {
        ...(input.evidence.commit === undefined
          ? {}
          : { HEATED_DEBATE_GIT_COMMIT: input.evidence.commit }),
        ...(input.evidence.cleanWorktree === undefined
          ? {}
          : { HEATED_DEBATE_GIT_CLEAN: input.evidence.cleanWorktree ? "1" : "0" }),
      },
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
    const trial: StudyTrial = {
      runId: run.runId,
      caseId: run.caseId,
      point,
      repetition: run.repetition,
      specHash,
      commit: attestation.commit,
      output: result.output,
    };
    await input.persistTrial(trial);
    trials.push(trial);
  }
  return { specHash, attestationMode: attestation.mode, trials: Object.freeze(trials) };
}
