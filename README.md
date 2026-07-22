# heated-debate-v2

A greenfield, test-driven rewrite of the Heated Debate engine.

The engine owns debate protocols, explicit experiment configuration, evaluation, and
reproducible logs. Pi supplies model access and conversation mechanics behind a narrow adapter.

## Status

Implementation is proceeding one independently testable task at a time; see
[`plans/implementation-plan.md`](plans/implementation-plan.md). Milestones A and B plus C-EVENTS,
C-JSONL, C-REPLAY, C-LIVE-ARTIFACT, C-MARKDOWN, and C-FAILURES are complete after the
[`C-FAILURES final review`](plans/c-failures-final-review.md). C-TOOL-POLICY is next.

The original implementation remains in the sibling repository `../heated-debate/` and is treated
as reference behavior, not as code to copy wholesale.
