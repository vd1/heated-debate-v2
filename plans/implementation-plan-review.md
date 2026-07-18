# Review of the implementation plan

Reviewed: [`plans/implementation-plan.md`](implementation-plan.md), 2026-07-18.
Read alongside [`docs/ADR-0001-agent-boundary.md`](../docs/ADR-0001-agent-boundary.md), `AGENTS.md`,
`README.md`, and the v1 repository (`../heated-debate/`).

**Verdict:** sound to execute as written, with four real gaps and a few smaller nits worth fixing
before Task 00.

## Strengths

- The ports-and-adapters boundary (`AgentPort`, `EvaluatorPort`, `WebSearchPort`) matches ADR-0001,
  and the domain stays free of Pi types.
- Canonical events as the source of truth, with Markdown as a projection (Task 13), is the right
  call for reproducibility.
- Working rule 8 ("do not optimize a parameter until it is represented in the canonical run
  record") and Task 26 (evaluator reliability before optimization) are the kind of rigor most
  plans skip.
- The deferred list has a real entry criterion: each feature arrives as a separately tested policy
  or adapter, not branching logic in the scheduler.
- Separating prompt dials from provider sampling controls (Task 19) fixes a v1 coupling, where the
  dial and temperature were bound together in `dials.py`.

## Gaps

### 1. No experiment runner between Task 21 and Task 30

Task 21 *generates* deterministic run specifications; Task 30 *runs* a real study. Nothing in
between owns executing a matrix: iterating N runs, surviving a failure mid-matrix, resuming a
partially completed matrix, skipping already-completed run IDs, and mapping run IDs to an artifact
directory layout. Task 28 covers persistence and resume for the *optimizer's trials*, which is a
different loop.

**Suggestion:** insert a "matrix executor" task between Tasks 21 and 22 (or fold it into Task 21
with explicit acceptance criteria), tested with scripted agents for resume and duplicate-skip
behavior.

### 2. First live end-to-end debate happens about 28 tasks in

Task 04 proves one live turn; the next live exercise is Task 30's real study. Everything between
uses scripted agents. That is a long time for integration assumptions to drift from the fakes:
Pi conversation retention across rounds, effective-controls reporting, and streaming behavior
under real latency.

**Suggestion:** add an opt-in live smoke test — one two-round debate through `PiAgent` — at the
end of Milestone B or C, symmetrical with Task 04.

### 3. Replay is defined before tools exist

Task 12 defines deterministic replay; Task 16 later records tool events but does not say replay
must handle them. Without an explicit criterion, replay quietly stays correct only for tool-free
runs — exactly the drift Task 12 exists to catch.

**Suggestion:** add to Task 16's acceptance criteria: replay reconstructs tool-using runs,
including tool results as inputs to subsequent turn requests.

### 4. Toolchain is unspecified, and Task 00 depends on it

Task 00 says "minimum Node/TypeScript test setup" but never names the runner or linter. The house
preference is bun, and v1 is a bun project.

**Suggestion:** pin the toolchain in the plan — `bun test` (or vitest under bun) plus concrete
typecheck and lint commands — so "`test`, `typecheck`, and `lint` each run independently" is
verifiable. Related: Task 04 references "CI's required unit suite," but no task sets up CI;
either add CI to Task 00 or drop the CI wording.

## Smaller nits

- **Task 29 (Optuna bridge)** crosses a language boundary: Optuna is Python (v1's `optimize.py`,
  run via uv), the engine is TypeScript. The plan tests process boundaries, which is right, but
  the interchange format — how config goes in and the reward vector comes back (JSON over stdio
  versus files) — should be named and versioned like everything else, since it is effectively
  another canonical schema.
- **Secrets redaction** appears only in Task 17 (web search). Since Task 10 defines the event
  schema, a general "no credentials or secrets in canonical events" invariant belongs there,
  tested once, rather than per adapter.
- **Cost guardrails:** per-turn usage is recorded, but nothing enforces a study-level budget
  before Task 30 spends real money. A max-cost or max-turns cutoff in `ExperimentConfig`
  (Task 18) would be cheap insurance.
- **Task 00's red step** ("add a test that cannot run because no harness exists") is ritual
  rather than signal — harmless, but do not let it force awkward gymnastics.

## Explicitly not recommended to change

The ordering of Task 09 (creativity dial) before the control-vector formalization in Task 19 is
fine, because the plan already keeps prompt dials and provider sampling controls as separate
dimensions.
