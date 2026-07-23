import { expect, test } from "bun:test";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { createReliabilityArtifact } from "../../src/domain/reliability";
import { parseRubric } from "../../src/domain/rubric";
import { parseStudySpec } from "../../src/domain/study-spec";
import { collectReliabilitySamples } from "../../src/infrastructure/reliability-collector";
import { createPiAgentFromRuntime } from "../../src/infrastructure/pi-agent";
import { LIVE_ENABLED, LIVE_MODEL, LIVE_TURN_TIMEOUT_MS, withTimeout } from "./support";

// Opt-in reliability probe: the offline-tested collector drives repeated,
// seed-permuted live judge evaluations over one small recorded artifact,
// bounded by the study-spec guardrails.
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
    const judgeControls = {
      model: LIVE_MODEL,
      thinkingLevel: "low" as const,
      maxOutputTokens: 512,
    };
    const collection = await withTimeout(
      collectReliabilitySamples({
        spec,
        rubric,
        events,
        judgeControls,
        createAgent: () => createPiAgentFromRuntime({ runtime, model: LIVE_MODEL }),
        persistRecord: () => Promise.resolve(),
        sampleCount: Math.min(spec.reliabilityThresholds.minimumSampleCount, 6),
        budgets: { maxTotalTokens: spec.budgets.perRun.maxTokens },
      }),
      LIVE_TURN_TIMEOUT_MS * 6,
      "reliability collection",
    );

    const artifact = createReliabilityArtifact({
      spec,
      judge: {
        model: LIVE_MODEL,
        controls: judgeControls,
        promptText: `judge-rubric-json-v1:${rubric.rubricId}@${rubric.rubricVersion}`,
      },
      samples: collection.samples,
      missingEvaluations: collection.missingEvaluations,
      conclusions: "live probe",
    });
    expect(artifact.evaluatedThresholds.length).toBeGreaterThanOrEqual(3);
    expect(artifact.samples.length + artifact.missingEvaluations.length)
      .toBe(collection.orderings.length);
  }, LIVE_TURN_TIMEOUT_MS * 8);
}
