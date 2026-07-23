# F-OPTUNA, F-STUDY, and F-REPORT review

Status: pass

Reviewed on 2026-07-23.

F-OPTUNA: `runEngineTrial` crosses the process boundary defined by F-SCHEMA (stdin input, one
framed stdout line, stderr diagnostics, bounded by a timeout), tested against fake
schema-conformant engine executables covering valid rewards, structured failures, malformed
output, missing output, and multi-line framing violations. `bridge/optuna_bridge.py` consumes
the same contract from Optuna without redefining it, pruning trials on structured failures and
unavailable rewards.

F-STUDY: `runBoundedStudy` runs the preregistered selection matrix through the engine executable
one bounded trial at a time, forwarding preregistration evidence so the engine re-verifies it,
persisting the study-spec hash and commit with every trial, and rejecting uncommitted specs
without the explicit development flag. Holdout cases never enter the selection matrix. The
engine gained an opt-in Pi-backed agent mode for live studies; offline tests use scripted
agents through the real spawned executable.

F-REPORT: `buildComparisonReport` compares baseline and selected arms on quality, tokens,
latency, failure rate, and reward variance with per-metric deltas. Its conclusion never claims a
preference from benchmark topics or the selecting judge alone: without holdout evidence it
states `insufficient-holdout-evidence`, and holdout preferences require the declared minimum
difference.

Validation completed successfully with real exit codes.

Milestone F machinery is complete; a live bounded study remains an opt-in execution.
