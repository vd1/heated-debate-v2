# Heated Debate v2 — segmented TDD plan

## Goal

Build a transparent debate-protocol laboratory in which protocol parameters can be varied, runs can be reproduced, and outcomes can be evaluated and optimized. Pi is the first model/conversation adapter; it is not the domain model or canonical datastore.

## Working rules

1. Execute exactly one numbered task at a time.
2. Start each behavior with a failing test.
3. Implement only enough to pass that task's tests.
4. Refactor only while all tests remain green.
5. End every task with tests, type checking, and linting green.
6. Unit tests never contact a model provider. Live tests are explicitly opted in.
7. Each task should fit one small reviewable commit; split it if it grows.
8. Do not optimize a parameter until it is represented in the canonical run record.

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

### Task 00 — repository test harness

**Red:** Add a trivial test that cannot run because no harness exists.

**Green:** Add the minimum Node/TypeScript test, typecheck, and lint setup; make one smoke test pass.

**Done when:** `test`, `typecheck`, and `lint` each run independently with no provider credentials.

### Task 01 — Pi capability spike

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

### Task 02 — domain-owned `AgentPort`

**Red:** Specify that a scripted agent receives a `TurnRequest` and returns normalized text, usage, timing, model identity, and effective controls.

**Green:** Implement only the domain types and `ScriptedAgent`.

**Done when:** No Pi type appears in the domain module's public API.

### Task 03 — Pi adapter, one turn

**Red:** Contract-test a `PiAgent` against the same behavior as `ScriptedAgent`, using a fake Pi stream/model.

**Green:** Implement one turn through Pi with an explicit empty tool policy.

**Done when:** Prompt, system role, output, usage, effective controls, and capability policy cross the boundary without a live API call. The design must not assume the allowlist stays empty.

### Task 04 — opt-in provider smoke test

Add one skipped-by-default integration test selected by environment variables. It sends a fixed minimal prompt through stored Pi authentication.

**Done when:** The test records provider/model/usage and gives a clear skip or authentication error. It is not part of CI's required unit suite.

---

## Milestone B — smallest useful debate

### Task 05 — one exchange

**Red:** Given scripted architect and reviewer replies, assert the reviewer receives the topic plus architect proposal in the defined order.

**Green:** Implement one architect→reviewer exchange.

**No dials, moderator, files, or persistence yet.**

### Task 06 — explicit role prompts

Test and add immutable role definitions for proposer and reviewer. Record role IDs and exact prompt text in results.

### Task 07 — multiple rounds

Test two rounds first. Agent A receives the prior review; Agent B receives the new proposal. Generalize only after the two-round test passes.

### Task 08 — explicit context policy

Introduce a `ContextPolicy` boundary. First implementation: `last-exchange`. Tests must show exactly which messages each agent receives. Add no summarization yet.

### Task 09 — creativity schedule

Port the 5→1 dial as a pure function. Use table-driven tests for 1, 2, 3, and 5 rounds and boundary validation. Inject the resulting instruction explicitly into each `TurnRequest`.

---

## Milestone C — transparent run artifacts

### Task 10 — canonical event schema

Define versioned events for run start/end, turn request/completion/failure, and effective controls. Test JSON round trips and schema-version rejection.

### Task 11 — append-only JSONL writer

Test ordered append, flush, and interrupted-run readability using temporary files. No Markdown yet.

### Task 12 — deterministic replay

Given a recorded run and scripted replies, reconstruct the sequence of turn requests. Test that replay detects prompt/config drift.

### Task 13 — Markdown projection

Render a human-readable transcript solely from canonical events. Snapshot-test a tiny run. Markdown is a projection, never the source of truth.

### Task 14 — failure semantics

Table-test timeout, cancellation, empty output, provider failure, and partial-run closure. Do not call `process.exit` from domain code.

### Task 15 — tool capability policy

Define a per-role/per-phase capability policy containing an explicit tool allowlist, call budget, timeout, and result-size limit. Default to no tools, but do not hard-code tool-free agents. Test denial of undeclared tools and exhaustion of budgets.

### Task 16 — deterministic tool loop

Give a scripted agent one fake search tool. Test tool request → execution → result → final response, including malformed arguments, tool failure, and cancellation. Record tool schemas, calls, results, durations, and errors as canonical events.

### Task 17 — opt-in web search adapter

Add one provider-independent `WebSearchPort` implementation behind a Pi tool. Contract-test it with a fake HTTP/search backend; keep the live test opt-in. Capture query, result provenance, timestamps, and truncation. Never place secrets in run artifacts.

---

## Milestone D — parameterized experiments

### Task 18 — versioned `ExperimentConfig`

Add validated configuration for topic, roles, models, rounds, context policy, and per-turn controls. Test defaults (`openai-codex/gpt-5.6-sol`, thinking `high`), invalid values, explicit overrides, and canonical serialization.

### Task 19 — richer control vectors

One control at a time, with tests and provider capability reporting:

1. thinking/reasoning level;
2. maximum output tokens;
3. temperature;
4. creativity prompt dial;
5. risk tolerance;
6. deference;
7. verbosity;
8. tool allowlist and per-tool budgets.

Requested and effective values must both be recorded. Prompt dials, provider sampling controls, and tool capabilities remain separate dimensions.

### Task 20 — benchmark case format

Define a versioned case containing topic, optional source context, evaluation rubric, and provenance. Add three tiny fixture cases; no production corpus yet.

### Task 21 — experiment matrix

Generate deterministic run specifications from cases × parameter configurations × repetitions. Test stable run IDs and duplicate prevention.

### Task 22 — local-model route

Add an opt-in Pi model configuration smoke test for an OpenAI-compatible local endpoint (Gemma target). Keep endpoint/model selection external to domain code.

---

## Milestone E — evaluation before optimization

### Task 23 — deterministic evaluators

Implement non-LLM checks first: completion, contract adherence markers, repetition, output shape, token usage, and latency. Unit-test every score.

### Task 24 — judge rubric and structured result

Define a versioned multidimensional rubric. Contract-test judge parsing with scripted valid, malformed, and partial outputs. Preserve individual dimensions; do not collapse immediately to one score.

### Task 25 — judge agent

Implement a Pi-backed judge behind an `EvaluatorPort`. The judge sees only declared artifacts. Record judge model, prompt, controls, and raw response.

### Task 26 — evaluator reliability

Run repeated and permuted evaluations to measure variance, ordering bias, model self-preference, and judge disagreement. Produce a reliability report before optimization is enabled.

### Task 27 — reward function

Define a pure, versioned reward function such as quality minus weighted cost, latency, failure, and variance penalties. Table-test every term and retain the underlying reward vector.

---

## Milestone F — optimization

### Task 28 — local deterministic optimizer fixture

Use a toy objective to prove trial generation, persistence, resume, and best-trial selection without models.

### Task 29 — Optuna bridge

Connect the versioned experiment config and reward output to Optuna. Test process boundaries and malformed/missing run artifacts with a fake engine executable.

### Task 30 — bounded real study

Run a small preregistered study over one or two parameters, multiple benchmark cases, and repeated trials. Hold out at least one case from selection.

### Task 31 — comparison report

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
- Web/TUI interface

Each deferred feature must enter as a separately tested policy or adapter, not as branching logic in the scheduler.

## First execution

Start with **Task 00 only**. After it is green, review the diff and proceed to Task 01. Do not scaffold later milestones early.
