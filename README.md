# heated-debate-v2

A greenfield, test-driven rewrite of the Heated Debate engine.

The engine owns debate protocols, explicit experiment configuration, evaluation, and
reproducible logs. Pi supplies model access and conversation mechanics behind a narrow adapter.

## Status

Implementation is proceeding one independently testable task at a time; see
[`plans/implementation-plan.md`](plans/implementation-plan.md). Milestones A and B plus C-EVENTS,
C-JSONL, C-REPLAY, C-LIVE-ARTIFACT, C-MARKDOWN, C-FAILURES, and C-TOOL-POLICY are complete.
Milestone C is
complete; D-PRICING, D-CONFIG, and D-CONTROLS landed pricing, the validated
`ExperimentConfig`, and the control propagation audit; see the
[`D-CONTROLS review`](plans/d-controls-review.md). Milestone D is complete; Milestone E is complete; All Milestone F machinery has landed; a live bounded study remains an opt-in execution. The review hardening pass resolved the open critical findings: full spec/case identities travel in run-start evidence (schema v8), artifacts are validated before publication with terminal failures persisted and priced, rewards resolve the preregistered scalarizer, the judge validates and permutes presentation without touching chronology, reliability statistics fail closed on missing populations, and a real filesystem store with leases backs the executor.

The generated-artifact style gate applies to artifacts created or modified for a release,
matching the tool's staged-file behavior. Two historical documents are grandfathered as repo-wide
exceptions and are deliberately left unrestyled: `plans/implementation-plan.md` (the acceptance
baseline) and `plans/implementation-plan-review.md` (the review record). Any repository-wide
cleanup is a separate post-release mechanical commit.

The original implementation remains in the sibling repository `../heated-debate/` and is treated
as reference behavior, not as code to copy wholesale.
