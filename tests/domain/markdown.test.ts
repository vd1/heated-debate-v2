import { describe, expect, test } from "bun:test";

import {
  parseCanonicalEvent,
  type CanonicalEvent,
} from "../../src/domain/events";
import { renderDebateMarkdown } from "../../src/domain/markdown";

const EVENTS: CanonicalEvent[] = [
  {
    schemaVersion: 2,
    runId: "artifact-1",
    sequence: 0,
    type: "run.started",
    data: {
      debateId: "debate-1",
      topic: "Choose `A` or B.",
      roundCount: 1,
      controls: {
        policyId: "run-controls",
        policyVersion: "1",
        evidence: "recorded",
        turnTimeoutMs: 30_000,
        wholeRunTimeoutMs: 120_000,
        budget: { maxTurns: 2, maxTokens: 10_000 },
      },
    },
  },
  {
    schemaVersion: 2,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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
    schemaVersion: 2,
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
- Run controls: \`run-controls@1\`
- Run control evidence: recorded
- Turn timeout: 30000 ms
- Whole-run timeout: 120000 ms
- Turn budget: 2
- Token budget: 10000

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

\`\`\`text
- Choose **A**.
- It is simpler.
\`\`\`

- Response model: \`test/model\`
- Duration: 25 ms

#### Observed control report

##### Model

- Requested: \`test/model\`
- Forwarded: \`test/model\`
- Adjusted: _not recorded_
- Unsupported: _not recorded_
- Provider verified: _not recorded_

##### Thinking level

- Requested: \`high\`
- Forwarded: \`high\`
- Adjusted: _not recorded_
- Unsupported: _not recorded_
- Provider verified: _not recorded_

##### Max output tokens

- Requested: \`4096\`
- Forwarded: _not recorded_
- Adjusted: _not recorded_
- Unsupported: recorded
- Unsupported reason:

\`\`\`text
route omits token cap
\`\`\`
- Provider verified: _not recorded_

#### Attempts

| # | Status | HTTP | Input | Output | Cache read | Cache write | Reasoning | Explicitly reported | Evidence source |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- | --- |
| 1 | succeeded | 200 | 12 | 7 | — | — | 2 | none | provider fields |

## Run outcome

Completed 1 turn.
"
`);
  });

  test("snapshot-isolates adversarial reply headings and backtick runs", () => {
    const events = structuredClone(EVENTS);
    const completion = events[3];
    if (completion?.type !== "turn.completed") throw new Error("bad fixture");
    completion.data.reply.text = "# Forged heading\n\n````\n## Run outcome\n````";

    const markdown = renderDebateMarkdown(events);
    const responseStart = markdown.indexOf("#### Response");
    const responseEnd = markdown.indexOf("- Response model:", responseStart);
    expect(markdown.slice(responseStart, responseEnd)).toMatchInlineSnapshot(`
"#### Response

\`\`\`\`\`text
# Forged heading

\`\`\`\`
## Run outcome
\`\`\`\`
\`\`\`\`\`

"
`);
    expect(markdown.lastIndexOf("## Run outcome")).toBeGreaterThan(responseEnd);
  });

  test("renders migrated historical controls as unrecorded rather than absent", () => {
    const historical = parseCanonicalEvent(JSON.stringify({
      schemaVersion: 1,
      runId: "historical",
      sequence: 0,
      type: "run.started",
      data: { debateId: "debate-1", topic: "Historical", roundCount: 1 },
    }));

    const markdown = renderDebateMarkdown([historical]);

    expect(markdown).toContain("Run control evidence: _unrecorded in historical schema v1_");
    expect(markdown).toContain("Turn timeout: _not recorded_");
    expect(markdown).not.toContain("Turn timeout: _not configured_");
  });

  test("renders a sanitized failed turn without requiring a completion", () => {
    const start = EVENTS[0];
    const request = EVENTS[1];
    if (!start || !request) throw new Error("bad fixture");
    const failed: CanonicalEvent[] = [
      start,
      request,
      {
        schemaVersion: 2,
        runId: "artifact-1",
        sequence: 2,
        type: "turn.failed",
        data: {
          turnId: "debate-1:round-1:proposer",
          failure: { code: "provider_error", message: "Provider unavailable" },
        },
      },
      {
        schemaVersion: 2,
        runId: "artifact-1",
        sequence: 3,
        type: "run.failed",
        data: { failure: { code: "run_failed", message: "Debate stopped" } },
      },
    ];

    const markdown = renderDebateMarkdown(failed);
    expect(markdown).toContain("**Turn failed — `provider_error`**\n\n```text\nProvider unavailable\n```");
    expect(markdown).toContain("**Run failed — `run_failed`**\n\n```text\nDebate stopped\n```");
  });

  test("renders an incomplete canonical prefix and requested turn with no outcome", () => {
    const prefix = EVENTS.slice(0, 2).map((event) => structuredClone(event));

    const markdown = renderDebateMarkdown(prefix);

    expect(markdown).toContain("_No turn outcome was recorded._");
    expect(markdown).toContain("Incomplete canonical event prefix; no run outcome was recorded.");
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
