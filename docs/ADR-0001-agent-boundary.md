# ADR-0001: Put Pi behind a project-owned agent boundary

## Status

Proposed; validate in Task A-PI-SPIKE.

## Decision

The debate domain will depend on a small `AgentPort`, not directly on Pi types. The first production adapter will use Pi to retain each participant's conversation and normalize model communication.

Conceptual boundary:

```ts
interface AgentPort {
  reply(request: TurnRequest): Promise<AgentReply>;
  dispose(): Promise<void>;
}
```

`TurnRequest` carries the explicit debate input, per-turn controls, and capability policy. `AgentReply` carries text, latency, and normalized usage split into optional input, output, cache-read, cache-write, and reasoning token counts; unavailable provider fields remain absent rather than becoming false zeroes. Tool activity is emitted into the canonical run trace. Exact types are finalized test-first in Task A-AGENT-PORT.

## Why

- Pi can own provider authentication, streaming, conversation mechanics, retries, cancellation, and model differences.
- The debate engine remains testable with scripted agents.
- Canonical experiment records do not depend on Pi's internal session format.
- Another backend can be added without changing debate scheduling.
- Agents can receive role-appropriate tools without coupling the scheduler to tool implementations.

## Tool rule

Debaters are not inherently tool-free. A role or phase may receive tools such as web search, document retrieval, calculation, or code execution. Capabilities must be explicit through an allowlist and bounded by call, time, and output budgets. Tool schemas and all calls/results must be represented in canonical run events so that an experiment can be audited and replayed. The first adapter test uses an empty allowlist only to establish the smallest baseline.

## Context rule

Pi may retain provider conversation state, but the engine remains the source of truth for what each participant is intended to know. Any implicit retained history must be observable in the adapter trace. Later context policies may choose persistent, replayed, bounded, or summarized histories.

## Default model

Live agents default to `openai-codex/gpt-5.6-sol` with thinking level `high`. Experiment configurations may override either value, and canonical run events record both requested and effective settings. Unit tests use fakes rather than this live default.

## Sampling controls

Pi's underlying `pi-ai` stream options include `temperature` and `maxTokens`, and Pi exposes thinking level. Provider support varies. Task A-PI-SPIKE must establish which controls are available through the chosen integration level and record the effective—not merely requested—controls. Unsupported controls must fail validation or be explicitly marked unsupported; they must never be silently ignored by the experiment layer.

Pi may perform retries, but the adapter trace must expose attempt count, outcome, and per-attempt usage. Canonical budgets and cost calculations include every observable attempt rather than only the final successful response.
