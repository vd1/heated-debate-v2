# C-TOOL-LOOP concerns for Fable

Status: concerns 2 and 4-9 resolved; concerns 1 and 3 open, pending an architecture decision

Updated on 2026-07-22 (Fable pass after the initial codex review).

Resolution summary:

- Concern 2: a synchronous executor throw is now normalized into a charged `tool_error` record.
- Concern 4: `AgentFailure` and `DebateRunFailure` carry completed tool call records, and the
  runner emits `turn.tool_call` events before `turn.failed`. The hard-interrupt path where an
  agent ignores cancellation still cannot recover records the adapter never returned.
- Concern 5: canonical replay now re-drives each recorded tool loop, re-authorizing every call
  against the recorded policy, rejecting missing, extra, or drifted calls, and comparing the
  recorded final response.
- Concern 6: the canonical serializer redacts configured secrets from failed `turn.tool_call`
  outcomes, and `PiAgent` threads a secrets list into its per-turn dispatcher.
- Concern 7: the dispatcher trace is invocation-ordered even when concurrent executions complete
  out of order.
- Concern 8: canonical validation rejects byte accounting that disagrees with the UTF-8 length
  of the recorded output.
- Concern 9: executor error codes are typed, and Pi tool results containing non-text content are
  rejected explicitly as `unsupported_result_content`.

Concerns 1 and 3 remain open below; both need a joint decision because the fixes change the
adapter architecture (owning the tool loop above Pi core, or a unified interleaved trace
vocabulary).

This is a live review file for issues found while C-TOOL-LOOP is being implemented. The task
contract in `plans/implementation-plan.md` remains the acceptance baseline. In particular, the
project dispatcher must own policy enforcement and trace emission, malformed and undeclared calls
must be covered, replay must inject recorded results at their exact positions and compare the whole
trace, and Pi's transcript must not be the only result copy.

## Open concerns

### 1. Pi bypasses the dispatcher for unknown names and schema-invalid arguments

Severity: high

`PiAgent` exposes only policy-allowed wrappers, and each wrapper retains the original Pi parameter
schema. Pi core performs tool lookup and argument validation before wrapper execution. An unknown
tool name or ordinary JSON with missing or wrongly typed fields therefore produces Pi's immediate
error without calling `dispatcher.dispatch`. Such a call is absent from project policy accounting
and `reply.toolCalls`.

The domain `ToolExecutor` also has no schema or validation hook. Its malformed-argument test covers
functions and circular objects, not schema-invalid JSON such as a missing required field or a string
where a number is required.

Evidence:

- `src/domain/tool-loop.ts`: `ToolExecutor` and the JSON-representability check.
- `src/infrastructure/pi-agent.ts`: `buildTurnTools` retains `tool.parameters` and wraps only allowed
  registrations.
- `node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js`: `prepareToolCall` performs lookup
  and `validateToolArguments` before `tool.execute`.
- `plans/c-tool-loop-review.md` lists these paths as a limitation, but the implementation plan does
  not exclude them from C-TOOL-LOOP.

Acceptance check: Pi tests for an unknown tool and schema-invalid JSON both produce canonical
project records, do not execute the underlying tool, and use the same dispatcher error vocabulary
as the scripted driver.

### 2. A synchronous executor throw escapes without a record

Severity: high

`executor.execute(...)` is evaluated before the dispatcher's `try` block. The current thrown-error
test uses `Promise.reject`, so it does not exercise a real synchronous `throw`. A synchronous throw
rejects `dispatch()` without a normalized outcome or trace record.

Evidence: `src/domain/tool-loop.ts`, the `const execution = executor.execute(...)` statement before
the `try` block.

Acceptance check: an executor implemented as `execute: () => { throw new Error("boom"); }` returns a
charged `tool_error` record and does not escape the normalized boundary.

### 3. Adapter attempts and tool calls are stored in separate buckets

Severity: high

`AgentTrace` contains adapter attempts while `AgentReply.toolCalls` contains tool records. Both
`projectDebateEvents` and live recording emit every adapter attempt first, then every tool call. A
real tool exchange is usually model attempt, tool result, next model attempt, and final response.
The current representation cannot reconstruct that interleaving, so it cannot compare the whole
trace or prove an exact tool-result message position.

Evidence:

- `src/domain/agent.ts`: separate `trace.attempts` and `toolCalls` fields.
- `src/domain/debate-events.ts`: the attempts loop precedes the tool-calls loop.
- `src/domain/debate.ts`: `emitAttempts` precedes `emitToolCalls` after the entire reply completes.

Acceptance check: use one ordered project-owned trace vocabulary and test a tool call followed by a
second model attempt. Canonical events must retain the actual attempt, call/result, attempt order.

### 4. Failed turns lose completed tool calls

Severity: high

Tool calls exist only on successful `AgentReply`. `AgentFailure` carries adapter attempts but no tool
records. If a tool completes and a later model step fails or is cancelled, the completed call is
lost from the canonical failure prefix. The current C-TOOL-LOOP review acknowledges this as a
limitation even though the task requires Pi's internal transcript not to be the only result copy.

Evidence: `src/domain/agent.ts`, `AgentFailure` versus `AgentReply`.

Acceptance check: a scripted Pi turn completes a tool call and then fails on the following model
step. The failure artifact still contains the completed tool call at its original trace position.

### 5. Replay does not yet compare the whole trace

Severity: high

`replayToolLoop` replays recorded tool results and compares call requests and policy dispositions,
which is useful. It does not accept or compare the recorded final response. Separately,
`replayCanonicalRun` collects tool records and attaches them to a replay reply, but it does not run a
tool-loop driver or invoke `replayToolLoop`. A canonical run can therefore pass replay without
reproducing its tool loop or final assistant step.

Evidence: `src/domain/replay.ts`, `ReplayToolLoopInput`, `replayToolLoop`, and
`replayCanonicalRunSync`.

Acceptance check: canonical replay drives the tool loop, injects each recorded result, rejects tool
request drift, rejects missing or extra calls, and rejects final-response drift.

### 6. Configured secrets can leak through tool-call failures

Severity: high

The Pi dispatcher is constructed without a secrets list. More importantly, the canonical serializer
redacts configured secrets only for `turn.failed` and `run.failed`. A failed `turn.tool_call` outcome
can therefore persist an underlying tool exception verbatim even when the JSONL writer has the
secret configured.

Evidence:

- `src/infrastructure/pi-agent.ts`: `createToolDispatcher` receives no `secrets` option.
- `src/domain/events.ts`: `redactFailureSecrets` ignores `turn.tool_call` outcomes.

Acceptance check: serialize and persist a failed tool event whose message contains a configured
secret, then verify that only `[REDACTED]` reaches JSONL and replay input.

### 7. Stable IDs are reserved at dispatch start, but trace order is still completion order

Severity: medium

The in-progress fix reserves `callId` and `ordinal` when dispatch begins. `finishRecord` still uses
`records.push`, so concurrent executions appear in `trace()` by completion order. Pi wrappers are
currently forced to sequential execution, but the exported dispatcher contract should still keep
its promised stable invocation order.

Acceptance check: start two deferred calls, complete call 2 first, and assert that `trace()` returns
ordinals 1 then 2 with their matching IDs and outcomes.

### 8. Canonical validation does not verify output bytes against the output string

Severity: medium

For an untruncated success, canonical validation accepts any non-negative `outputBytes`. For a
truncated success, it checks `outputBytes === retainedBytes` but does not check either value against
the UTF-8 byte length of `output`. A tampered event can therefore be structurally accepted with
false byte accounting.

Evidence: `src/domain/events.ts`, `validateToolCallOutcome`.

Acceptance check: canonical parsing rejects byte counts that disagree with the actual UTF-8 output
for both truncated and untruncated results.

### 9. Pi silently drops non-text tool result content

Severity: medium

The Pi executor adapter filters the original result to text blocks, concatenates them, discards all
other content and `details`, then reports success. An image-only result becomes a successful empty
string, while mixed content is only partially preserved. This changes tool semantics without an
explicit error.

Evidence: `src/infrastructure/pi-agent.ts`, the executor created by `buildTurnTools`.

Acceptance check: either normalize all supported result blocks into the project vocabulary or
reject unsupported non-text content explicitly. Add mixed-content and image-only tests.

## Completion status

`README.md` and `plans/c-tool-loop-review.md` should not declare C-TOOL-LOOP complete while the high
severity items above remain open. The two limitations documented in the pass review directly overlap
the task's stated acceptance contract.
