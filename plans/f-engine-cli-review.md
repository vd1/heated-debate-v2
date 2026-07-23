# F-ENGINE-CLI review

Status: pass

Reviewed on 2026-07-23.

`src/cli/engine.ts` is the production executable implementing F-SCHEMA and the minimal
human-facing CLI. It reads one engine input from stdin, validates the study spec and run
identity (recomputing the expected run ID from the case content hash and parameter point),
executes the debate through the shared run configuration with scripted agents, records the
canonical artifact at the deterministic path via temporary-file publication, runs the
deterministic evaluators, and emits exactly one framed reward or structured failure line on
stdout with all diagnostics on stderr.

Contract-tested exit codes: 0 for a reward, 1 for structured execution failures including
budget exhaustion, 2 for malformed input, unknown arguments, and run-identity mismatches, and
130 for SIGTERM/SIGINT interruption, which cancels the run through the domain's hard
cancellation path, discards the temporary artifact, and still frames a single failure line.
Git cleanliness and study-spec commit stamping produce a preregistration attestation recorded
on stderr and optionally to a file; a dirty worktree fails closed unless development mode is
explicit. Pi-backed agents arrive with F-STUDY; a richer TUI remains deferred.

Validation completed successfully with real exit codes.

F-OPTUNA is next.
