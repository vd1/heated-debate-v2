# C-TOOL-LOOP concerns for Fable

Status: concerns 1, 2, 4, 6-9, and 11 are resolved. Concerns 3, 5, and 10 remain open. Concern 12
was added after reviewing the latest follow-up implementation.

Updated on 2026-07-23 after reviewing through commit `87fd863`.

Validation at `5dbc03f`:

- `bun test`: 164 passed, 2 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not close the remaining trace and accounting gaps below. The task contract in
`plans/implementation-plan.md` remains the acceptance baseline.

## Open concerns

### 3. Shared sequence numbers are recorded but not enforced or projected as event order

Severity: high

The adapter now stamps observed responses and tool calls with a shared `turnSequence`. This is
useful evidence, but the rest of the system still stores and emits the two record types in separate
buckets:

- `AgentTrace` contains attempts while `AgentReply.toolCalls` contains calls.
- `projectDebateEvents` emits all attempts first and all tool calls second.
- `runDebate` also calls `emitAttempts` before `emitToolCalls`.
- `validateCanonicalSequence` validates only the outer event sequence. It does not require shared
  turn positions to be unique, consecutive, complete, or consistent with event order.
- Canonical replay ignores `turnSequence` on both attempts and calls.

For a real model response, tool result, model response exchange, the JSONL event order is still
attempt, attempt, tool call. The payload annotations can suggest attempt, tool call, attempt, but
canonical validation accepts duplicates, gaps, inversions, and mixed annotated and unannotated v5
records. The current projection test still expects the bucketed order and does not exercise an
annotated attempt, call, attempt trace.

Acceptance check: either adopt one ordered project trace or merge the two buckets by
`turnSequence` when projecting and recording. For newly recorded v5 turns, validate a unique,
consecutive shared sequence and reject contradictions. Add live and post-hoc tests whose canonical
event order is attempt, tool call, attempt, followed by replay validation of the same order.

### 5. Canonical replay compares recorded data with a driver built from the same data

Severity: high

The standalone `replayToolLoop` improvement is valid: a caller-supplied driver can now be checked
for request, count, disposition, and final-text drift. `replayCanonicalRun` does not supply an
independent driver, however. `replayRecordedToolLoop` constructs every driver step from
`recorded.toolCalls`, appends `recorded.reply.text`, and then compares the result with those same
records and that same text.

This re-authorizes recorded dispositions, but request and final-response comparisons are
self-comparisons. A changed canonical request or final response changes both the generated driver
side and the expected side. The function therefore does not re-drive the recorded tool loop or
compare its whole trace against an independent scripted model execution.

Acceptance check: canonical replay must receive a scripted `ToolLoopDriver`, or an equivalent
independent per-turn model script. Feed recorded results into that driver at their recorded
positions, then reject request drift, missing or extra calls, result-position drift, and final-text
drift. Tests should mutate each recorded element while leaving the independent script unchanged.

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

## Resolved concerns

### 1. Pi bypassed the dispatcher for unknown names and schema-invalid arguments

Resolved by `aff61a9`. `PiAgent` now owns the model/tool loop, dispatches unknown names as policy
denials, and converts non-coercible schema failures to `malformed_arguments` without executing the
tool. The new tests cover both paths. Concern 11 describes a separate guard path that can still
skip recording a returned call.

### 2. A synchronous executor throw escaped without a record

Resolved by `94efdc7`. Executor invocation is normalized through the dispatcher's guarded async
boundary, and a synchronous-throw regression test produces a charged `tool_error` record.

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
3, 5, 10, and 12 remain open. The review file also retains stale descriptions of Pi wrappers,
canonical schema v4, and limitations that the newer commits changed.
