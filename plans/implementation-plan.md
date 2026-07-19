# Heated Debate v2 — segmented TDD plan

## Goal

Build a transparent debate-protocol laboratory in which protocol parameters can be varied, runs can be reproduced, and outcomes can be evaluated and optimized. Pi is the first model/conversation adapter; it is not the domain model or canonical datastore.

## Working rules

1. Execute exactly one identified task at a time.
2. Start each behavior with a failing test.
3. Implement only enough to pass that task's tests.
4. Refactor only while all tests remain green.
5. End every task with tests, type checking, and linting green.
6. Unit tests never contact a model provider. Live tests are explicitly opted in.
7. Each task should fit one small reviewable commit; split it if it grows.
8. Do not optimize a parameter until it is represented in the canonical run record.
9. Task IDs are stable slugs. Never rename existing IDs when inserting or reordering work; milestone letters record where a task was born, not its permanent location.

## Architectural direction

```text
ExperimentConfig
       |
       v
Debate protocol -----> AgentPort <----- ScriptedAgent (tests)
       |                   |
       |                   +----------- PiAgent (production)
       v
Run events (JSONL) --> Evaluators --> Reward vector --> Optimizer
```

The canonical event stream—not provider session state and not rendered Markdown—is the source of truth. Agents may use tools, but every available capability, call, result, error, and budget must be explicit and observable.

Unless a run overrides them explicitly, the production defaults are model `openai-codex/gpt-5.6-sol` and thinking level `high`. Unit tests use fakes and never invoke this default.

---

## Milestone A — prove the boundary

### Task A-HARNESS — repository test harness

Pin the initial toolchain to Bun 1.2+, TypeScript in strict mode, `bun test`, and ESLint. Add scripts named `test`, `typecheck`, and `lint`, plus a minimal GitHub Actions workflow that runs all three.

**Red:** Write the first meaningful smoke assertion before its minimal implementation.

**Green:** Add only enough configuration and implementation to make the smoke test and checks pass.

**Done when:** `bun run test`, `bun run typecheck`, and `bun run lint` each run independently with no provider credentials, and CI invokes the same commands.

### Task A-PI-SPIKE — Pi capability spike

Write characterization tests around a tiny disposable probe, not debate logic.

Prove:

- an agent can be created with an explicit system prompt and an explicit tool allowlist (initially empty);
- a scripted/fake stream can complete a turn without network access;
- emitted text and usage can be observed;
- conversation state is retained for a second turn;
- cancellation and disposal are defined;
- requested model, thinking level, maximum output, and temperature can be represented;
- unsupported provider controls can be detected or reported.

Compare Pi's low-level `Agent` with `AgentSession` only as needed. Choose the smallest integration that preserves `ModelRuntime` authentication and typed events without importing coding-agent defaults.

**Done when:** ADR-0001 is accepted or replaced with measured findings. No live provider is required for the normal test suite.

### Task A-AGENT-PORT — domain-owned `AgentPort`

