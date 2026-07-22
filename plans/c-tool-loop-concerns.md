# C-TOOL-LOOP concerns for Fable

Status: concerns 1-4, 6-9, and 11 are resolved. Concern 5 is partially resolved. Concerns 10, 12,
and 13 remain open.

Updated on 2026-07-23 after reviewing through commit `ce2c1f5`.

Validation at `5dbc03f`:

- `bun test`: 164 passed, 2 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not close the remaining trace and accounting gaps below. The task contract in
`plans/implementation-plan.md` remains the acceptance baseline.

## Open concerns

### 5. Full canonical replay is optional and silently falls back to self-comparison

Severity: high

Commit `ce2c1f5` adds the needed independent path. When `toolLoopDrivers` supplies a driver for a
turn, canonical replay feeds it recorded results and detects request and final-text tampering. The
new integration tests demonstrate that path.

The option is not required for a turn containing tool calls. If the callback is omitted or returns
`undefined`, `replayRecordedToolLoop` retains the driver built from the same recorded calls and
reply. `replayCanonicalRun` still succeeds and returns the same result type even though only policy
re-authorization occurred. A caller can therefore believe it requested deterministic replay while
silently receiving the weaker self-comparison path.

Acceptance check: make full replay fail closed when a recorded tool turn lacks an independent
driver, or expose the weaker operation under a separate API or explicit mode with a result that
states which guarantee was achieved. Keep historical request reconstruction available, but do not
report it as full tool-loop replay.

### 10. A model step without a response hook is sequenced after its tool calls

Severity: high

Commit `87fd863` fixes the original accounting defect: model steps are grouped, successful
tool-use responses remain successful, per-step usage is retained, and `AgentReply.usage` sums the
steps. The response-hook path now has the expected attempt, tool call, attempt sequence.

The no-hook path is still ordered incorrectly. A `ModelStep` with no observed response does not
reserve a `turnSequence` when its result arrives. `appendStepAttempts` allocates that sequence only
while building the trace after the whole loop. Any tool call from that step has already taken a
sequence number from the shared counter. A two-step exchange without response hooks therefore
records tool call 1, attempt 2, attempt 3 even though the first attempt occurred before the tool
call.

The current no-hook test covers a single model step without tools, so it cannot detect this
inversion.

Acceptance check: reserve the fallback attempt sequence as soon as a model step completes without
an `onResponse` observation and before dispatching any returned calls. Add a two-step no-hook test
that produces a tool call and final response, then assert attempt 1, tool call 2, attempt 3.

### 12. Local tool-loop failures invent an adapter attempt that never occurred

Severity: high

The loop guard and the no-policy check both throw after a model step has completed successfully.
The common catch path calls `buildFailureTrace`. When all completed attempts succeeded and there
is no pending provider response, that function appends a synthetic failed attempt under the
assumption that a model step failed without an observable response.

No additional model request occurred in either local failure path. The resulting trace therefore
claims an adapter attempt that did not happen and classifies the local protocol failure as
`provider_failure`. This weakens attempt accounting and makes the new shared ordering contain a
fictitious entry.

Acceptance check: distinguish failures raised during an in-flight model step from failures raised
after a completed step. The guard and no-policy tests should retain the completed successful
attempts and calls without appending another adapter attempt. Record a normalized local loop or
protocol failure code rather than a provider failure if the failure vocabulary permits it.

### 13. Producers can emit a sequence that canonical validation later rejects

Severity: medium

Commit `ce2c1f5` adds strong read-time checks for annotated evidence: duplicates, gaps, inversions,
and mixed sequenced and unsequenced entries are rejected by `validateCanonicalSequence`.

The production helper `orderedTurnEvidence` does not apply those checks. If every item is
annotated, it sorts duplicate or gapped positions and emits them. If annotations are mixed, it
falls back to bucket order and emits the mixed evidence. `projectDebateEvents` and live
`runDebate` can therefore produce and persist a schema-v5 artifact that their own sequence
validator rejects when it is later read or replayed.

Acceptance check: validate shared turn positions before projection or the first sink append. Mixed
annotations and non-consecutive annotated positions must fail before an invalid artifact is
returned or persisted. Preserve the all-unsequenced compatibility path only where its weaker
ordering guarantee is deliberate.

## Resolved concerns

### 1. Pi bypassed the dispatcher for unknown names and schema-invalid arguments

Resolved by `aff61a9`. `PiAgent` now owns the model/tool loop, dispatches unknown names as policy
denials, and converts non-coercible schema failures to `malformed_arguments` without executing the
tool. The new tests cover both paths.

### 2. A synchronous executor throw escaped without a record

Resolved by `94efdc7`. Executor invocation is normalized through the dispatcher's guarded async
boundary, and a synchronous-throw regression test produces a charged `tool_error` record.

### 3. Attempts and tool calls were projected in separate buckets

Resolved by `ce2c1f5` for correctly sequenced evidence. `orderedTurnEvidence` merges both record
types by `turnSequence` for live and post-hoc artifacts, and canonical validation enforces a unique,
consecutive sequence consistent with event order. Concern 13 covers invalid producer input before
that read-time validation runs.

### 4. Failed turns lost completed tool calls

Resolved by `5fc2d80`. `AgentFailure` and `DebateRunFailure` carry completed tool-call records, and
the runner emits those records before `turn.failed`. A hard timeout still cannot recover records
from an arbitrary adapter that ignores cancellation and never returns them.

### 6. Configured secrets could leak through persisted tool-call failures

Resolved by `94efdc7` for the acceptance boundary. Canonical serialization redacts configured
secrets from failed `turn.tool_call` outcomes, and tests verify the serialized replay input.
`PiAgent` also accepts a secrets list for dispatcher-side redaction.

### 7. Concurrent dispatcher traces used completion order

Resolved by `94efdc7`. Records reserve their ordinal at invocation and occupy that ordinal's trace
slot even when calls complete out of order.

### 8. Canonical validation trusted incorrect output byte counts

Resolved by `94efdc7`. Validation compares recorded counts with the actual UTF-8 length for both
truncated and untruncated success outcomes.

### 9. Pi silently dropped non-text tool result content

Resolved by `94efdc7`. Mixed or non-text result content produces the explicit
`unsupported_result_content` executor error instead of a successful altered result.

### 11. The loop guard discarded a returned tool call before recording it

Resolved by `87fd863`. `PiAgent` dispatches all calls from a returned model message before applying
the iteration guard, so the guard failure carries those records. A model call returned without a
recorded policy now fails explicitly instead of producing a successful reply with an empty call
trace.

## Completion status

`README.md` and `plans/c-tool-loop-review.md` should not declare C-TOOL-LOOP complete while concerns
5, 10, 12, and 13 remain open. The review file also retains stale descriptions of Pi wrappers,
canonical schema v4, and limitations that the newer commits changed.
