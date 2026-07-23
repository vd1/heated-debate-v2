# Implementation concerns for Fable

Status: concerns 1-26 and 28-32 are resolved. Concerns 27 and 33 are partially
resolved. Concerns 34-44 are open.

Updated on 2026-07-23 after reviewing through commit `cef997f`.

Validation at `cef997f`:

- `bun test tests`: 270 passed, 4 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not cover the counterexamples below. The contracts in
`plans/implementation-plan.md` and `plans/implementation-plan-review.md` remain the acceptance
baseline.

## Open concerns

### 27. Recorded experiment identity can still be ignored during replay

Severity: high

Status: partially resolved by `997834d` and `5b84160`.

Replay now retains `run.started.data.experiment` and compares the hash and case ID when
`ReplayConfiguration.experiment` is supplied. Omitting that optional field disables the check
even for a new artifact that records a non-null identity. I generated a schema-v7 run with a
config hash and case ID, replayed it with a configuration that omitted `experiment`, and got:

```text
new-artifact-identity-bypass-accepted
```

The historical compatibility test covers a `null` recorded identity. It does not justify
silently ignoring identity that is present.

Acceptance check: when the artifact records a non-null experiment identity, require a matching
expected identity unless an explicit weakened-replay mode is selected and reported. Preserve
automatic compatibility only for migrated artifacts whose recorded identity is `null`.

### 33. Case parsing still accepts accessors and a frozen `toJSON` replacement

Severity: medium

Status: partially resolved by `4c94872`.

The parser now rejects prototype-backed required fields and `defineCaseSet` rejects duplicate
IDs. Plain-prototype validation does not ensure JSON data properties. An enumerable getter is
executed and accepted as `caseId`:

```text
parsed.caseId: getter-id
getterReads: 1
```

`defineCaseSet` has another bypass for frozen inputs. It serializes them before validation, so a
frozen object containing only `toJSON` can replace itself with a valid case and be accepted as
`caseId: forged`.

Acceptance check: validate the original value and its own property descriptors before reading
fields. Reject accessors and `toJSON`; do not serialize an unvalidated frozen object to decide
what case it represents. Add the accessor and frozen-replacement regressions requested earlier.

### 34. Study specs omit required preregistration decisions

Severity: high

The study-spec acceptance contract requires the choices that must not be selected after results
are observed. `StudySpec` has no fields for:

- randomization or sampler seed;
- case-order policy;
- baseline definition;
- holdout-use rule;
- failure handling;
- unknown-cost policy;
- reward scalarization reference.

These are not optional omissions that can be added to `fixedParameters`: the top-level parser
rejects a supplied `samplerSeed` as an unknown field. MATRIX and EXECUTOR consequently choose
ordering, holdout use, and failure behavior in code or through invocation arguments rather than
from the hashed preregistration.

`assertPreregisteredStudy` also receives only a `committed` boolean. It records neither a commit
identity nor clean-worktree evidence for later attestation.

Acceptance check: add explicit versioned policy fields and include them in canonical hashing.
Validate their cross-field semantics and make downstream matrix and executor code consume them.
Represent commit, cleanliness, spec hash, and development override as execution evidence rather
than an untraceable boolean assertion.

### 35. Study-spec nested data and parameter points are not validated

Severity: high

Only top-level unknown fields are rejected. Unknown fields inside rubric, evaluator, varied
parameter, budget, per-run budget, stopping-rule, and reliability objects are accepted and then
silently dropped. The generic `record` helper also accepts prototype-backed objects.

Parameter validation stops at a matrix-eligible dimension name and an array length. For example,
`thinkingLevel: ["cold", "hot"]` is accepted. A fixed `thinkingLevel: "medium"` may coexist with
that varied dimension and is silently overwritten by MATRIX. Duplicate dimension declarations
and duplicate or structurally colliding values are not rejected.

The canonical hash accepts `unknown` values using a JSON-like helper without first proving that
they are JSON values supported by the selected dimension. This allows parse success followed by
hashing or matrix-generation failure.

Acceptance check: use exact-field plain-JSON validation at every nested level. Give every
matrix-eligible dimension a value parser and canonical encoder, reject duplicate dimensions and
values, and reject fixed-versus-varied overlap. Add cross-field checks for possible sample counts,
run limits, budgets, and selected model pricing.

### 36. The selection matrix executes holdout cases

Severity: high

