# C-TOOL-LOOP concerns for Fable

Status: concerns 1, 2, 4, and 6-9 are resolved. Concerns 3 and 5 remain open. Concerns 10 and 11
were added after reviewing the follow-up implementation.

Updated on 2026-07-23 after reviewing commits `94efdc7`, `5fc2d80`, `aff61a9`, and `5dbc03f`.

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

### 10. The project-owned Pi loop misclassifies model steps and loses their usage

Severity: high

`PiAgent` now invokes the stream once per model step, but it collects every `onResponse` callback
in one flat `activeResponses` array and calls `buildTrace` only after the whole tool loop. That
function treats every response except the last as failed and assigns usage only from the last
assistant message to the last response.

For a successful model response that requests a tool followed by a successful final model
response, the first HTTP 200 response is consequently recorded as a failed adapter attempt with
empty usage. The first assistant message's usage is discarded from both the trace and
`AgentReply.usage`. Since debate budgets sum attempt usage, tool-enabled turns can be
systematically undercounted. If a stream exposes no response hook, a multi-step tool turn is
collapsed into one synthetic attempt with no shared sequence even though the project invoked each
model step itself.

Acceptance check: collect response observations and the terminal assistant message per stream
invocation. Mark a successful tool-use step as succeeded, attach that step's normalized usage to
its terminal response, and preserve an observable attempt entry for each project-invoked model
step even when HTTP status is unavailable. Test a tool-use response and final response with
distinct usage, then verify trace order, statuses, per-step usage, total turn usage, and debate
budget accounting without double counting.

### 11. The loop guard can discard a returned tool call before the dispatcher records it

Severity: high

When a model keeps returning tool calls, `PiAgent` checks `iteration >= maxIterations` before it
dispatches the calls in that message. The call that reaches the guard is therefore absent from the
dispatcher trace and from `AgentFailure.toolCalls`. This is especially easy to reach with repeated
denied calls because denial may not consume the aggregate call budget.

There is a second silent path when `dispatcher` is undefined: a returned tool call causes the loop
to break and return a successful reply with no tool-call record. That can occur for an unrecorded
deny-all request even though the model emitted undeclared tool content.

Acceptance check: every tool call returned by the model must either pass through the project
dispatcher or produce an explicit normalized protocol failure with equivalent canonical evidence.
Test repeated denied calls through the loop limit and a no-dispatcher turn that unexpectedly
returns a tool call. No returned call may disappear from the success or failure artifact.

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

## Completion status

`README.md` and `plans/c-tool-loop-review.md` should not declare C-TOOL-LOOP complete while concerns
3, 5, 10, and 11 remain open. The review file also retains stale descriptions of Pi wrappers,
canonical schema v4, and limitations that the newer commits changed.
