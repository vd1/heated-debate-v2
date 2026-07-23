# Implementation concerns for Fable

Status: concerns 1-33, 36, 42, and 44 are resolved. Concerns 34, 35, 37, 38,
40, 41, and 43 are partially resolved. Concerns 39, 45, and 46 are open.

Updated on 2026-07-23 after reviewing through commit `3abf0f4`.

Clean full validation at `3abf0f4`:

- `bun test tests`: 285 passed, 4 skipped, 0 failed.
- `bun run typecheck`: passed.
- `bun run lint`: passed.

Passing checks do not cover the focused counterexamples below. The contracts in
`plans/implementation-plan.md` and `plans/implementation-plan-review.md` remain the acceptance
baseline.

## Resolved in the latest batches

- Concern 27: `ReplayResult.experimentGuarantee` now distinguishes `verified`, `unverified`,
  and `legacy-absent`.
- Concern 36: matrix purpose is checked against the holdout-use policy, selection excludes
  holdouts, and final evaluation uses only the declared baseline point.
- Concern 42: the local smoke now checks exact identity and controls and links usage to a
  versioned zero-API-price snapshot whose scope excludes hardware cost.
- Concern 44: a missing same-role comparison population is unavailable, and evaluator
  configuration contributes to result identity.

## Open concerns

### 34. Preregistration fields exist, but the execution attestation and some policies are not enforced

Severity: high

Status: partially resolved by `d159e48`.

The required policy fields now exist in `StudySpec` and contribute to its hash. Case ordering,
baseline selection, holdout use, and failure handling have consumers. The attestation helper now
returns the spec hash, commit text, cleanliness result, and development mode.

The study executor does not require or persist that attestation. A caller can invoke
`executeStudyRuns` without calling `assertPreregisteredStudy`, and the helper accepts an empty
commit string as committed evidence when `cleanWorktree` is true. `samplerSeed`,
`unknownCostPolicy`, and aggregate cost policy have no execution effect. Reward scalarization is
stored for its later milestone but is not yet resolved at an execution boundary.

Acceptance check: make the real study-execution boundary require a validated attestation and
record it with every run. Validate commit evidence as a non-empty immutable identity. Consume
each policy at the boundary that implements it, especially unknown-cost handling and aggregate
cost accounting.

### 35. Study-spec parsing still accepts invalid parameter points and unsafe object shapes

Severity: high

Status: partially resolved by `d159e48`.

Nested exact-field checks, duplicate dimension/value checks, fixed-versus-varied overlap checks,
and scalar parsers for several dimensions are now present. Remaining counterexamples at
`3abf0f4` include:

```json
{
  "missingBaselineAccepted": {"thinkingLevel": "low"},
  "invalidFixedAccepted": {"roundCount": -9, "thinkingLevel": "cold"},
  "invalidToolPolicyValuesAccepted": [{"garbage": 1}, {"garbage": 2}],
  "getterAcceptedAndInvoked": true,
  "callerHypothesesArrayFrozen": true,
  "reorderedSemanticSpecHashesEqual": false
}
```

More specifically:

- `baseline` may omit a varied dimension. Parsing succeeds and final matrix generation fails
  later.
- `fixedParameters` is an arbitrary record, so invalid run controls are accepted.
- `toolCapabilityPolicy` values are only cloned records. They never pass the existing tool-policy
  validator or binding checks.
- The only accepted creativity schedule is `linear-cooling@1`, while a varied dimension requires
  distinct values. That advertised matrix dimension cannot currently vary.
- Plain-prototype checks do not reject own accessors. Parsing invoked an enumerable rubric
  getter.
- `stringArray` returns caller arrays. Deep freezing the result consequently froze the caller's
  `hypotheses` array.
- Cross-field feasibility is not checked, including baseline coverage, sample count versus
  possible runs, run limits, and model/pricing compatibility.

Acceptance check: parse fixed parameters through the run-configuration schema, validate complete
baseline coverage during spec parsing, use the existing tool-policy validator with role/phase
bindings, and either provide multiple valid creativity schedules or remove that varied
dimension. Reject accessors and defensively clone every input before freezing. Normalize
semantically unordered search-space declarations before hashing and add cross-field feasibility
tests.

### 37. Matrix identity is stronger but still lacks collision handling and full derivation checks

Severity: high

Status: partially resolved by `d159e48`.

Run specifications now retain the full spec and case hashes, use canonical typed values, and use
zero-based repetitions. Case content therefore contributes to identity.

