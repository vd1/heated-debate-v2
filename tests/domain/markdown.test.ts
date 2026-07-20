import { describe, expect, test } from "bun:test";

import type { CanonicalEvent } from "../../src/domain/events";
import { renderDebateMarkdown } from "../../src/domain/markdown";

const EVENTS: CanonicalEvent[] = [
  {
    schemaVersion: 1,
    runId: "artifact-1",
    sequence: 0,
    type: "run.started",
    data: { debateId: "debate-1", topic: "Choose `A` or B.", roundCount: 1 },
  },
  {
    schemaVersion: 1,
    runId: "artifact-1",
    sequence: 1,
    type: "turn.requested",
    data: {
      roundNumber: 1,
      request: {
        turnId: "debate-1:round-1:proposer",
        role: { id: "proposer", version: "1", systemPrompt: "Propose." },
        creativity: {
          scheduleId: "linear-cooling",
          scheduleVersion: "1",
          level: 5,
          instruction: "Explore radical alternatives. Question the premise. Propose unconventional approaches even if risky.",
        },
        context: {
          policyId: "last-exchange",
          policyVersion: "1",
          messages: [{ role: "user", content: "Topic:\nChoose `A` or B." }],
        },
        controls: {
          model: { providerId: "test", modelId: "model" },
          thinkingLevel: "high",
          maxOutputTokens: 4_096,
        },
        capabilities: { toolNames: [] },
      },
    },
  },
  {
    schemaVersion: 1,
    runId: "artifact-1",
    sequence: 2,
    type: "adapter.attempt",
    data: {
      turnId: "debate-1:round-1:proposer",
      attempt: {
        attempt: 1,
        status: "succeeded",
        httpStatus: 200,
        usage: { inputTokens: 12, outputTokens: 7, reasoningTokens: 2 },
        usageEvidence: { explicitlyReported: [], source: "provider fields" },
      },
    },
  },
  {
    schemaVersion: 1,
    runId: "artifact-1",
    sequence: 3,
    type: "turn.completed",
    data: {
      turnId: "debate-1:round-1:proposer",
      reply: {
        text: "- Choose **A**.\n- It is simpler.",
        durationMs: 25,
        model: { providerId: "test", modelId: "model" },
        controls: {
          model: {
            requested: { providerId: "test", modelId: "model" },
            forwarded: { providerId: "test", modelId: "model" },
          },
          thinkingLevel: { requested: "high", forwarded: "high" },
          maxOutputTokens: {
            requested: 4_096,
            unsupported: { reason: "route omits token cap" },
          },
        },
      },
    },
  },
  {
    schemaVersion: 1,
    runId: "artifact-1",
    sequence: 4,
    type: "run.completed",
    data: { turnCount: 1 },
  },
];

describe("renderDebateMarkdown", () => {
  test("snapshot-renders a tiny run solely from canonical events", () => {
    expect(renderDebateMarkdown(EVENTS)).toMatchInlineSnapshot(`
"# Debate Transcript

- Artifact run: \`artifact-1\`
- Debate ID: \`debate-1\`
- Planned rounds: 1

## Topic

\`\`\`text
Choose \`A\` or B.
\`\`\`

## Round 1

### Proposer — \`debate-1:round-1:proposer\`

- Role: \`proposer@1\`
- Creativity: \`linear-cooling@1\`, level 5/5
- Context policy: \`last-exchange@1\`
- Requested model: \`test/model\`
- Requested thinking: \`high\`
- Requested max output tokens: 4096
- Tools: none

#### System prompt

\`\`\`text
Propose.
\`\`\`

#### Exact model input 1 — user

\`\`\`text
Topic:
Choose \`A\` or B.
\`\`\`

#### Response

- Choose **A**.
- It is simpler.

- Response model: \`test/model\`
- Duration: 25 ms

#### Attempts

| # | Status | HTTP | Input | Output | Reasoning |
| ---: | --- | ---: | ---: | ---: | ---: |
| 1 | succeeded | 200 | 12 | 7 | 2 |

## Run outcome

Completed 1 turn.
"
`);
  });

  test("renders a sanitized failed turn without requiring a completion", () => {
    const start = EVENTS[0];
    const request = EVENTS[1];
    if (!start || !request) throw new Error("bad fixture");
    const failed: CanonicalEvent[] = [
      start,
      request,
      {
        schemaVersion: 1,
        runId: "artifact-1",
        sequence: 2,
        type: "turn.failed",
        data: {
          turnId: "debate-1:round-1:proposer",
          failure: { code: "provider_error", message: "Provider unavailable" },
        },
      },
      {
        schemaVersion: 1,
        runId: "artifact-1",
        sequence: 3,
        type: "run.failed",
        data: { failure: { code: "run_failed", message: "Debate stopped" } },
      },
    ];

    const markdown = renderDebateMarkdown(failed);
    expect(markdown).toContain("**Turn failed — `provider_error`:** Provider unavailable");
    expect(markdown).toContain("**Run failed — `run_failed`:** Debate stopped");
  });

  test("rejects non-monotonic input instead of rendering a misleading transcript", () => {
    const start = EVENTS[0];
    const request = EVENTS[1];
    if (!start || !request) throw new Error("bad fixture");
    expect(() => renderDebateMarkdown([start, { ...request, sequence: 3 }])).toThrow(
      "expected sequence 1, received 3",
    );
  });
});
