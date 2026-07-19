# Review of the implementation plan

Reviews [`plans/implementation-plan.md`](implementation-plan.md), read alongside
[`docs/ADR-0001-agent-boundary.md`](../docs/ADR-0001-agent-boundary.md), `AGENTS.md`, `README.md`,
and the v1 repository (`../heated-debate/`). Task IDs are the plan's stable slugs.

## Round 4 — 2026-07-19, after third revision

All round-3 findings were addressed (log at bottom). **Verdict: the plan is ready to execute from
A-HARNESS.** The remaining comments are polish; none blocks starting.

- **`reasoningTokens` has no pricing rule.** The frozen usage shape includes `reasoningTokens`,
  but D-PRICING lists only input/output/cache rates. Providers differ: some bill reasoning as
  output tokens, some separately, some not at all. Without a rule, the same usage record can
  price two ways. Add to the snapshot either a reasoning rate or an explicit
  included-in-output/unbilled marker per model, so cost stays deterministic.
- **F-ENGINE-CLI now strains working rule 7.** It defines and versions the interchange schema,
  builds the executable, owns git stamping, and carries seven contract-test dimensions — that is
  several commits, not one. The plan's own rule says split it: a small F-SCHEMA task (schema +
  version tests) followed by F-ENGINE-CLI (executable implementing it) is the natural cut.
- **C-FAILURES tests cost-budget exhaustion before cost exists.** Monetary cost arrives with
  D-PRICING, a milestone later. Either scope C-FAILURES to token/turn budgets and add the
  monetary row when D-PRICING lands, or note that its "cost" rows use a stub price so the test
  intent is clear at execution time.

### Verified as genuinely resolved, not papered over

- The fails-closed rule in D-PRICING (missing priced token kind → cost `unknown`, monetary
  enforcement blocks unless the study spec permits token-only accounting) is exactly the right
  default for a lab that makes cost claims.
- The deterministic `accepted`/`rejected` derivation in E-RELIABILITY removes the
  "accepted by vibe" problem entirely; the gate is now mechanical.
- Moving schema definition ahead of the F-OPTUNA fake fixes the round-3 ordering contradiction
  cleanly — the fake now has a schema to conform to.

### Where the next feedback comes from

Nothing further at the plan level once the three polish items are folded in. The next real
feedback loop is execution: run A-HARNESS, then let A-PI-SPIKE's measured findings test ADR-0001
against reality — that spike is the first point where the plan's assumptions about Pi (control
availability, attempt observability, conversation retention) meet evidence.

## Round 3 — 2026-07-18, second revision (all resolved)

1. **Interchange schema implemented before defined** (F-ENGINE-CLI vs F-OPTUNA ordering) →
   schema definition moved into F-ENGINE-CLI; F-OPTUNA now consumes it.
2. **Usage granularity unspecified** → token kinds named and frozen in A-AGENT-PORT, C-EVENTS,
   and ADR-0001, with absent-not-zero semantics; D-PRICING fails closed on missing kinds.
3. **No acceptance mechanism for the reliability artifact** → deterministic `accepted`/`rejected`
   status derived from preregistered thresholds in D-STUDY-SPEC.
4. Smaller: evaluator refs in the study spec declared opaque until resolution; per-run budget
   halting assigned to the domain loop in C-FAILURES; git introspection confined to the
   CLI/executor layer; milestone letters declared historical in rule 9; live-smoke overlap
   resolved — C-LIVE-ARTIFACT reuses and supersedes the B-LIVE-DEBATE harness.

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
