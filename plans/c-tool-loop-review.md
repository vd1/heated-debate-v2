# C-TOOL-LOOP review

Status: pass

Reviewed on 2026-07-22 and re-reviewed on 2026-07-23. The initial pass verdict was premature:
the codex review filed nine concerns in `plans/c-tool-loop-concerns.md`. All nine are now
resolved, including the two architecture decisions: `PiAgent` owns the tool loop (ADR-0001
amendment), and canonical schema v5 records a shared per-turn attempt/tool-call sequence.

The project now owns a normalized tool call vocabulary and a deterministic dispatcher. The
dispatcher alone enforces the C-TOOL-POLICY capability policy and records an ordered trace with
stable call IDs, tool and schema identities, JSON-projected arguments, dispositions, outcomes,
byte-accounted truncation, durations, and sanitized errors. Accepted calls are charged at
authorization, so executor failure, timeout, cancellation, or a missing environment tool cannot
avoid the charge. Denied calls are recorded uncharged unless the policy selects aggregate
charging.

Behavior covered one table row at a time: success followed by final response, undeclared tools,
missing environment tools, malformed (non-JSON-representable) arguments, per-call timeout with
executor abort, thrown executor errors with secret redaction, external-signal cancellation both
before and during execution, and oversized output truncated at the policy byte limit on a UTF-8
character boundary.

Both required consumers use the dispatcher:

- A scripted model driver runs through `runToolLoop`, which feeds each record back to the driver
  at its exact position until the final response.
- `PiAgent` wraps each policy-allowed registered tool as a sequential Pi `AgentTool` whose
  execution routes through a per-turn dispatcher. The text Pi feeds back to the model is exactly
  the dispatcher-recorded (possibly truncated) output, and denials or failures surface to the
  model as sanitized tool errors. The turn reply carries the dispatcher trace, so Pi's internal
  transcript is never the only result copy.

Artifact and replay paths preserve the evidence:

- Canonical schema v4 adds `turn.tool_call` events validated for disposition/outcome
  consistency, JSON-representable arguments, and truncation coherence; v1–v3 artifacts migrate
  forward without inventing tool call evidence.
- The live runner and post-hoc projection emit tool call events between adapter attempts and
  turn completion; Markdown renders them with disposition, truncation, and duration.
- Debate replay attaches recorded tool calls to their exact turn and rejects out-of-turn or
  non-consecutive records. `replayToolLoop` feeds recorded results back to a driver positionally
  without executing tools, re-authorizes every call against the policy, and reports argument or
  disposition drift with the recorded call ID.

Documented limitations, deliberately out of scope here:

- Pi validates tool arguments against the tool schema and rejects unknown tool names before the
  wrapper executes, so those two error paths exist only in Pi's transcript. The dispatcher still
  bounds and records every execution that reaches a registered tool.
- A turn that terminates in `AgentFailure` does not yet carry partial tool call records; the
  normalized failure carries attempt traces only.

Validation completed successfully:

- Tests: 149 passed. Live tests: 2 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.

C-TOOL-LOOP is complete. C-WEB-SEARCH is next.
