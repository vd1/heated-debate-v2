# Implementation concerns for Fable

Status: concerns 1-33, 36, 38, 42, and 44 are resolved. Concerns 34, 35, 37,
39-41, 43, 45, and 46 are partially resolved. Concerns 47-50 are open.

Updated on 2026-07-23 after reviewing through commit `8c37ed0`.

Clean full validation at `8c37ed0`:

- `bun test tests`: 306 passed, 5 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not cover the focused counterexamples below. The contracts in
`plans/implementation-plan.md` and `plans/implementation-plan-review.md` remain the acceptance
baseline.

## Progress accepted in this batch

- Study dimensions and values are normalized before hashing. Baseline coverage, fixed scalar
  controls, accessors, caller-array freezing, tool-policy structure, arbitrary variant keys, and
  nested run-spec freezing have been addressed.
- Matrix declaration reordering is now tested. Concern 38 is resolved; duplicate-identity handling remains
  under concern 37.
- A real infrastructure study runner now creates per-run configurations, agents, sinks, claims,
  reservations, and domain runs.
- Deterministic evaluator results now contain run-qualified evidence, unavailable-result
  metadata, terminal evidence for completed and failed runs, and mixed missing-usage detection.
- Judge output unknown fields and undeclared dimensions are reported, and evaluation-record
  outcomes are derived from raw responses instead of accepted from callers.

## Current concerns

### 34. Preregistration is required by API shape but is neither unforgeable nor fully persisted

Severity: high

Status: partially resolved by `4eb2174` and `6008c35`.

`executeStudy` now requires an attestation and checks its spec hash. It does not validate the
attestation's mode, commit, or cleanliness. A manually constructed invalid object with a matching
`specHash` is accepted. The attestation is returned in the in-memory report but is not recorded
in each run artifact.

The study spec also still lacks the E-RELIABILITY design decisions that the review requires to be
fixed before collection: judges, candidate/model strata, permutations, blinding labels,
statistic versions, and thresholds for self-preference and judge disagreement. `samplerSeed`
exists but is not consumed by a sampler.

Acceptance check: validate the complete attestation at the execution boundary and persist its
spec hash, commit, cleanliness, and mode in artifact evidence. Extend preregistration to the full
reliability design, then make the collector derive its sampling plan from those hashed fields.

### 35. Study parameter validation still does not describe a complete executable run configuration

Severity: high

Status: partially resolved by `a9ca2b8`.

Fixed values now accept only `roundCount` and matrix-eligible global controls. Model assignments,
per-role controls, protocol/context selections, and participant capabilities are not expressible
as the fixed run configuration described by the plan. The executor consequently relies on
`ExperimentConfig` defaults for those choices.

Tool-policy structure is validated, but its execution binding is not. Any valid reviewer-bound
policy passes study parsing, while `runConfigForSpecification` always installs the single
`toolCapabilityPolicy` on the proposer. The error appears only when the later experiment config
is built. Cross-field feasibility between sample counts, run limits, cases, repetitions, and
model pricing also remains unchecked.

Acceptance check: represent and parse a complete fixed `ExperimentConfig` base, then apply a
validated parameter point to it. Model capabilities per participant rather than as one ambiguous
global policy. Build and validate every possible parameter point during study preflight, and
reject infeasible sample/run/budget combinations before matrix execution.

### 37. Short run identities allow a completed artifact from another spec to be resumed

Severity: critical

Status: partially resolved by `a9ca2b8`.

Variant keys are now derived from validated points, full hashes remain in `RunSpecification`, and
run specs are deeply frozen. The run ID still contains only 12 hexadecimal characters of the
spec and case hashes. The new test-supplied-digest test does not create or reject a duplicate
identity; it supplies one prefix to a single spec and confirms that other identity segments
remain distinct.

A focused cross-spec reproduction generated two specs with different full hashes, supplied the
same digest, and executed the first spec into a run-ID-keyed store. Executing the second spec
accepted every first-spec artifact as complete:

```json
{
  "fullSpecHashesDiffer": true,
  "runIdsEqual": true,
  "agentsCreatedForSecond": 0,
  "secondSkipped": 2
}
```