**Red:** Specify that a scripted agent receives a `TurnRequest` and returns normalized text, timing, model identity, a control-status report, and normalized usage containing optional `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, and `reasoningTokens`. A positive pi-ai value proves presence; a zero maps to domain zero only when adapter evidence says that provider response explicitly reported that token kind. Without such evidence, zero maps to absent. Tests cover positive, explicitly reported zero, and ambiguous zero so unavailable data never becomes a false zero.

**Green:** Implement only the domain types and `ScriptedAgent`.

**Done when:** No Pi type appears in the domain module's public API.

### Task A-PI-ADAPTER — Pi adapter, one turn

**Red:** Contract-test a `PiAgent` against the same behavior as `ScriptedAgent`, using a fake Pi stream/model.

**Green:** Implement one turn through Pi with an explicit empty tool policy.

**Done when:** Prompt, system role, output, normalized usage, the full control-status taxonomy, and capability policy cross the boundary without a live API call. The adapter trace includes attempt count plus per-attempt status, reporting evidence, and usage so provider or Pi retries cannot disappear from budgets. Ambiguous pi-ai zeroes normalize to absent; explicit reported zeroes remain zero. The design must not assume the allowlist stays empty. Migrate any still-useful characterization coverage into adapter contract tests, then delete `spikes/pi-agent-probe.ts`, its dedicated probe test, and the `spikes/**/*.ts` tsconfig inclusion so the disposable probe cannot become a shadow adapter.

### Task A-LIVE-TURN — opt-in provider smoke test

Add one test gated by `HEATED_DEBATE_LIVE=1`; the ordinary suite must skip it before constructing any network-capable runtime. Add the smallest production factory that resolves an explicit model identity through `ModelRuntime`, verifies stored authentication, and creates `PiAgent`. Send a fixed minimal prompt with a short test timeout and small output cap, disposing in `finally`.

**Done when:** The test reports only normalized model identity, control states, and whatever usage kinds the provider actually exposes; it never treats forwarding as provider verification or emits credential/header data. Missing model/auth produces a clear failure when opted in, while the required CI suite remains offline.

---

## Milestone B — smallest useful debate

### Task B-EXCHANGE — one exchange

**Red:** Define an exchange as exactly two ordered turns—proposer then reviewer—and assert the complete reviewer `TurnRequest`, not substring inclusion. Use a deterministic turn-ID rule and keep topic, proposal, and review structurally distinct.

**Green:** Implement one proposer→reviewer exchange returning immutable snapshots of both requests and replies. Keep model controls and the empty capability policy explicit; add no dials, moderator, files, or persistence.

### Task B-ROLES — explicit role prompts

Test and add runtime-immutable, versioned role definitions for proposer and reviewer. Record each stable role ID and exact prompt snapshot used by every turn; role behavior remains separate from agent/model assignment.

### Task B-CONTEXT — explicit context policy

Before implementing multiple rounds, introduce a pure `ContextPolicy` boundary returning a named/versioned decision and an exact ordered list of normalized model-input messages. Define `last-exchange` separately for proposer and reviewer and test inclusion/order of topic, own prior response, counterparty response, and current proposal. Extend `TurnRequest` to carry this selected list. `PiAgent` must synchronize its internal transcript to the selected messages—reset/replay on mismatch—so retained provider state can never add undeclared context. Add no summarization yet.

### Task B-ROUNDS — multiple rounds

After B-CONTEXT, test two rounds with exact ordered inputs and chronological results. One round is two turns; absent failure, `roundCount` yields `2 * roundCount` requests. Round one has no prior review, later proposer turns consume only the context-policy-selected prior review, and reviewer turns consume the current proposal. Prove no earlier exchange leaks through Pi retention.

### Task B-DIAL — creativity schedule

Port the 5→1 dial as a pure function. Use table-driven tests for 1, 2, 3, and 5 rounds and boundary validation. Inject the resulting instruction explicitly into each `TurnRequest`.

### Task B-LIVE-DEBATE — opt-in live two-round debate

Run one skipped-by-default two-round debate through `PiAgent` using the default model or explicit environment overrides. Verify real conversation retention, streaming completion, control-status reporting across the full taxonomy, and clean disposal under real latency.

**Done when:** The shared live-debate harness produces a complete in-memory result or a clear skip/authentication failure and remains outside the required unit suite. C-LIVE-ARTIFACT later reuses and supersedes this path for persisted-run validation rather than creating a second live harness.

---

## Milestone C — transparent run artifacts

### Task C-EVENTS — canonical event schema

Define a closed, discriminated event union with schema version, run ID, monotonic sequence, event type, and event-specific data. Turn-request events include role/round/turn IDs, the context-policy decision, every exact model-input message, controls, and capabilities; completion/failure links back to the request; attempt events preserve attempt number, status, observable HTTP status, usage, and evidence. Represent controls with `requested`, `forwarded`, `adjusted`, `unsupported`, and `providerVerified`, never ambiguous `effective`. Validate traces before serialization: `unsupported` excludes forwarded/adjusted/verified; adjustment requires an equal forwarded value; forwarding never implies verification. Preserve unavailable or ambiguous-zero usage as absent. Define compatibility for unknown fields/versions and sanitized domain failures. Canonical types expose no credentials/headers; sentinel-secret tests prove configured secrets cannot reach serialization without claiming arbitrary user/model prose is secret-free.

### Task C-JSONL — append-only JSONL writer

Test ordered append, flush, and interrupted-run readability using temporary files. No Markdown yet.

### Task C-REPLAY — deterministic replay

Given a recorded run and scripted replies, reconstruct the sequence of turn requests. Test that replay detects prompt/config drift.

### Task C-LIVE-ARTIFACT — opt-in live canonical artifact smoke

Re-run the two-round live smoke through the canonical writer, then parse and replay its JSONL. Verify well-formed events, per-attempt accounting, persistence across turns, flush/closure, and absence of secrets. Keep it skipped by default and budget-bounded.

### Task C-MARKDOWN — Markdown projection

Render a human-readable transcript solely from canonical events. Snapshot-test a tiny run. Markdown is a projection, never the source of truth.

### Task C-FAILURES — failure semantics

First extend `AgentPort` with standard-signal cancellation and a normalized typed failure carrying partial attempt traces; `dispose()` remains cleanup, not the only cancellation API. Add adapter-attempt observation where Pi exposes it and explicitly document hidden retries. Then land table-tested timeout, cancellation, whitespace-only output, provider failure, per-run turn/token exhaustion, and partial-run closure one behavior at a time. A turn is one dispatched request, attempts are not turns, attempt usage is summed once, absent usage remains unknown, and reasoning subsets are not double-counted. The domain loop checks before turns and after observable attempts, stops at the first observable overage, emits exactly one terminal outcome, and disposes resources in `finally`. Monetary rows remain in D-PRICING. Do not call `process.exit` or inspect Git from domain code.

### Task C-TOOL-POLICY — tool capability policy

Define a pure, versioned per-role/per-phase policy with allowed tool IDs/schema versions, aggregate and per-tool call limits, timeout, and byte-defined result limit. Keep environment availability separate. Test uniqueness, positive/zero semantics, authorization, and accounting: accepted execution consumes budget even when it fails/times out; denied calls are recorded but do not consume budget unless explicitly configured.

### Task C-TOOL-LOOP — deterministic tool loop

Introduce a project-owned normalized tool request/result/error vocabulary and dispatcher. Pi `AgentTool` wrappers and a scripted model driver both use that dispatcher, which alone enforces C-TOOL-POLICY and emits traces. Test malformed arguments, undeclared tools, timeout, thrown errors, cancellation, oversized output, and success followed by final response. Record stable call/schema IDs, arguments, ordering, duration, truncation, and sanitized errors. Replay feeds recorded results back at the exact message position and compares the whole trace; Pi's internal transcript is never the only result copy.

### Task C-WEB-SEARCH — opt-in web search adapter

Add one provider-independent `WebSearchPort` implementation behind a Pi tool. Contract-test it with a fake HTTP/search backend; keep the live test opt-in. Capture query, result provenance, timestamps, and truncation. Never place secrets in run artifacts.

---

## Milestone D — parameterized experiments

### Task D-PRICING — versioned pricing snapshot

Define a versioned model-pricing snapshot with provider/model identity, input/output/cache rates, currency, effective date, provenance, and an explicit reasoning billing rule per model: `included-in-output`, `unbilled`, or `separate-rate` with its own rate. Treat reported reasoning tokens as a subset of output unless the snapshot explicitly selects `separate-rate`, preventing accidental double charging. Include deterministic fixtures and an explicit zero-cost local-model entry. Test usage-to-cost calculation, reasoning modes, and monetary-budget exhaustion in the domain loop; require run artifacts to identify the exact snapshot or hash used and never recompute historical costs from a mutable current table. If a priced token kind is absent from provider usage, monetary cost is `unknown`, not zero, and monetary budget enforcement fails closed unless the study spec explicitly permits token-only accounting.

### Task D-CONFIG — versioned `ExperimentConfig`

Define validated configuration for one run: topic/case reference, immutable roles and agent assignments, protocol/round/context settings, per-turn controls, capabilities, and `RunBudget` for turns/tokens plus optional monetary limit tied to a pricing snapshot. Aggregate study concurrency/budgets belong to D-STUDY-SPEC/D-EXECUTOR. Parse untrusted JSON rather than cast it; test defaults (`openai-codex/gpt-5.6-sol`, thinking `high`), unknown fields/version, omission versus explicit values, per-role overrides, cross-field constraints, retry-inclusive usage, and canonical round trips.

### Task D-CONTROLS — end-to-end control propagation audit

Do not add controls again. Prove each existing dimension travels from validated config through scheduling/request, adapter or policy enforcement, control report, and canonical events; only then mark it matrix-eligible. Provider taxonomy applies to thinking, output limit, and temperature. Creativity materializes as an exact prompt instruction, while tool allowlists are enforced by the project dispatcher—neither receives fictitious provider verification. Test all five separately so prompt dials and temperature cannot recouple.

### Task D-CASES — benchmark case format

Define a versioned case containing topic, optional source context, evaluation rubric, and provenance. Add three tiny fixture cases; no production corpus yet.

### Task D-STUDY-SPEC — preregistered study specification

Define a versioned study-spec file containing hypotheses, benchmark and holdout case IDs, fixed and varied parameters, repetitions, evaluator/rubric version references, pricing snapshot, budgets, stopping rules, planned analysis, and preregistered reliability thresholds such as minimum sample count, maximum judge variance, and maximum ordering-bias effect. Evaluator and rubric IDs are opaque versioned references here and are resolved only when evaluation or study execution begins. Test canonical hashing and require every generated run ID to reference the study-spec hash. Committed/clean-worktree enforcement is an executor/CLI concern, never domain logic; a real study rejects an uncommitted spec unless an explicit non-preregistered development flag is used.

### Task D-MATRIX — experiment matrix

Generate deterministic run specifications from cases × parameter configurations × repetitions. Test stable run IDs and duplicate prevention.

### Task D-EXECUTOR — resumable matrix executor

Execute a matrix through the domain runner using scripted agents. Test deterministic artifact-directory mapping, bounded concurrency, study-budget enforcement, continuation after an individual run failure, resume after interruption, and skipping already-completed run IDs.

### Task D-LOCAL-MODEL — local-model route

Add an opt-in Pi model configuration smoke test for an OpenAI-compatible local endpoint (Gemma target). Keep endpoint/model selection external to domain code.

---

## Milestone E — evaluation before optimization

### Task E-DETERMINISTIC — deterministic evaluators

Implement non-LLM checks first: completion, contract adherence markers, repetition, output shape, token usage, and latency. Unit-test every score.

### Task E-RUBRIC — judge rubric and structured result

Define versioned dimensions, scales, direction, required evidence, and parsing schema. Valid, malformed, and partial outputs produce typed outcomes; missing dimensions never become zero. Also version a canonical evaluation record linking rubric and source artifact hashes with declared judge inputs, exact prompt/messages, controls, raw response, parsed dimensions, artifact references, and sanitized failure data.

### Task E-JUDGE — judge agent

Implement a Pi-backed judge behind `EvaluatorPort`, using a fresh/reset agent and exact messages built only from declared artifacts, with no tools by default. Preserve raw response even on parse failure and atomically write the linked E-RUBRIC evaluation record. Offline tests use scripted responses; any provider smoke is separately opt-in and budget-bounded.

### Task E-RELIABILITY — opt-in evaluator reliability study

Run repeated and permuted live evaluations to measure variance, ordering bias, model self-preference, and judge disagreement. Keep it skipped by default and enforce the study-spec token/cost/turn guardrails. Persist a versioned canonical reliability artifact containing judge model, prompts, controls, pricing snapshot, sample IDs, raw score vectors, analysis version, conclusions, evaluated threshold results, and status `accepted` or `rejected`. Status is derived deterministically: `accepted` only when every preregistered threshold in the referenced study spec passes; otherwise `rejected`. Optimization requires a matching accepted artifact.

### Task E-REWARD — reward function

Define a pure, versioned reward function such as quality minus weighted token cost, latency, failure, and variance penalties. If monetary cost is included, derive it only from recorded per-attempt usage and the run's immutable pricing snapshot. Table-test every term and retain the underlying reward vector.

---

## Milestone F — optimization

### Task F-OPTIMIZER-FIXTURE — local deterministic optimizer fixture

Use a toy objective to prove trial generation, persistence, resume, and best-trial selection without models.

### Task F-SCHEMA — engine interchange schema

Define and version the JSON-over-stdio contract: one run specification enters on stdin and exactly one reward vector or structured failure exits on stdout. Test canonical serialization, schema-version mismatch, malformed values, and output framing independently of any process or model.

### Task F-ENGINE-CLI — real engine JSON entry point

Build the production executable implementing F-SCHEMA. Execute the debate and declared evaluators, emit contract output only on stdout, and send diagnostics only to stderr. Contract-test exit codes, malformed input, interruption, budget exhaustion, artifact paths, and Git cleanliness/study-spec commit stamping using scripted agents. This is also the minimal human-facing CLI; a richer TUI remains deferred.

### Task F-OPTUNA — Optuna bridge

Consume F-SCHEMA from Optuna rather than redefining it. Test process boundaries and malformed/missing output with a fake schema-conformant engine executable.

### Task F-STUDY — bounded real study

Run a small study from a versioned study-spec file committed before execution. Vary only one or two parameters, use multiple benchmark cases and repetitions, enforce all declared budgets, and hold out at least one case from selection. Persist the study-spec Git commit and hash with every trial.

### Task F-REPORT — comparison report

Report baseline vs selected protocol on quality dimensions, cost, latency, failure rate, and variance. Do not call a protocol “better” based only on its training topics or the selecting judge.

---

## Deferred until evidence justifies them

- Dynamic moderator
- Convergence disruption
- Expert panels
- Multi-phase debates
- Tournament/beam search
- Summarizing context policies
- Model fine-tuning or preference training
- Risk-tolerance, deference, and verbosity dials until a benchmark and rubric consume them
- Web/TUI interface

Each deferred feature must enter as a separately tested policy or adapter, not as branching logic in the scheduler.

## First execution

Start with **Task A-HARNESS only**. After it is green, review the diff and proceed to Task A-PI-SPIKE. Do not scaffold later milestones early.
