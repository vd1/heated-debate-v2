# D-STUDY-SPEC review

Status: pass

Reviewed on 2026-07-23.

`parseStudySpec` parses untrusted JSON into a validated, frozen `spec@1`: hypotheses, unique and
disjoint benchmark/holdout case IDs, fixed parameters, varied parameters restricted to
matrix-eligible control dimensions with at least two values each, repetitions, opaque versioned
evaluator and rubric references resolved only at evaluation time, an embedded validated pricing
snapshot, per-run and aggregate study budgets, stopping rules, planned analysis, and
preregistered reliability thresholds (minimum sample count, maximum judge variance, maximum
ordering-bias effect). Unknown fields and versions are rejected.

`studySpecHash` is canonical and deterministic, and `studyRunId` stamps every generated run ID
with the spec-hash prefix while rejecting case IDs outside the study and out-of-range
repetitions. `assertPreregisteredStudy` fails execution for an uncommitted spec unless the
explicit non-preregistered development flag is set; committed/clean-worktree evidence is
supplied by the executor/CLI, never derived in domain logic.

Validation completed successfully:

- Tests: 250 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.

D-STUDY-SPEC is complete. D-MATRIX is next.
