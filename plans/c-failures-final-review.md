# C-FAILURES final review

Status: pass

Reviewed on 2026-07-22 against `5fcc6db` plus the final immutable control-snapshot correction.

The final correction returns the same frozen run-control snapshot used for enforcement. The
returned result and post-hoc canonical projection can no longer diverge through caller mutation.
The regression verifies that the control object and nested budget are frozen, mutation attempts
fail, and the projection retains the recorded timeout and budget values.

The earlier review findings remain closed:

- Canonical schema v2 has an explicit schema-v1 migration path that marks missing historical
  control evidence as unrecorded.
- Timeout and budget controls are validated and snapshotted before execution, then reused for
  enforcement, results, replay, Markdown projection, and canonical events.
- Whole-run timeouts are recorded separately from per-turn timeouts and terminate with the
  `run_timeout` failure code.
- Token budgets include input, output, cache-read, and cache-write observations without adding
  reasoning subsets again.
- Whole-run cancellation settles the runner before the JSONL writer and agents are closed.

Validation completed successfully:

- Tests: 107 passed. Live tests: 2 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.
- Git whitespace validation: passed.

C-FAILURES is complete. C-TOOL-POLICY is unblocked.
