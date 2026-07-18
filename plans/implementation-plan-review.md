# Review of the implementation plan

Reviews [`plans/implementation-plan.md`](implementation-plan.md), read alongside
[`docs/ADR-0001-agent-boundary.md`](../docs/ADR-0001-agent-boundary.md), `AGENTS.md`, `README.md`,
and the v1 repository (`../heated-debate/`).

Task numbers below refer to the revised plan (34 tasks, 00–33).

## Round 2 — 2026-07-18, after revision

All round-1 findings were addressed; see the log at the bottom. The revised plan is stronger.
These are second-order findings against the new version.

### Gaps

#### 1. Nothing builds the real engine executable that Task 31 assumes

Task 31 defines the JSON-over-stdio interchange (run spec on stdin, reward vector on stdout) and
tests the Optuna side against a *fake* engine executable. Task 32 then runs a real study — which
requires the *real* engine binary implementing that interchange, and no task creates it. Task 23's
matrix executor runs in-process through the domain runner, not as a CLI.

**Suggestion:** add a task between 29 and 31 that wires the existing pieces into the real engine
entry point: read a run spec, execute, evaluate, emit the reward vector or structured failure.
This same binary doubles as the minimal human-facing CLI (v1's `shelley.ts` role), which the plan
otherwise defers entirely under "Web/TUI interface."

#### 2. "Maximum estimated cost" has no pricing source

Task 19 adds a max-estimated-cost guardrail and Task 29's reward subtracts weighted cost, but the
system only records token usage. Converting usage to money needs a per-model price table, which
must itself be versioned (prices change; local Gemma runs are free). No task provides one.

**Suggestion:** either define budgets and reward-cost terms in tokens (objective, self-contained)
and treat dollars as derived reporting, or add a small versioned price-table fixture recorded in
the run artifacts so cost claims are reproducible.

#### 3. Task 28 (evaluator reliability) is a live, paid study but is not marked opt-in

Repeated and permuted evaluations only measure variance, ordering bias, and self-preference
meaningfully against a *real* judge model — scripted judges have zero variance by construction.
Every other live activity in the plan (Tasks 04, 10, 18, 24, 32) is explicitly opt-in and outside
the unit suite; Task 28 is not labeled, has no budget bound, and does not say where the
reliability report lives.

**Suggestion:** mark Task 28 opt-in, bound it with the Task 19 study guardrails, and version the
reliability report as a canonical artifact — it later justifies enabling optimization, so it needs
provenance.

### Smaller points

- **Task 10's live smoke never exercises persistence.** It ends at "a complete in-memory result,"
  and the next live full run is Task 32 — so "the live path emits well-formed canonical events"
  goes unverified for the whole of Milestones C–E. After Tasks 11–13 land, extend the Task 10
  smoke to write and validate a JSONL run record.
- **Renumbering churn.** Inserting tasks shifted every number from 10 onward, silently staling
  cross-references (including round 1 of this review). Consider stable task IDs (slugs or gapped
  numbering) so future insertions don't invalidate ADRs, commits, and reviews that cite tasks.
- **Retries inside Pi can distort cost accounting.** ADR-0001 assigns retries to Pi; a retried
  turn consumes real tokens the canonical usage may not show. Require attempt counts and
  per-attempt usage in the adapter trace (fits Task 03 or Task 11) so budgets bind actual spend.
- **Task 32's "preregistered" needs a home.** Preregistration only means something if the study
  spec is committed before execution. Define a versioned study-spec file that run IDs reference,
  so the report in Task 33 can prove the hypotheses preceded the data.
- **Controls 5–7 (risk tolerance, deference, verbosity) have no consumer.** No benchmark case or
  rubric dimension exercises them, and each dial multiplies the Task 22 matrix. The deferred-list
  bar ("enters when evidence justifies") could apply to individual controls too; 1–4 and 8 all
  have concrete consumers already.

## Round 1 — 2026-07-18, initial plan (all resolved)

1. **No experiment runner between matrix generation and the real study** → resolved by Task 23
   (resumable matrix executor with artifact mapping, concurrency, budgets, resume, dedup).
2. **First live end-to-end debate ~28 tasks in** → resolved by Task 10 (opt-in live two-round
   debate at the end of Milestone B).
3. **Replay defined before tools exist** → resolved in Task 17 (replay reconstructs tool-using
   runs and detects tool-trace drift).
4. **Toolchain unspecified; CI referenced but never created** → resolved in Task 00 (Bun 1.2+,
   strict TypeScript, `bun test`, ESLint, GitHub Actions running the same three commands).
5. Nits: Optuna interchange format → versioned JSON-over-stdio schema in Task 31; secrets
   redaction → general invariant in Task 11; cost guardrails → Task 19; the ritual red step in
   Task 00 → replaced with a meaningful smoke assertion.

Round 1 also explicitly endorsed keeping the creativity dial (Task 09) separate from provider
sampling controls (Task 20), fixing v1's coupling of dial and temperature in `dials.py`.
