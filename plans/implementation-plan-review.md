# Review of the implementation plan

Reviews [`plans/implementation-plan.md`](implementation-plan.md), read alongside
[`docs/ADR-0001-agent-boundary.md`](../docs/ADR-0001-agent-boundary.md), `AGENTS.md`, `README.md`,
and the v1 repository (`../heated-debate/`). Task IDs are the plan's stable slugs.

## Round 3 — 2026-07-18, after second revision

All round-2 findings were addressed (log at bottom). The plan is converging: nothing structural
remains. Round 3 is consistency-level.

### Inconsistencies worth fixing

#### 1. The interchange schema is implemented before it is defined

F-ENGINE-CLI builds the real executable that reads a run spec on stdin and emits a reward vector
on stdout — but the task that "defines and versions" that JSON-over-stdio schema is F-OPTUNA, one
task *later*. As written, the CLI implements a contract that does not exist yet.

**Suggestion:** move schema definition into F-ENGINE-CLI (or a small preceding task); F-OPTUNA
then only *consumes* the schema and tests the bridge against it.

#### 2. Usage granularity is never specified, but pricing depends on it

D-PRICING carries input/output/cache rates, so the usage-to-cost calculation needs a per-attempt
token breakdown by kind (input, output, cache read/write). Yet "usage" in A-AGENT-PORT and
C-EVENTS is left as an opaque word. If the normalized usage shape lacks the breakdown, D-PRICING's
math has no inputs and the whole cost chain silently degrades to guesswork.

**Suggestion:** name the usage fields in A-AGENT-PORT's `AgentReply` and freeze them in the
C-EVENTS schema, with unavailable kinds explicitly marked absent rather than zero.

#### 3. "Accepted reliability artifact" has no acceptance mechanism

E-RELIABILITY says optimization cannot be enabled without an *accepted* reliability artifact, but
never defines who accepts it or against what. Without criteria, "accepted" is a vibe, and the gate
it guards is unenforceable.

**Suggestion:** give the artifact a status field (like an ADR) plus preregistered acceptance
thresholds — maximum judge variance, maximum ordering-bias effect — declared in the study spec
before the reliability runs execute.

### Smaller points

- **D-STUDY-SPEC forward-references Milestone E.** The spec includes evaluator versions and rubric
  IDs before any evaluator exists. Fine if the spec treats them as opaque versioned references
  validated later (E-RELIABILITY, F-STUDY) — worth one sentence saying so, so D-STUDY-SPEC's
  tests don't try to validate what can't exist yet.
- **Per-run budget enforcement has no stated owner.** D-CONFIG defines retry-inclusive budgets and
  D-EXECUTOR enforces the *study* budget, but nothing says which component halts a single
  in-flight run when its token budget trips mid-debate. That check belongs in the domain loop and
  is naturally table-tested alongside C-FAILURES ("budget exhausted" as one more failure row).
- **Keep git introspection out of the domain.** D-STUDY-SPEC's committed/clean-worktree check and
  F-STUDY's commit-hash stamping require git; that belongs in the CLI/executor layer, mirroring
  the existing "no `process.exit` in domain code" rule.
- **Milestone letters in slugs are historical, not locational.** F-ENGINE-CLI would not become
  "D-" if it ever moved earlier. Extending rule 9 with "letters record where a task was born and
  are never corrected" preempts a future renaming debate.
- **Two live debate smokes now overlap.** C-LIVE-ARTIFACT re-runs the B-LIVE-DEBATE scenario
  through the writer. Once C-LIVE-ARTIFACT exists, consider retiring B-LIVE-DEBATE's separate
  path so only one live-debate harness needs maintaining.

## Round 2 — 2026-07-18, first revision (all resolved)

1. **No real engine executable** (Optuna bridge tested only against a fake) → F-ENGINE-CLI.
2. **"Maximum estimated cost" had no pricing source** → D-PRICING (versioned snapshot, zero-cost
   local entry, snapshot hash recorded in artifacts).
3. **Evaluator reliability was live/paid but not opt-in** → E-RELIABILITY (skipped by default,
   guardrails enforced, versioned reliability artifact).
4. Smaller: live smoke never exercised persistence → C-LIVE-ARTIFACT; renumbering churn → stable
   slugs and working rule 9; Pi retries vs budgets → per-attempt accounting in ADR-0001 and
   A-PI-ADAPTER; "preregistered" needed a home → D-STUDY-SPEC; unconsumed dials (risk tolerance,
   deference, verbosity) → moved to the deferred list.

## Round 1 — 2026-07-18, initial plan (all resolved)

1. **No experiment runner between matrix generation and the real study** → D-EXECUTOR.
2. **First live debate ~28 tasks in** → B-LIVE-DEBATE at the end of Milestone B.
3. **Replay defined before tools existed** → C-TOOL-LOOP extends replay to tool-using runs.
4. **Toolchain unspecified; CI referenced but never created** → Task A-HARNESS (Bun 1.2+, strict
   TypeScript, `bun test`, ESLint, GitHub Actions).
5. Nits: Optuna interchange → versioned schema; secrets redaction → C-EVENTS invariant; cost
   guardrails → D-CONFIG; ritual red step → meaningful smoke assertion.

Round 1 also endorsed keeping the creativity dial (B-DIAL) separate from provider sampling
controls (D-CONTROLS), fixing v1's coupling of dial and temperature in `dials.py`.