The artifact records neither the full study-spec hash nor full case hash. Its experiment config
hash is also identical when the colliding specs differ only in study metadata such as a
hypothesis. The executor's current check of `run.specHash` validates the new matrix object, not
the old stored artifact.

Acceptance check: put full spec and case identities into canonical run-start evidence and compare
them during resume. Use a bounded path digest only as a locator, never as the stored identity.
Make a test execute spec A, supply an overlapping locator for spec B, and prove that B rejects A's
artifact.

### 39. The study runner does not yet validate, publish, and clean up artifacts safely

Severity: critical

Status: partially resolved by `6008c35`.

The new runner owns the major execution pieces, but `validateArtifact` checks only the first
event, last event, non-null experiment identity, and priceable attempts. It never calls
`validateCanonicalSequence`, never compares the recorded experiment hash/case ID to the expected
per-run configuration, and never checks all event envelope run IDs. Malformed middle events and
mismatched event envelopes can therefore be resumed.

Publication occurs before post-run validation. If validation then fails, `discard()` is asked to
remove temporary output even though `publish()` may already have installed the final artifact.
The store contract does not require removal of that published final.

Claim acquisition, `openSink`, and `createAgents` occur before the `try/finally`. A sink-open or
agent-factory failure strands the claim and reservation. Within the `finally`, a throwing first
agent disposal prevents disposal of the second agent and claim release.

All domain failures are discarded, including a valid terminal `run.failed` artifact. The runner
therefore loses retry usage, cannot distinguish terminal failure from retryable interruption on
resume, and may pay for the same terminal failure again.

Acceptance check: validate the full canonical sequence and exact expected experiment, spec, case,
and run identities before resume or publication. Validate the temporary artifact before atomic
rename. Enclose every post-reservation step in nested cleanup that cannot skip later releases.
Persist terminal failure artifacts and define which failure states are retryable.

### 40. Failed-run spend and returned model identity are missing from aggregate accounting

Severity: critical

Status: partially resolved by `6008c35`.

Run-count limits, per-run budgets, prior completed cost, declared maximum reservation, and
unknown-cost policy now have consumers. Aggregate cost is updated only after a completed
artifact is published. A provider failure can contain charged attempts, but its temporary
artifact is discarded and its reservation is released without adding observed spend. Repeated
failed runs can therefore exceed the aggregate monetary ceiling.

Resume also returns successfully when already-completed cost exceeds `maxTotalAmount`; the
ceiling only prevents another dispatch. Historical pricing uses the model from
`turn.requested`, not the returned model identity recorded by `turn.completed`, so an alias or
provider substitution can be charged at the wrong rate. Failed attempts have no per-attempt
model identity at all.

Acceptance check: retain and price attempt evidence from every completed and failed run, charge
it before releasing the reservation, and reject prior spend beyond the aggregate budget. Persist
the effective model identity for every attempt or define an explicit validated alias rule.
Table-test a paid failed attempt followed by continuation and a returned-model pricing mismatch.

### 41. Artifact path overlap and full-identity validation remain delegated to an unimplemented store

Severity: high

Status: partially resolved by `19cb73d`.

`artifactPathForRun` is unchanged. A constant test-supplied digest still maps the
slash-versus-underscore pair to the same path, its field check ignores full hashes and
parameters, and its full sanitized variant directory can exceed a filesystem component limit.

`StudyArtifactStore` is only an interface. The in-memory test store keys solely by `runId`, which
is exactly how the cross-spec identity overlap in concern 37 was reproduced. No production store
demonstrates bounded deterministic mapping, exclusive worker leases, temporary-directory
publication, identity comparison on overlap, or crash recovery.

Acceptance check: implement and test the real filesystem store. Use bounded locator components,
exclusive worker leases, temporary output plus sync/rename, full stored-identity comparison, and
stale-lease recovery. Supply an overlapping locator in a test and fail closed.

### 43. The shared evaluator port is still not a contract the judge implements

Severity: high

Status: partially resolved by `4eb2174` and `8a02bc8`.