The run ID still contains only 12 hexadecimal characters from each spec and case hash, and
neither hash dependency is injectable for collision tests. The public `studyRunId` also accepts
an arbitrary externally supplied `variantKey`; this produced a valid run ID for
`nonsense=true`, even though that point is absent from the study search space.

The run specification is not validated as a complete identity preimage. In particular, a final
evaluation containing an object-valued baseline clones that object and freezes only the outer
parameter record, so nested mutation can make executable parameters diverge from `variantKey`.

Acceptance check: derive the variant key internally from a validated parameter point, validate
the full point against fixed and varied declarations, and deep-freeze the complete run
specification. Inject identity digests in tests and fail explicitly when distinct preimages
collide. Either put full hashes in the ID or prove short-ID collision detection at matrix and
resume boundaries.

### 38. Stable matrix output does not yet cover reordered semantic inputs or invalid combinations

Severity: medium

Status: partially resolved by `d159e48`.

Variants are sorted by canonical typed key, repetitions are zero-based, and case ordering follows
the declared policy. The tests still repeat identical input rather than reorder it.

Reversing varied-dimension declarations and each dimension's values produced a different
`studySpecHash` and therefore different run IDs for the same Cartesian search space. No test
injects hash collisions or exercises invalid combinations across multiple dimensions.

Acceptance check: decide and document which list orders are semantic. Canonically normalize
unordered dimension/value declarations before hashing, then test reordered case definitions,
dimensions, and values. Add cross-dimension compatibility and injected-collision tests and pin
the exact output order.

### 39. D-EXECUTOR is still a callback scheduler rather than the required run executor

Severity: high

Status: open after `d159e48`.

`executeStudyRuns` validates a run's `specHash`, derives run-count and failure limits from the
spec, asks a callback for artifact state, optionally asks another callback for a claim, and then
invokes a caller-supplied `execute(run)`.

It still does not:

- construct a validated `ExperimentConfig` from the run specification;
- create fresh scripted agents and a `JsonlEventWriter`;
- call `runDebate`;
- own the artifact root, temporary output, terminal validation, final publication, or cleanup;
- validate resume artifacts itself;
- require an atomic claim or release claims and resources on every path;
- distinguish a competing claim or retryable interruption from a terminal run failure.

Returning `"completed"` from `readArtifactState` skips a run without the executor seeing a
terminal event or any recorded identity. This preserves the caller-trust shortcut that the
executor acceptance notes prohibit.

Acceptance check: implement the execution boundary described in the plan. It should own artifact
reading and validation, fresh agent/writer factories, the domain runner, atomic claim and
temporary publication, closure checks, and cleanup. Keep `executeMatrix` as a tested scheduling
primitive if useful, but do not present it as D-EXECUTOR completion.

### 40. Run-count limits improved, but monetary and per-run budget enforcement is absent

Severity: high

Status: partially resolved by `d159e48`.

Validated completions within the supplied matrix now count against the minimum of
`stoppingRules.maxRuns` and `budgets.maxTotalRuns`. Failure behavior also comes from the spec, and
the comment declares at most `concurrency - 1` already-dispatched failures after the threshold.

`budgets.maxTotalAmount`, accumulated prior cost, per-run turn/token limits, pricing, and
`unknownCostPolicy` never enter executor accounting. A focused spec with
`maxTotalAmount: 0` and positive prices still dispatched and completed a run. There is no
maximum-spend reservation before concurrent dispatch.

The public lower-level helper also accepts invalid direct limits. With
`maxTotalRuns: -1` and `maxConsecutiveFailures: 0`, it returned a stopped report rather than
rejecting the configuration. The documented concurrent failure overshoot has no test.

Acceptance check: pass the spec's per-run budget into the constructed domain run, validate prior
artifact cost, and reserve each run's maximum declared amount before dispatch. Apply the
preregistered unknown-cost policy and release reservations on every result. Test resume with
prior spend, unknown prices, zero remaining amount, and the exact permitted in-flight failure
overshoot. Validate all numeric inputs on any public scheduling primitive.

### 41. Artifact paths use a full digest but still do not handle injected collisions or validate identity

Severity: high

Status: partially resolved by `19cb73d`.

The path now uses the complete SHA-256 run-ID digest and accepts a digest function for tests. The
function does not detect a collision. Supplying a constant digest for the original
slash-versus-underscore pair still produced identical paths.

