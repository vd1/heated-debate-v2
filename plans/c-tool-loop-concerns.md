# Implementation concerns for Fable

Status: concerns 1-13, 16-18, 20, 22, and 24-26 are resolved. Concerns 14, 15,
19, and 21 are partially resolved. Concerns 23 and 27-30 are open.

Updated on 2026-07-23 after reviewing through commit `13ff5f1`.

Validation at `13ff5f1`:

- `bun test`: 233 passed, 3 skipped, 0 failed.
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

Status: partially resolved by `13ff5f1`.

`normalizeUsage` now requires non-negative safe integers, which closes the adapter and
`ScriptedAgent` path.

Canonical usage validation still accepts `inputTokens: 1.5` in an `adapter.attempt` event, and
direct `calculateUsageCost` with the same typed value still throws `RangeError: Not an integer`.
Canonical parsing therefore returns a value typed as normalized usage that violates the pricing
precondition, while the exported pricing function has no defensive domain error.

Acceptance check: apply the safe-integer invariant in canonical usage parsing and keep a defensive
check in direct pricing. Add fractional and unsafe-integer tests at both boundaries so exact
monetary arithmetic never depends on an uncaught `BigInt` conversion error.

### 23. Canonical config collapses omitted controls into explicit defaults

Severity: high

The D-CONFIG contract explicitly requires canonical serialization to distinguish omitted optional
controls from explicit values. `parseExperimentConfig` instead materializes defaults directly into
both role assignments and omits any source-presence information.

A minimal config and a config that explicitly supplies the default model, thinking level `high`,
and `last-exchange@1` context policy produce byte-identical canonical JSON and the same
`experimentConfigHash`. The current omission test uses explicit thinking level `low`, so it proves
that different values differ rather than that omission differs from an explicit default.

Acceptance check: preserve whether each optional source control was omitted or explicitly set,
while also exposing a resolved value for execution. Add omitted-versus-explicit-default rows for
model, thinking level, context policy, and applicable per-role overrides, and require distinct
canonical representations and hashes.

### 27. Case and config identity disappear when the config becomes a run

Severity: high

`caseId` participates in canonical config JSON and its hash, but `experimentDebateInput` drops it.
The config hash is not added to `RunDebateInput`, `run.started`, or another canonical event either.
Two configs with the same run ID and topic but different case IDs have different config hashes and
produce JSON-identical runner inputs.

The resulting canonical run cannot prove which case reference or exact `ExperimentConfig` produced
it. This is especially risky once cases can share topic text or evolve independently.

Acceptance check: carry the case reference and immutable experiment-config identity into the run
boundary and canonical `run.started` evidence. Add a pair of same-topic, different-case configs
whose runner inputs and run artifacts remain distinguishable, plus replay drift checks for case
and config identity.

### 28. Protocol and creativity schedule identity are not part of ExperimentConfig

Severity: high

The task requires protocol, round, and context settings. The config records round count and a
fixed context-policy identity, but it has no debate protocol identity/version or creativity
schedule identity/version. `DebateScheduler` selects `linear-cooling@1` directly in code, and the
accepted context policy is not passed through `experimentDebateInput`; the scheduler also selects
that implementation directly.

An identical config hash can therefore resolve to changed protocol scheduling or creativity
behavior after an implementation change. Per-turn events reveal the selected creativity after the
fact, but the input config does not pin what was requested.

Acceptance check: add explicit versioned protocol and creativity-schedule selections to the
validated config, resolve only supported identities, and route them into scheduling. Prove
canonical round trips and hashes distinguish protocol or schedule drift before a run starts.

### 29. A hard-coded creativity schedule is marked matrix-eligible

Severity: high

`MATRIX_ELIGIBLE_CONTROL_DIMENSIONS` lists `creativitySchedule`, and the D-CONTROLS review says
every listed dimension travels from validated config. `ExperimentConfig` has no creativity
schedule field. The audit's input does not request one; it only observes the
`linear-cooling@1` value selected directly by `DebateScheduler`.

This proves that the hard-coded default reaches the prompt, but not that a creativity-schedule
dimension travels from config or can be varied by D-MATRIX. Marking it eligible before concern 28
is resolved lets a later matrix advertise a parameter it cannot express or select.

Acceptance check: keep creativity ineligible until an explicit validated schedule selection is
routed through the scheduler, or add that path and audit it. The audit should begin with the
selected config value and prove the same identity, version, level, and exact instruction reach the
request, prompt, and canonical events.

### 30. The tool-control audit does not execute or enforce a tool call

Severity: high

The tool audit uses a text-only fake stream. It proves that the configured allowlist appears in
`turn.requested`, that a matching tool definition is offered to the model, and that no tool value
is invented in the provider control report. It does not return a tool call, invoke the dispatcher,
exercise a limit, or produce a canonical `turn.tool_call` event.

The test name and D-CONTROLS review therefore overstate the evidence when they say the allowlist is
enforced by the dispatcher end to end.

Acceptance check: drive a configured allowed call and a denied or over-limit call through the fake
Pi stream. Assert dispatcher disposition and accounting, executor invocation or non-invocation,
the exact canonical tool-call events, and the absence of tool verification in the provider report.
Only then mark `toolCapabilityPolicy` matrix-eligible.

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

### 22. Evidence-validation failure preserves terminal artifact closure

Resolved by `7b39d41`. Evidence ordering is validated before an evidence event is appended, and a
failure is normalized as `protocol_failure`. The reproduced artifact contains `run.started`,
`turn.requested`, `turn.failed`, and `run.failed`, contains no invalid attempt event, and passes
canonical serialization and sequence validation.

### 24-26. Config numeric and nested pricing validation are aligned

Resolved by `13ff5f1`. Round, turn, output-token, and token-budget counts require safe integers.
The config parser uses the pricing amount-scale validator before accepting a monetary budget.
Reasoning billing rules now reject unknown and mode-incompatible fields.

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

Milestone C should not be declared complete while concerns 14 and 15 remain.
D-PRICING should not be declared complete while concerns 19 and 21 remain.
D-CONFIG should not be declared complete while concerns 23, 27, and 28 remain.
D-CONTROLS should not be declared complete while concerns 29 and 30 remain.
The D-CONFIG and D-CONTROLS pass claims in their review files are therefore premature.