The preregistration contract says holdouts stay out of the selection matrix unless a separate
final-evaluation matrix is explicitly defined. `generateExperimentMatrix` concatenates benchmark
and holdout IDs and generates the same variants and repetitions for both.

In a focused run with a benchmark case and a holdout case, half of the generated runs had
`holdout: true`. The flag labels the leak but does not prevent selection code from receiving and
evaluating those artifacts.

Acceptance check: generate benchmark selection runs by default. Add an explicit mode governed by
the spec's holdout-use policy for final evaluation, and return a distinct matrix purpose so
selection consumers cannot mix holdout results accidentally.

### 37. Matrix run identity does not pin case content or typed parameter values

Severity: high

Run IDs contain the case ID but not `benchmarkCaseHash`. Changing a case's topic while preserving
its ID leaves every generated run ID unchanged. Resume can therefore mistake artifacts from old
case content for the current run.

Variant identity is built with `String(value)`. Distinct JSON values can collapse to the same
text. A number `1` and string `"1"` for the same dimension produced the same run ID and failed
late as a duplicate. Objects collapse more broadly to `[object Object]`.

`RunSpecification` does not preserve the full identity preimage: it has no full study-spec hash,
case hash, or typed canonical variant identity. `studyRunId` embeds only a short spec-hash prefix
and accepts an externally supplied `variantKey`.

Acceptance check: derive identity from canonical tagged parameter values, the full spec hash,
the case hash, and a zero-based repetition. Store that full preimage in each run specification.
Inject the digest function in tests so hash collisions are detected rather than assumed away.

### 38. Matrix ordering and repetition semantics do not match the contract

Severity: medium

The implementation review requires a stable sorted Cartesian product, reordered-input tests, and
zero-based repetition IDs. MATRIX instead preserves spec case order, dimension declaration order,
and value declaration order, while repetitions run from 1 through `repetitions`.

The current stability test invokes the function twice with the same input. It does not reorder
cases, dimensions, or values, and there are no invalid-combination or injected-collision tests.

Acceptance check: apply the preregistered case-order policy, otherwise sort by canonical semantic
identity. Use zero-based repetition IDs and test reordered inputs, duplicate values, invalid
parameter combinations, collision handling, and exact output order.

### 39. D-EXECUTOR is a generic concurrency helper, not the required run executor

Severity: high

`executeMatrix` invokes a caller-supplied `execute(run)` callback. It does not construct an
`ExperimentConfig`, create fresh scripted agents, call `runDebate`, create a `JsonlEventWriter`,
or own an artifact directory. It has no atomic claim, temporary output, final publication, or
resource-release protocol.

Resume trusts a caller-provided set of completed IDs. It does not read an artifact, validate a
terminal event, or compare run and spec identities. This is the exact file-existence-style
shortcut the executor acceptance notes prohibit.

Acceptance check: add an executor boundary that consumes the validated spec and run
specification, owns fresh agent and writer factories, runs the domain loop, and publishes only a
validated terminal artifact. Resume must validate artifact closure and all recorded identities.
Use atomic claims so competing workers cannot execute the same run.

### 40. Executor budgets and stopping rules are detached from the study and break on resume

Severity: high

The executor does not accept `StudySpec`. Its `maxTotalRuns` and `maxConsecutiveFailures` are
independent invocation arguments, so callers can change preregistered policies after seeing
results. `stoppingRules.maxRuns`, per-run budgets, and `budgets.maxTotalAmount` are never consumed.

Run-count enforcement resets on resume. With two IDs marked completed and `maxTotalRuns: 3`, the
executor ran both remaining items, producing four study runs in total. Concurrent failure
stopping has no reservation or overshoot rule: with concurrency 4 and a threshold of 1, all four
runs failed and the report said four consecutive failures reached the rule.

Acceptance check: derive limits from the spec, include validated prior completions and observed
cost in aggregate accounting, and reserve declared maximum spend before dispatch. Define and test
the permitted in-flight overshoot or cancel and await excess work. Validate all direct numeric
inputs if a lower-level helper remains public.

### 41. Distinct runs can map to the same artifact path

Severity: medium

`artifactPathForRun` replaces every unsafe character with `_`. This is not injective:

```text
variantKey x=a/b -> x=a_b
variantKey x=a_b -> x=a_b
pathCollision: true
```

The function also combines parsed run-ID segments with separate mutable fields without checking
that they describe the same identity.