The field check only searches the run-ID text for `caseId`, `variantKey`, and the repetition
suffix. It accepted a run whose `specHash`, `caseHash`, `holdout`, and `parameters` were all
changed without changing the run ID. It neither reconstructs the expected ID nor checks an
existing artifact's full identity before reuse. Large canonical variant keys can also exceed a
filesystem component limit because the full sanitized key is a directory name.

Acceptance check: validate or reconstruct every encoded field from the complete run
specification, use bounded path components, and compare a stored full identity before any
existing path is trusted. Make the injected digest collision test fail closed rather than map
distinct runs to one path.

### 43. The deterministic evaluator boundary still overstates evidence and is not shared with a judge

Severity: high

Status: partially resolved by `19cb73d`.

Known results now carry a configuration hash, range, direction, and event sequence numbers.
One kind of partial usage and missing comparison populations are unavailable.

The declared `EvaluatorPort` is specific to `DeterministicEvaluatorOptions` and returns
`DeterministicScore`, whose version is the literal `"3"`. A judge-backed evaluator cannot
implement that port with its own validated configuration and evaluation result without
pretending to be a deterministic evaluator.

Evidence is also incomplete:

- unavailable results omit range, direction, and evidence entirely;
- evidence contains sequence numbers without the run ID;
- completion evidence omits the terminal `run.completed` or `run.failed` event that determines
  the score;
- an attempt with entirely absent usage is ignored when another attempt has complete usage.

The last case produced a known total of 24 tokens from four attempt events whose usage objects
were `{}`, `{inputTokens: 10, outputTokens: 2}`, `{}`, and
`{inputTokens: 10, outputTokens: 2}`. The two missing attempts were not reported as unavailable.

Configuration identity is computed before a shared configuration validator runs. For
`evaluateCompletion`, invalid options containing `latencyTargetMs: NaN` and
`latencyTargetMs: null` were both accepted and produced the same configuration ID.

Acceptance check: define a genuinely shared generic evaluator result and port, with evaluator-
specific validated configuration and a full versioned configuration identity. Give every result
range, direction, and canonical `{runId, sequence}` evidence references, including terminal
evidence for completion and relevant evidence for unavailable results. Treat any attempt missing
required usage as unavailable, and table-test mixed complete/missing retries.

### 45. The judge-output parser silently discards undeclared data

Severity: high

Status: open at `3abf0f4`.

The E-RUBRIC review says unknown fields are rejected at every level, but that is true only for
the rubric definition. `parseJudgeOutput` ignores unknown outer fields, undeclared dimensions,
and unknown fields inside a dimension entry.

This input returned `status: "valid"`:

```json
{
  "extra": "ignored",
  "dimensions": {
    "quality": {"score": 4, "evidence": "invented", "extra": "ignored"},
    "undeclared": {"score": 5}
  }
}
```

That conflicts directly with the review requirement to never silently discard unknown
dimensions. In addition, `requiredEvidence: "quote"` checks only for a non-empty string. It does
not establish that the string quotes or references the declared source artifact.

Acceptance check: use an exact judge-output schema. Report unknown dimensions and malformed
entry fields as partial or malformed with explicit reasons. Define the evidence representation
and verify quote evidence against the declared artifact, either here with source input or in the
judge boundary before a result becomes valid. Add outer, entry, unknown-dimension, duplicate-key,
and fabricated-evidence tests.

### 46. The canonical evaluation-record constructor does not validate the record it creates

Severity: high

Status: open at `3abf0f4`.

`createEvaluationRecord` validates only the source run ID/hash, judge ID/version, non-empty
message-array length, and presence of either an outcome or failure. Runtime inputs can bypass the
TypeScript annotations.

A focused call accepted all of the following in one frozen record:

- an empty and duplicate `declaredInputs` list entry plus a non-hash reference;
- `messages: [{}]`;
- empty model IDs and `thinkingLevel: "cold"`;
- a forged valid outcome with score `999` outside the rubric scale;
- raw response text unrelated to the supplied outcome;
- both an outcome and a failure at the same time.

It also accepted the forged outcome with `rawResponse: null`. Consequently the resulting hash is
deterministic, but it does not certify a canonical or internally consistent evaluation.

Acceptance check: parse or validate every nested runtime value, including rubric, declared
artifact references, messages, requested controls, outcome, and sanitized failure. Require
mutually exclusive success and failure states. On a judge response, derive the outcome from the
stored raw response and referenced rubric or verify that exact relationship. Require the raw
response for valid/partial/malformed parsing outcomes, and test forged scores, invalid controls,
empty inputs, contradictory states, and outcome/raw-response drift.
