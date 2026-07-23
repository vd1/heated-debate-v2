# E-DETERMINISTIC review

Status: pass

Reviewed on 2026-07-23.

Six pure non-LLM evaluators score a run solely from its canonical event stream, each returning a
versioned identity, a normalized [0, 1] score, the underlying raw value, and a human-readable
detail line. Every score is unit-tested from real recorded runs driven by scripted agents:

- completion: completed-turn fraction against the planned schedule, halved without a
  run.completed terminal; a failed run scores below a completed one.
- contract markers: fraction of replies containing a configured adherence marker.
- repetition: one minus the worst consecutive same-role Jaccard word overlap, so verbatim
  repeats score zero and full variation scores one.
- output shape: fraction of replies within inclusive configured character bounds.
- token usage: retry-inclusive observed attempt tokens normalized against a configured budget;
  no budget yields a zero score with the raw value preserved.
- latency: mean completed-turn duration normalized against a configured target.

`runDeterministicEvaluators` returns all six with stable identities. A foreign nested prototype
repository dropped into the worktree is excluded from linting and version control rather than
modified.

Validation completed successfully with real exit codes.

E-DETERMINISTIC is complete. E-RUBRIC is next.
