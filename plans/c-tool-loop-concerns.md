# Implementation concerns for Fable

Status: concerns 1-26 and 28-33 are resolved. Concerns 27, 36, 41, 43, and 44
are partially resolved. Concerns 34, 35, 37-40, and 42 are open.

Updated on 2026-07-23 after reviewing through commit `9a294df`.

Last clean full validation at `cef997f`:

- `bun test tests`: 270 passed, 4 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Focused counterexamples were rerun at `9a294df`. Full validation is deferred while Fable's
uncommitted STUDY-SPEC follow-up is in progress.

Passing checks do not cover the counterexamples below. The contracts in
`plans/implementation-plan.md` and `plans/implementation-plan-review.md` remain the acceptance
baseline.

## Open concerns

### 27. Weakened experiment replay is explicit but not reported

Severity: medium

Status: partially resolved by `997834d`, `5b84160`, and `9a294df`.

Replay now fails closed when a non-null recorded experiment identity has no expected identity,
unless `allowUnverifiedExperiment` is explicitly true. Historical `null` identity remains
compatible. This closes the silent bypass.

The achieved guarantee is not present in `ReplayResult`. A caller that receives the result cannot
distinguish verified identity, explicitly unverified identity, and a historical artifact with no
identity. Tool replay already reports its weakest achieved guarantee, so experiment identity
should follow the same pattern.

Acceptance check: add an experiment replay guarantee such as `verified`, `unverified`, or
`legacy-absent` to `ReplayResult`, and pin each mode in tests.

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

### 36. Holdout execution is separated but not governed by the spec

Severity: high

Status: partially resolved by `9a294df`.

The default selection matrix now excludes holdouts, and final evaluation has a distinct
`purpose`. The final-evaluation mode remains a caller option rather than a decision enforced from
the hashed study spec. Any caller can request it, even when holdout use was not preregistered.

It also expands every search-space variant over the holdout set. A final evaluation normally
applies the preregistered selected or baseline configuration; exposing all variants permits
holdout comparison and reselection.

Acceptance check: consume the spec's holdout-use policy and reject incompatible matrix purposes.
Define the exact final-evaluation parameter point in the spec and generate only that point for
holdouts.

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

### 41. The shortened path digest still collides

Severity: high

Status: partially resolved by `9a294df`.

Artifact paths now append the first eight hex characters of a SHA-256 run-ID digest. This avoids
the original slash-versus-underscore example, but a 32-bit prefix is not injective. A focused
search found two run IDs whose variant segments sanitize identically and whose prefixes collide:

```json
{
  "values": ["/*?{///", "}${/?//"],
  "digest": "202481c7",
  "pathsEqual": true,
  "path": "study/abc/case/x=_______/rep1-202481c7.jsonl"
}
```

The commit message and code comment claim injectivity, which a truncated digest cannot provide.

Acceptance check: use a reversible encoding, or use the full canonical digest and detect an
existing-path identity mismatch before reuse. Inject the digest function so collision handling is
tested. Validate the complete run specification before path derivation.

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

### 43. Evaluator results still lack the shared evidence-bearing contract

Severity: high

Status: partially resolved by `9a294df`.

`DeterministicScore` now has `known` and `unavailable` variants, and entirely absent attempt usage
is unavailable. The E-DETERMINISTIC contract also requires a shared `EvaluatorPort`, declared
range and direction, evaluator configuration identity, and canonical evidence event references.
None of those fields or boundaries exists yet.

Partial usage is still treated as exact. Attempts that report input tokens but omit output tokens
produce a known efficiency score, with every missing kind added as zero:

```json
{
  "status": "known",
  "score": 0.8,
  "value": 20,
  "detail": "20 observed tokens against a budget of 100"
}
```

Both attempts in that reproduction omitted output usage.

Acceptance check: introduce the shared evaluator boundary and include range, direction, versioned
configuration identity, and evidence event references. Define which usage kinds the measurement
requires and return unavailable whenever required evidence is absent; do not convert partial
evidence into an exact total.

### 44. Missing comparison data is still scored as success

Severity: medium

Status: partially resolved by `9a294df`.

The patch validates numeric options, uses set-based Unicode-aware Jaccard similarity, counts
cache usage, and defines output length in code points. Those fixes close the reproduced `NaN` and
out-of-range measurements.

A one-round run has no consecutive same-role pair to compare. `evaluateRepetition` nevertheless
returns a known perfect score:

```json
{
  "status": "known",
  "score": 1,
  "value": 0,
  "detail": "worst consecutive same-role Jaccard similarity 0.000"
}
```

Evaluator options also remain absent from result identity, so the same evaluator version can
still represent different markers, bounds, budgets, and targets.

Acceptance check: return unavailable when the required comparison population does not exist.
Move options into a validated, versioned evaluator configuration referenced by every result.
Table-test one-round, empty, partial, and failed artifacts for every evaluator.

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

### 33. Case parsing rejects prototype and property-descriptor substitution

Resolved by `9a294df`. Parsing now rejects accessor fields and `toJSON`, and `defineCaseSet`
validates original frozen inputs rather than serializing a replacement value.

## Completion status

Milestone C and D-PRICING have no remaining concern in this file.
D-CONFIG remains open on concern 27.
D-CASES has no remaining concern in this file.
D-STUDY-SPEC remains open on concerns 34 and 35.
D-MATRIX remains open on concerns 36-38.
D-EXECUTOR remains open on concerns 39-41.
D-LOCAL-MODEL remains open on concern 42.
E-DETERMINISTIC remains open on concerns 43 and 44.
Milestone D and E-DETERMINISTIC should not be declared complete yet.