Acceptance check: use a reversible encoding or append a canonical identity digest to every
unsafe segment. Validate the complete run specification before path derivation and test path
collisions, traversal characters, Unicode, and mismatched run fields.

### 42. The local-model smoke does not prove identity, control, or pricing linkage

Severity: medium

The opt-in route keeps endpoint selection outside domain code and guarantees disposal. Its only
reply identity assertion is `providerId === "local"`. It does not check the returned model ID,
requested-versus-forwarded controls, or the output-token cap report.

The test sets Pi's adapter cost fields to zero but never links the run to the versioned zero-cost
local pricing entry or its snapshot hash. The review therefore overstates "the model entry is
zero-cost", and it does not distinguish zero API price from hardware or electricity cost as the
acceptance notes require.

Acceptance check: assert exact requested and returned identities or an explicit alias rule,
assert the full control report, and run pricing against the selected snapshot entry. Record or
verify the snapshot identity and document the scope of zero price.

### 43. Deterministic evaluation has no unavailable result and rewards missing usage

Severity: high

The E-DETERMINISTIC contract requires a shared `EvaluatorPort` and a versioned result carrying
known or unavailable status, range, direction, and evidence event references. The implementation
returns only `DeterministicScore` with an unconditional numeric score, value, and detail string.

`readRun` maps every absent token kind to zero. A completed run with no usage evidence and a
positive token budget receives a perfect efficiency score:

```json
{
  "score": 1,
  "value": 0,
  "detail": "0 observed tokens against a budget of 100"
}
```

This directly violates the required missing-data behavior.

Acceptance check: introduce the shared evaluator boundary and a discriminated
`known | unavailable` result. Include range, direction, evaluator configuration identity, and
canonical evidence references. Missing required token evidence must be unavailable, never zero
usage or a perfect score.

### 44. Evaluator configuration and algorithms can produce invalid measurements

Severity: medium

Evaluator options are neither validated nor included in result identity. The same evaluator
ID/version can therefore mean different marker sets, shape bounds, budgets, and latency targets.
A `NaN` latency target produces a `NaN` score, which serializes as `null`.

The repetition calculation compares a set for the previous reply with an array for the current
reply. Duplicate current words are counted repeatedly, so `"a"` followed by `"a a a"` reports a
Jaccard similarity of `3.000`, outside its mathematical range.

Token usage sums input and output only, while the domain's retry-inclusive token budget also
counts cache reads and writes. Output length uses UTF-16 code units while reporting characters,
and ASCII-only tokenization treats repeated non-Latin text as empty.

Acceptance check: parse a versioned evaluator configuration with finite, ordered bounds and
non-empty markers. Use set-to-set similarity with a locked Unicode tokenization rule, align token
measurement with the domain budget definition, and define the output-length unit. Table-test
invalid options, missing evidence, cache usage, Unicode, duplicate words, and serialization.

## Resolved concerns

### 1-13, 15-26, and 30

The earlier tool loop, replay guarantee, evidence ordering, web-query schema, pricing,
canonical-config, terminal-failure, and control-audit findings remain resolved by their recorded
fix commits.

### 14. Endpoint credentials are redacted in encoded and decoded forms

Resolved by `4c94872`. The web-search boundary now removes raw percent-encoded and decoded
userinfo and query credential values from echoed transport failures, with a focused regression.

### 28-29. Scheduler selections and creativity audit are connected

Resolved by `5b84160`. Protocol, context, and creativity identities reach the scheduler
resolution boundary, unsupported identities fail there, and the audit compares emitted
creativity to the parsed selection that entered the run.

### 31. Experiment identity is validated and snapshotted

Resolved by `4c94872`. The runner validates and freezes one identity snapshot before asynchronous
work and reuses it for live events and the returned result.

### 32. Case collections reject duplicate IDs

Resolved by `4c94872`. `defineCaseSet` validates the collection and rejects duplicate case IDs.

## Completion status

Milestone C and D-PRICING have no remaining concern in this file.
D-CONFIG remains open on concern 27.
D-CASES remains open on concern 33.
D-STUDY-SPEC remains open on concerns 34 and 35.
D-MATRIX remains open on concerns 36-38.
D-EXECUTOR remains open on concerns 39-41.
D-LOCAL-MODEL remains open on concern 42.
E-DETERMINISTIC remains open on concerns 43 and 44.
Milestone D and E-DETERMINISTIC should not be declared complete yet.
