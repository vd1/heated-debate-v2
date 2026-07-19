# ADR-0001: Put Pi behind a project-owned agent boundary

## Status

Accepted after Task A-PI-SPIKE.

## Decision

The debate domain will depend on a small `AgentPort`, not directly on Pi types. The first production adapter will use Pi to retain each participant's conversation and normalize model communication.

Conceptual boundary:

```ts
interface AgentPort {
  reply(request: TurnRequest): Promise<AgentReply>;
  dispose(): Promise<void>;
}
```

`TurnRequest` carries the explicit debate input, per-turn controls, and capability policy. `AgentReply` carries text, latency, and normalized usage split into optional input, output, cache-read, cache-write, and reasoning token counts. Pi-ai exposes required numeric fields and may use zero when a provider omits a kind, so zero alone is not evidence of availability: positive values are present, while zero is retained only when adapter/provider evidence proves that kind was explicitly reported; otherwise it becomes absent. Reasoning tokens are treated as a reported subset of output unless an immutable pricing snapshot specifies separate billing. Tool activity is emitted into the canonical run trace. Exact types are finalized test-first in Task A-AGENT-PORT.

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

Live agents default to `openai-codex/gpt-5.6-sol` with thinking level `high`. Experiment configurations may override either value, and canonical run events record their requested, forwarded, adjusted, unsupported, and provider-verified states as applicable. Unit tests use fakes rather than this live default.

## Pi integration findings

Task A-PI-SPIKE selected Pi's low-level `Agent` with a `ModelRuntime.streamSimple` wrapper:

- `Agent` retains the transcript, preserves the explicit system prompt and tool list, emits typed streaming/lifecycle events, and supports cancellation.
- `ModelRuntime` supplies provider/model lookup and authentication without requiring coding-agent resource discovery.
- `AgentSession` is unnecessary for the engine boundary and would introduce session/resource machinery that the debate domain does not need.
- `Agent` has reset and abort operations but no dispose method; the project adapter must define disposal by aborting, waiting for idle, unsubscribing listeners, and clearing state.

The offline characterization tests use a fake stream and an in-memory `ModelRuntime`; they make no provider request.

## Sampling controls

Thinking level is native `Agent` state. `temperature` and `maxTokens` exist in `pi-ai` stream options but are not constructor options on low-level `Agent`, so the ModelRuntime stream wrapper must inject them. Known model metadata can reject unsupported thinking or temperature and clamp maximum output before a request.

Passing a value to the stream proves only that it was requested/forwarded, not that a provider honored it. The adapter and canonical events must distinguish `requested`, `forwarded`, `adjusted`, `unsupported`, and `providerVerified`; the term `effective` is deliberately avoided. Unsupported controls must fail validation or be explicitly reported; they must never be silently ignored.

Pi may perform retries, but the fake-stream spike cannot establish provider retry observability. Task A-PI-ADAPTER must instrument available response hooks and report attempt count, outcome, reporting evidence, and per-attempt usage where the provider exposes it. Missing or ambiguous-zero attempt usage remains absent, not zero. Canonical budgets and cost calculations include every observable attempt rather than only the final successful response.

Task A-PI-ADAPTER implemented this boundary and removed the disposable spike. The adapter records each HTTP response visible through Pi's response hook as an attempt; pre-final responses are failed attempts and the final response receives the final message usage. Retries hidden below that hook remain inherently unobservable and must not be invented. Usage evidence is an explicit adapter input: positive counts survive normalization, explicitly reported zeroes remain zero, and ambiguous zeroes become absent. Provider verification is recorded only when Pi supplies `responseModel`; forwarding alone is not mislabeled as verification.

Task A-LIVE-TURN added the production `ModelRuntime` factory and verified stored OAuth with `openai-codex/gpt-5.6-sol` in an explicitly opted-in bounded call. That response exposed positive input/output usage but no `responseModel`; the adapter correctly retained requested/forwarded model states without inventing provider verification.
