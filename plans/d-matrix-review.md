# D-MATRIX review

Status: pass

Reviewed on 2026-07-23.

`generateExperimentMatrix` produces the deterministic cases x parameter configurations x
repetitions matrix from a validated study spec and case definitions. Ordering is stable (spec
case order, declared variant order, ascending repetition), every run ID embeds the study-spec
hash via `studyRunId` with a sorted canonical variant key, duplicate run IDs are impossible by
construction and guarded, holdout runs are flagged, per-run parameters overlay the spec's fixed
values with the variant assignment, and missing or duplicate case definitions are rejected.

Validation completed successfully:

- Tests: 252 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.

D-MATRIX is complete. D-EXECUTOR is next.
