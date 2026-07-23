import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createReliabilityArtifact, type ReliabilitySample } from "../../src/domain/reliability";
import { parseRubric } from "../../src/domain/rubric";
import { parseStudySpec } from "../../src/domain/study-spec";
import { createJudgeEvaluator } from "../../src/infrastructure/judge";
import { createPiAgentFromRuntime } from "../../src/infrastructure/pi-agent";
import { LIVE_ENABLED, LIVE_MODEL, LIVE_TURN_TIMEOUT_MS, withTimeout } from "./support";

// Opt-in reliability probe: repeated and permuted live judge evaluations over
// one small recorded artifact, bounded by the study-spec guardrails.
const SPEC_PATH = process.env.HEATED_DEBATE_RELIABILITY_SPEC;

if (!LIVE_ENABLED || SPEC_PATH === undefined) {
  test.skip("requires HEATED_DEBATE_LIVE=1 and HEATED_DEBATE_RELIABILITY_SPEC", () => {});
} else {
  test("runs a bounded repeated/permuted live reliability probe", async () => {
    const spec = parseStudySpec(JSON.parse(await Bun.file(SPEC_PATH).text()));
    const rubric = parseRubric({
      rubricVersion: "1",
      rubricId: spec.rubric.rubricId,
      dimensions: [{
        dimensionId: "quality",
        description: "Overall argument quality.",
        scale: { min: 1, max: 5 },
        direction: "higher-is-better",
        requiredEvidence: "none",
      }],
    });
    const artifactPath = process.env.HEATED_DEBATE_RELIABILITY_ARTIFACT;
    if (artifactPath === undefined) throw new Error("HEATED_DEBATE_RELIABILITY_ARTIFACT is required");
    const { readCanonicalJsonl } = await import("../../src/infrastructure/jsonl-events");
    const { events } = await readCanonicalJsonl(artifactPath);

    const runtime = await ModelRuntime.create();
    const samples: ReliabilitySample[] = [];
    const sampleBudget = Math.min(spec.reliabilityThresholds.minimumSampleCount, 6);
    for (let index = 0; index < sampleBudget; index += 1) {
      const ordering = index % 2 === 0 ? "forward" as const : "reversed" as const;
      const ordered = ordering === "forward" ? events : [...events].reverse()
        .map((event, sequence) => ({ ...event, sequence }));
      const evaluator = createJudgeEvaluator({
        rubric,
        controls: { model: LIVE_MODEL, thinkingLevel: "low", maxOutputTokens: 512 },
        createAgent: () => createPiAgentFromRuntime({ runtime, model: LIVE_MODEL }),
        persistRecord: () => Promise.resolve(),
      });
      const { result } = await withTimeout(
        evaluator.evaluate(ordering === "forward" ? events : ordered),
        LIVE_TURN_TIMEOUT_MS,
        `reliability sample ${String(index)}`,
      );
      if (result.status === "known") {
        samples.push({
          sampleId: `live-${String(index)}`,
          ordering,
          judgeModel: LIVE_MODEL,
          debaterModel: LIVE_MODEL,
          score: result.score,
        });
      }
    }

    const artifact = createReliabilityArtifact({
      spec,
      judge: {
        model: LIVE_MODEL,
        controls: { model: LIVE_MODEL, thinkingLevel: "low" },
        promptText: rubric.rubricId,
      },
      samples,
      conclusions: "live probe",
    });
    expect(artifact.evaluatedThresholds).toHaveLength(3);
    expect(artifact.sampleIds.length).toBeLessThanOrEqual(6);
  }, LIVE_TURN_TIMEOUT_MS * 8);
}
