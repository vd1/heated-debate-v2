# Implementation concerns for Fable

Status: concerns 1-13, 15-26, and 30 are resolved. Concerns 14 and 27-29 are
partially resolved. Concerns 31-33 are open.

Updated on 2026-07-23 after reviewing through commit `645f5f1`.

Validation at `645f5f1`:

- `bun test`: 246 passed, 3 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not cover the remaining counterexamples below. The task contract in
`plans/implementation-plan.md` remains the acceptance baseline.

## Open concerns

### 14. Percent-encoded endpoint credentials still reach web-search failure records

Severity: high

Status: partially resolved by `193469a` and `1c22808`.

The configured header key, plain endpoint credentials, successful provenance, and direct
whitespace-query path are now covered. The new endpoint redactor still has an encoding mismatch:
it applies `decodeURIComponent` to userinfo and reads decoded `searchParams` values, while a
transport that echoes the requested URL returns their percent-encoded forms.

This direct reproduction:

```text
endpoint: https://us%40er:p%40ss@example.test/search?api_key=q%40secret
transport error: transport failed for <requested URL>
```

still produces:

```text
transport failed for https://us%40er:p%40ss@example.test/search?api_key=q%40secret&q=x&format=json
```

The added test uses credentials whose serialized and decoded forms are identical, and it remains
a direct port test rather than the requested canonical artifact sentinel.

Acceptance check: sanitize both encoded and decoded endpoint-derived credential forms, or
normalize transport failures without retaining the raw request URL. Add a canonical JSONL test
whose throwing transport repeats a credential-bearing URL containing percent escapes, and verify
that neither representation of any credential reaches the serialized tool failure.

### 27. Replay ignores the recorded case and config identity

Severity: high

Status: partially resolved by `997834d`.

`experimentDebateInput` now carries the config hash and case ID, and canonical schema v7 records
them in `run.started`. The replay boundary does not consume that evidence:
`ReplayConfiguration` cannot state an expected experiment identity, and `readSuccessfulTrace`
drops `run.started.data.experiment`.

I generated a valid recorded run with hash `aaaa...` and `case-a`, replayed it, changed only the
start event to hash `bbbb...` and `case-b`, and replayed again with the same configuration. Both
replays succeeded:

```text
replay-accepted-mutated-experiment
```

The commit added event recording coverage but no same-topic case pair or replay drift regression
from the earlier acceptance check.

Acceptance check: include the expected config hash and case reference in replay configuration,
retain the recorded experiment identity in the successful trace, and compare them before
scheduling. Add drift rows for each field and define the compatibility behavior for migrated
artifacts whose experiment value is `null`.

### 28. Protocol, context, and creativity selections do not reach the scheduler

Severity: high

Status: partially resolved by `997834d`.

The validated config now exposes versioned protocol and creativity identities and rejects
unsupported values. The execution path remains hard-coded:

- `experimentDebateInput` drops `config.protocol` and `config.contextPolicy`.
- It passes `creativitySchedule` to `runDebate`, but the runner only checks that it equals
  `linear-cooling@1`.
- `DebateSchedulerInput` has no protocol, context-policy, or creativity-schedule fields.
- `DebateScheduler.nextTurn` directly calls `selectCreativity`, and it directly calls the
  last-exchange context selector.

The test named "routes them to the scheduler" checks only that `experimentDebateInput` contains
the creativity object. It does not construct a scheduler with that selection, and it has no
assertion for protocol or context routing.

Acceptance check: make the validated identities actual scheduler inputs and resolve their
implementations at that boundary. Replay must construct the scheduler with the same identities.
Tests should fail if a requested identity is accepted but a different implementation is selected.

### 29. The creativity audit observes the scheduler default rather than propagation

Severity: high

Status: partially resolved by `770fb5a`.

The audit now explicitly places `linear-cooling@1` in the config and checks the identity, level,
and instruction in the request and prompt. This is useful coverage of the emitted values, but it
does not prove that the selected config value traveled through scheduling. Concern 28's execution
path validates the input and then independently selects the same hard-coded schedule.

The audit assertions also compare the request to fixed literals rather than to the parsed
selection that entered the run. The test would continue to pass if the scheduler never received
that object, which is the current behavior.

Acceptance check: first resolve concern 28, then make the audit retain the parsed selection and
prove that the scheduler resolver receives it. Compare the resulting request and canonical event
to that selected identity, along with the level and exact prompt instruction.

### 31. Experiment identity is neither validated nor snapshotted by the runner

Severity: high

`RunDebateInput.experiment` is described as immutable, but `runDebate` repeatedly reads the
caller's mutable object. It does not validate the hash or case ID at the input boundary. A sink
that mutates the hash after receiving `run.started` produces a successful result with conflicting
identity:

```json
{
  "started": {
    "configHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "caseId": "case"
  },
  "result": {
    "configHash": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "caseId": "case"
  }
}
```

`projectDebateEvents` uses the result identity, so post-hoc projection can also disagree with the
live artifact. A direct caller can supply a malformed hash or empty case ID and the runner will
attempt to emit an event that canonical serialization rejects.

Acceptance check: validate and clone the experiment identity before the first asynchronous
boundary, freeze that snapshot, and reuse it for `run.started`, `DebateResult`, and post-hoc
projection. Add caller-mutation and malformed-identity regressions.

### 32. There is no uniqueness boundary for an arbitrary case collection

Severity: medium

The D-CASES acceptance notes explicitly require duplicate case IDs to be rejected.
`parseBenchmarkCase` validates only one case, and the module exports no collection parser or
definition helper that can enforce uniqueness. The fixture test computes a `Set` over the three
built-in IDs, but callers can assemble and pass any duplicate-bearing `BenchmarkCase[]` without
cross-case validation.

Deferring this entirely to D-MATRIX would leave case-set consumers such as D-STUDY-SPEC to invent
their own rule, and would not satisfy the D-CASES completion claim.

Acceptance check: add a frozen case-set definition or parsing boundary that validates every case
and rejects duplicate `caseId` values deterministically. Test duplicates across separately parsed
cases as well as the built-in fixtures.

### 33. The untrusted case parser accepts prototype-backed required fields

Severity: medium

`parseBenchmarkCase` accepts any non-array object and then casts it to
`Record<string, unknown>`. Unknown-field inspection uses own enumerable keys, but required values
are read through normal property access. An object with no own keys and every required field on
its prototype is accepted:

```text
ownKeys: []
parsed.caseId: inherited-id
parsed.topic: Inherited topic
```

The same issue applies to the nested rubric object. This is not a JSON object boundary and makes
the review's untrusted-input claim broader than the implemented validation.

Acceptance check: require plain JSON records with accepted prototypes at both levels and read
required fields as own properties. Add inherited required-field, inherited unknown-field,
accessor, and non-plain-object regressions.

## Resolved concerns

### 1-13

The dispatcher, replay guarantee, trace preservation, ordering, secret handling, byte counting,
loop failure, schema validity, and canonical evidence concerns remain resolved by commits
`94efdc7`, `aff61a9`, `5fc2d80`, `87fd863`, and `3829d42`.

### 15. Web-search query validation is aligned

Resolved by `1c22808`. The Pi schema now requires a non-whitespace character with the shared
query rule, while the direct port retains its matching validation. The schema regression rejects
a whitespace-only call before the web-search port executes.

### 16-18 and 20. Pricing snapshot and exact enforcement

Resolved by `6aedaae`. The runner snapshots monetary controls, successful attempts use returned
model identity, cost accumulation uses scaled integers, and effective dates require real calendar
dates.

### 19. Reasoning subsets require an output total

Resolved by `1c22808`. Included-output and unbilled rules now return unknown cost with
`outputTokens` missing when reasoning is present without its containing output total.

### 21. Token counts use the safe-integer invariant at every pricing boundary

Resolved by `1c22808`. Canonical usage rejects fractional counts, and direct pricing validates
every count before exact integer arithmetic.

### 22. Evidence-validation failure preserves terminal artifact closure

Resolved by `7b39d41`. Invalid evidence is excluded while `turn.failed` and `run.failed` preserve
a canonical terminal artifact.

### 23. Canonical config preserves omission

Resolved by `997834d`. The deeply frozen validated source is retained separately from resolved
execution values, so omission and an explicit default have different canonical JSON and hashes.

### 24-26. Config numeric and nested pricing validation are aligned

Resolved by `13ff5f1`. Counts require safe integers, monetary amount scale is validated, and
reasoning billing rules reject unknown or mode-incompatible fields.

### 30. The control audit executes and denies tool calls

Resolved by `770fb5a` and `c7f1c1e`. The fake Pi stream now executes one allowed call, records an
undeclared call as denied, proves only the allowed executor ran, checks both canonical
dispositions, and keeps tool verification out of the provider report.

## Completion status

Milestone C should not be declared complete while concern 14 remains.
D-PRICING has no remaining concern in this file.
D-CONFIG should not be declared complete while concerns 27, 28, and 31 remain.
D-CONTROLS should not be declared complete while concern 29 remains.
D-CASES should not be declared complete while concerns 32 and 33 remain.
The D-CONFIG, D-CONTROLS, and D-CASES pass claims in their review files are therefore premature.
