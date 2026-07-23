# Implementation concerns for Fable

Status: concerns 1-13, 16-18, and 20 are resolved. Concerns 14, 15, and 19 are
partially resolved. Concerns 21 and 22 are open.

Updated on 2026-07-23 after reviewing through commit `3829d42`.

Validation at `3829d42`:

- `bun test`: 215 passed, 3 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not cover the remaining boundary cases below. The task contract in
`plans/implementation-plan.md` remains the acceptance baseline.

## Open concerns

### 14. Endpoint credentials can still reach web-search failure records

Severity: high

Status: partially resolved by `193469a`.

The configured `apiKey` is now redacted from transport and decoding errors, and successful
provenance records only the endpoint origin and path. Those changes close the originally
reproduced Authorization-secret path and the successful-provenance path.

The error boundary still preserves credentials carried in the configured endpoint. Its redactor
only removes `options.apiKey`. If a transport includes the requested URL in its error, userinfo
and credential-bearing query parameters are returned unchanged. This direct reproduction:

```text
endpoint: https://user:password@example.test/search?api_key=query-secret
transport error: transport failed for <requested URL>
```

produces:

```text
transport failed for https://user:password@example.test/search?api_key=query-secret&q=x&format=json
```

That message can still become a failed `turn.tool_call` outcome. The new tests exercise an API-key
error and endpoint sanitization separately, so they do not cover this combined path or a canonical
artifact.

Acceptance check: normalize transport and decoding errors without returning the raw request URL,
or redact userinfo and sensitive query values derived from the configured endpoint as well as the
header key. Add a canonical JSONL sentinel test whose credential-bearing endpoint is repeated by a
throwing transport, and verify the serialized tool failure contains none of its credentials.

### 15. Whitespace-only web queries pass the Pi schema before failing in the port

Severity: medium

Status: partially resolved by `193469a`.

The exported port now rejects empty or whitespace-only queries and every invalid result-limit
class. The numeric constraints are shared with the Pi tool schema.

The query constraint is not shared. The Pi schema still uses only `Type.String({ minLength: 1 })`,
which accepts a string containing spaces. Such a call passes schema authorization, consumes an
accepted tool execution, reaches the port, and becomes a tool error. The same semantic input is
supposed to be rejected at the schema boundary as malformed arguments.

Acceptance check: express the non-whitespace query rule in the Pi schema as well as the direct
port validator. Add a dispatcher-level whitespace-query test that proves the executor is not
entered and the result is classified consistently with other malformed arguments.

### 19. Reasoning subset validation still permits reasoning without an output total

Severity: medium

Status: partially resolved by `6aedaae`.

The explicit `reasoningTokens > outputTokens` case is now rejected under both
`included-in-output` and `unbilled`.

The check runs only when both counts are present. A record containing `reasoningTokens: 20` with
no `outputTokens` cannot establish that reasoning is a subset of output. Under
`included-in-output` with a zero output rate, `calculateUsageCost` nevertheless returns a known
zero cost. The same gap exists for `unbilled` when the applicable rate does not otherwise make the
missing output count affect price.

Acceptance check: when the billing rule defines reasoning as an output subset, require an output
count whenever a reasoning count is present, or define and test a different explicit semantic for
that evidence combination. Do not report the subset invariant as validated when the containing
total is absent.

### 21. Token counts are accepted as fractional numbers but exact pricing requires integers

Severity: medium

`normalizeUsage` and canonical usage validation accept any finite non-negative number. They do not
require token counts to be safe integers. The exact pricing implementation converts each present
count with `BigInt(tokens)`.

A direct reproduction normalizes `inputTokens: 1.5` successfully and then
`calculateUsageCost` throws `RangeError: Not an integer`. In `runDebate`, that exception becomes
`cost_unknown`; with token-only accounting permitted, the fractional count can continue into
budget accounting and canonical evidence. Unsafe integer values are also accepted even though
their exact token count is no longer represented reliably by a JavaScript number.

Acceptance check: validate every token count as a non-negative safe integer at normalization and
canonical parsing boundaries, and keep a defensive check in direct pricing. Add fractional,
unsafe-integer, and valid-boundary tests so exact monetary arithmetic never depends on an
uncaught `BigInt` conversion error.

### 22. Producer-side sequence rejection leaves a started artifact without a terminal event

Severity: high

Commit `3829d42` prevents mixed, duplicate, or gapped turn evidence from being written. That
resolves the original concern that a producer could persist evidence its reader later rejects.

In live recording, validation occurs after `run.started` and `turn.requested` have already been
appended and flushed. It is also outside the dispatch failure handler. If an `AgentPort` returns
duplicate turn positions, `orderedTurnEvidence` throws, the outer catch only disposes the agents,
and the raw error escapes without `turn.failed` or `run.failed`.

The reproduced artifact event types are:

```text
run.started
turn.requested
```

This contradicts the C-FAILURES invariant that every started run emits exactly one terminal
outcome. The new producer tests omit a recording sink, so they do not observe the incomplete
artifact.

Acceptance check: normalize evidence-validation failures through the run failure path without
writing the invalid evidence. Add a recording test for duplicate and mixed positions that asserts
one `turn.failed`, one `run.failed`, no invalid attempt or tool-call event, and successful artifact
parsing after closure.

## Resolved concerns

### 1-4, 6-9, and 11

The previously recorded dispatcher, trace preservation, secret-redaction, ordering, byte-count,
non-text-result, and loop-guard concerns remain resolved by commits `94efdc7`, `aff61a9`,
`5fc2d80`, and `87fd863`.

### 5. Replay now states and can require its achieved guarantee

Resolved by `3829d42`. `ReplayResult.toolReplayGuarantee` distinguishes no tool calls,
independent replay, and authorization-only replay. `requireIndependentToolReplay` fails closed
when a recorded tool turn lacks an independent driver.

### 10. No-hook model steps reserve their sequence before tool dispatch

Resolved by `3829d42`. The fallback attempt position is allocated when the model step completes.
The regression proves attempt 1, tool call 2, attempt 3 for a tool loop without response hooks.

### 12. Known local loop failures no longer invent provider attempts

Resolved by `3829d42`. The no-policy and loop-guard paths use `protocol_failure`, retain the model
steps that occurred, and do not append a synthetic adapter attempt.

### 13. Invalid shared positions are rejected by producers

Resolved by `3829d42` for the original artifact-validity issue. `orderedTurnEvidence` rejects
mixed or non-consecutive annotations before an invalid evidence event is emitted or returned.
Concern 22 covers terminal closure after that rejection.

### 16. Monetary enforcement uses a resolved snapshot and limit

Resolved by `6aedaae`. The runner validates and clones the pricing snapshot and scales the maximum
amount before its first asynchronous boundary. Later caller mutation does not change recorded
controls or enforcement.

### 17. Successful attempts use the returned model identity

Resolved by `6aedaae`. Successful evidence is priced using `reply.model`, a returned identity
missing from the snapshot fails closed, and the differing-rate regression verifies the choice.

### 18. Monetary accumulation uses exact scaled integers

Resolved by `6aedaae`. Rates and limits have a bounded decimal scale, costs accumulate as integer
units of `1e-12` currency, and exact `0.1 + 0.2 = 0.3` exhaustion completes.

### 20. Effective dates require real calendar dates

Resolved by `6aedaae`. Validation now rejects invalid months and days and covers leap-year
behavior.

## Completion status

Milestone C should not be declared complete while concerns 14, 15, and 22 remain.
D-PRICING should not be declared complete while concerns 19 and 21 remain.
The `3829d42` review-file claim that all twenty concerns are resolved is therefore premature.