`EvaluatorPort.evaluate` is synchronous and returns `EvaluationResult`. The judge's `evaluate` is
asynchronous and returns `Promise<JudgeEvaluation>`, so the new judge is not assignable to or
declared as `EvaluatorPort`. It shares only the result data type.

Configuration validation remains evaluator-dependent. `evaluateCompletion` accepted
`latencyTargetMs: Infinity` and `-Infinity`; both produced the same configuration ID. An
artifact prefix with all turns completed but no terminal event still produced a known
completion score of `0.5`:

```json
{
  "status": "known",
  "detail": "2 of 2 turns completed; terminal run.failed or missing"
}
```

This conflicts with the rule that completion comes from terminal evidence. Configuration hashes
also remain 12-character prefixes.

Acceptance check: define an asynchronous generic evaluator port whose result and record types are
explicit. Validate and snapshot each evaluator's full configuration before hashing, keep its
full identity, and reject unsupported values even when a particular evaluator does not use that
field. Return unavailable for a missing terminal event.

### 45. Judge-output exactness improved, but evidence validation is optional

Severity: medium

Status: partially resolved by `4eb2174`.

Unknown outer fields, undeclared dimensions, and unknown entry fields are now reported.
`sourceText` remains optional in both `parseJudgeOutput` and `createEvaluationRecord`. A
quote-required outcome containing fabricated text was valid when the caller omitted
`sourceText`. For a dimension with `requiredEvidence: "none"`, a numeric `evidence` field was
silently dropped and the result remained valid. Duplicate JSON object keys still receive normal
`JSON.parse` last-key-wins behavior.

Acceptance check: require declared source evidence whenever any rubric dimension requires a
quote. Reject a present evidence field unless it has the declared representation, and select a
documented duplicate-key policy rather than silently accepting the last value.

### 46. Evaluation records still do not validate full controls, messages, or source linkage

Severity: high

Status: partially resolved by `4eb2174`.

Outcome derivation, mutually exclusive parsed-outcome/failure state, basic identities, duplicate
input references, message roles, and thinking taxonomy are now checked.

A focused record still accepted:

- `temperature: NaN` and `maxOutputTokens: -5`;
- a message with an undeclared `extra` field;
- a fabricated quote because `sourceText` was omitted;
- an opaque declared input unrelated to the source artifact.

The `NaN` survives in memory but canonical hashing serializes it as `null`, creating a duplicate
identity. The record stores requested controls only, not the returned model identity or
`ControlReport`.

Acceptance check: use the existing exact requested-control parser, exact message schema, and
canonical JSON validator. Require declared input references to resolve to the source artifact
hash. Store returned model and full control/usage evidence for an executed judge request.

### 47. E-JUDGE does not validate its source or preserve its executed identity and observability

Severity: critical

Status: open at `8a02bc8`.

The judge accepts any event array whose first item is `run.started`; it does not call
`validateCanonicalSequence`. Changing a `turn.completed` event's envelope to a mismatched run ID
still produced a known judge result.

Judge options remain caller-owned after construction. Mutating `controls.thinkingLevel` from
`high` to `low` after `createJudgeEvaluator` caused the first evaluator to execute `low` while
retaining the configuration ID computed for `high`. A newly constructed evaluator executing the
same `low` request produced a different configuration ID.

The evaluation record retains requested controls but drops the reply's returned model,
forwarded/adjusted/unsupported control report, attempts, usage, duration, and tool-policy
evidence. Configuration identity excludes the exact prompt template, system role, creativity,
context policy, deny-all policy, and returned identity. It uses insertion-order-sensitive
`JSON.stringify` and a 12-character prefix.

If `createAgent()` rejects, no sanitized failure record is persisted because factory acquisition
occurs before the `try`. A focused reproduction returned `Error: factory down` with zero records.
Judge usage is dropped, so later reliability collection cannot enforce attempt-inclusive token
or monetary budgets.

Acceptance check: validate a closed canonical source artifact, snapshot and validate all options
at construction, and hash the complete semantic judge configuration canonically. Put agent
acquisition and cleanup inside the failure-record lifecycle. Persist the reply identity, full
control report, attempts, usage, latency, and policy evidence, and expose those facts to budget
accounting.

### 48. E-RELIABILITY converts missing experimental populations into passing zero effects

Severity: critical

Status: open at `8c37ed0`.

The study spec does not preregister the required sampling design. `ReliabilitySample` has no
candidate ID, repeated-measure group, permutation identity, blinded label, or dimensional score
vector. Global score variance therefore mixes candidate difficulty with judge variability;
unpaired means for ordering, self-preference, and judge disagreement can be confounded by
different candidate strata.

When a comparison population is absent, `analyzeReliability` returns zero. A focused artifact
with four identical, forward-only samples from one judge was `accepted`; ordering bias,
self-preference, and disagreement all appeared as zero. With
`minimumSampleCount: 0`, an empty sample list was also `accepted`. Even an invalid runtime sample
with empty model IDs and `ordering: "sideways"` was accepted by the analyzer.

The artifact stores only sample IDs and scalar scores, losing the order assignments,
judge/debater identities, randomized order, raw rubric vectors, and missing evaluations needed
to reproduce the analysis. It has no thresholds for self-preference or disagreement.
`assertAcceptedReliability` checks only `studySpecHash` and `status`; a manually constructed object containing
just those matching fields passed the optimization gate.

Acceptance check: preregister and validate the complete sampling design and statistic versions.
Represent missing comparison populations as unavailable and derive `rejected`. Preserve every
sample's candidate/group identity, blinded permutation, judge/debater strata, raw dimension
vector, evaluation-record hash, and failure. Reparse and recompute the artifact at the
optimization gate, including exact rubric, judge prompt/model/controls, analysis version, and
sampling design matches.

### 49. The opt-in reliability collector corrupts event chronology and does not enforce study budgets

Severity: critical

Status: open at `8c37ed0`.

The reversed condition reverses the entire canonical event list and rewrites sequence numbers.
Its first event becomes `run.completed`, so the judge rejects it before collection. Reversing
artifact chronology is not a presentation-order permutation.

The collector caps only the number of loop iterations and wraps each call in a timeout. It does
not enforce the spec's attempt-inclusive turn, token, per-run amount, or aggregate amount
budgets. The judge currently drops usage, so those limits cannot be reconstructed.

The reliability artifact hashes `rubric.rubricId` as `promptText`, not the exact prompt used by
the judge. It omits the actual `maxOutputTokens: 512` control, labels the debater model as the
judge model regardless of the source artifact, silently drops unavailable evaluations, and does
not use `samplerSeed`, strata, or blinding labels.

Acceptance check: build a deterministic presentation manifest that permutes candidate labels or
message order without altering canonical source chronology. Drive it from the preregistered seed
and design. Account for every attempt and unavailable result under the same live-run guardrails,
and persist the exact executed prompt, controls, returned judge identity, source debater
identity, order, usage, and failure. Add an offline collector test before any live probe.

### 50. E-REWARD does not preserve a validated vector or versioned scalarization identity

Severity: critical

Status: open at `8c37ed0`.

`computeReward` combines vector construction and scalarization. Its vector contains already
weighted terms rather than the underlying measurements, and records no units, directions,
normalization targets, group scope, missingness, or source evidence. The variance input is an
unscoped scalar, so the API does not establish whether this is a run reward or an aggregate over
which cases and repetitions.

Reward identity contains only caller-supplied ID/version. Different weights under the same
`rewardId@1` produced different scalars with indistinguishable result identity. The function
accepted `rewardVersion: "999"` and returned version `"1"`, accepted an empty reward ID, and
returned a known `NaN` scalar for invalid quality/fraction inputs. A positive
`monetaryWeight` with no monetary input silently contributed zero.

The implementation does not resolve or compare weights against
`StudySpec.rewardScalarization`, so preregistration does not constrain the actual objective.

Acceptance check: separate a source-evidenced raw reward vector from a versioned scalarizer.
Validate every input range and missingness state, define units/direction and aggregate scope, and
make any positively weighted missing component unavailable. Resolve the exact scalarizer
configuration from the study's ID/version and include a full configuration hash in every result.
