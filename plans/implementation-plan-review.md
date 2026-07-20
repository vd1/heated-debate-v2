# Review of the implementation plan

Reviews [`plans/implementation-plan.md`](implementation-plan.md), read alongside
[`docs/ADR-0001-agent-boundary.md`](../docs/ADR-0001-agent-boundary.md), `AGENTS.md`, `README.md`,
and the v1 repository (`../heated-debate/`). Task IDs are the plan's stable slugs.

## Forward implementation review — 2026-07-19, after A-PI-ADAPTER

Repository baseline before this review: `main` was clean at `48c65b2`; `bun run test` passed all
13 tests, and type checking and linting were green. The implemented surface is intentionally
small: the domain-owned agent contract, `ScriptedAgent`, and the one-turn `PiAgent`. Every task
from A-LIVE-TURN onward was reviewed against that code, ADR-0001, and relevant v1 behavior.

**Overall verdict:** the milestone progression remains good, but the future plan is not safe to
execute unchanged. A-LIVE-TURN, B-EXCHANGE, and B-ROLES can proceed in order. B-CONTEXT must then
move ahead of B-ROUNDS, and three cross-cutting contracts need to be settled at their named task
boundaries.

### Required corrections to the execution path

1. **Move B-CONTEXT before B-ROUNDS.** `PiAgent` currently retains its entire provider
   conversation. `TurnRequest` declares only the new system prompt and prompt, so retained
   messages are neither selected by policy nor visible in run data. Building multiple rounds
   before fixing that would violate the repository rule against silently added context.
2. **Record the exact effective model input.** By B-CONTEXT, each turn needs a normalized,
   ordered message list selected by a named/versioned context policy. The Pi adapter must either
   rebuild its state from that list or expose and validate the exact retained list; merely
   recording `TurnRequest.prompt` is insufficient. This exact list later belongs in C-EVENTS.
3. **Make failed and in-progress attempts observable before C-FAILURES.** `PiAgent.runReply`
   currently discards `activeResponses` when `agent.prompt` throws, and the domain receives
   attempt data only after a successful reply. A typed failure carrying its partial trace, or an
   adapter-attempt observer, is required for failure events and retry-inclusive budgets.
4. **Choose tool-loop ownership before C-TOOL-LOOP.** The project should own a normalized tool
   dispatcher that enforces policy and emits traces; Pi-specific `AgentTool` wrappers and a
   scripted model driver can both use it. Leaving the loop solely inside Pi would make scripted
   tests, budget enforcement, failure traces, and replay provider-shaped.
5. **Recast D-CONTROLS as end-to-end consolidation.** Thinking, output limit, and temperature
   already exist; creativity arrives in B-DIAL and tools in Milestone C. D-CONTROLS should prove
   config → request → adapter report → canonical event propagation for those existing controls,
   not add them a second time.
6. **Add canonical evaluation records before live judging.** C-EVENTS covers debate-run events,
   but E-JUDGE must also preserve every judge input, prompt, control, response, and artifact
   reference. E-RUBRIC or E-JUDGE must version that linked evaluation record before any live
   reliability run.

### Milestone A

#### A-LIVE-TURN — ready, with a tighter live-test contract

Use one unmistakable opt-in variable such as `HEATED_DEBATE_LIVE=1`; the ordinary `test` command
must discover the test but skip it without constructing a runtime that can contact a provider.
When opted in, resolve the provider/model through `ModelRuntime`, use stored Pi authentication,
and fail clearly if either model or credential is unavailable. Bound the fixed prompt with a
short timeout and small `maxOutputTokens`, dispose in `finally`, and report only normalized
provider/model/control/usage data—never credential metadata or raw request headers. This is also
the right place to add the smallest production factory that turns runtime + model identity into a
`PiAgent`; do not make later live tests repeat model/auth wiring.

The live assertion must accept genuinely unavailable usage kinds and provider verification. It
should not require nonzero tokens in every field or claim that forwarding proves provider
honoring.

### Milestone B

#### B-EXCHANGE — ready

Define an exchange as exactly two ordered turns: proposer, then reviewer. The test should assert
the complete reviewer `TurnRequest`, not just use substring matching. Return immutable snapshots
of both requests and replies so later event emission does not have to reconstruct what happened
from final text. Keep controls and the empty capability policy explicit, even though this task
adds no dials or tools.

Use a deterministic turn-ID rule from the first test. The result should distinguish the original
topic, proposal, and review rather than flattening them into one transcript string.

#### B-ROLES — ready

Give each role a stable, versioned ID and exact prompt text. TypeScript `readonly` or `as const`
alone does not make an exported object immutable at runtime, so expose frozen values or defensive
copies. Record the role ID and the exact prompt snapshot used by each turn; a later edit to the
role registry must not rewrite the meaning of an old run.

Keep role definition separate from agent/model assignment. “Proposer” is protocol behavior,
whereas a particular Pi model is experiment configuration.

#### B-ROUNDS — reorder after B-CONTEXT

Do not implement this immediately after B-ROLES. First land B-CONTEXT and make effective input
messages explicit. Then specify that one round contains two turns and that `roundCount` therefore
implies `2 * roundCount` successful turn requests unless a failure stops the run. Round one must
define the absence of a prior review; later proposer turns consume the selected prior review, and
reviewer turns consume the current proposal.

Tests should cover exact ordered inputs and chronological results for two rounds. They should
also prove that no earlier proposal/review leaks through the adapter beyond what the selected
context policy declares.

#### B-CONTEXT — required before B-ROUNDS

Make `ContextPolicy` a pure domain selector whose output is an ordered list of normalized
messages plus a policy ID/version. Define `last-exchange` separately for each role: which topic,
own prior response, counterparty response, and current proposal are included must be explicit in
tests. “Pi retained the conversation” is an adapter mechanism, not a context policy.

The safest current fit is for `TurnRequest` to carry the exact selected input messages and for
`PiAgent` to synchronize its internal state to them before prompting. If persistent Pi state is
kept as an optimization, compare it with the selected list and reset/replay on any mismatch.
Canonical data must eventually contain both the policy decision and every effective message.

#### B-DIAL — ready after explicit context

Port only the prompt dial from v1, not v1's coupled temperature schedule. Freeze the expected
tables: one round `[5]`, two `[5, 1]`, three `[5, 3, 1]`, and five `[5, 4, 3, 2, 1]`; reject a
non-positive round count and an index outside `[0, totalRounds)`. Record the selected level,
schedule version, and exact injected instruction separately from the assembled prompt so the
dial can later be varied and audited.

The one-round choice of 5 is inherited behavior, but it is a policy decision rather than a
mathematical necessity. Keep it locked by the test so an optimizer cannot silently change its
meaning.

#### B-LIVE-DEBATE — ready only after the context correction

Reuse the A-LIVE-TURN factory and opt-in gate. Instantiate one agent per role, enforce the exact
`last-exchange` selections, and dispose both agents in `finally`. Assert structure, turn count,
effective message trace, response identity, and the control states applicable to the selected
provider; do not assert deterministic prose.

One live provider cannot naturally exercise every branch of the control taxonomy. Unsupported
and adjusted branches belong in offline adapter contract tests; the live smoke should confirm
that all requested controls are reported and that no state is mislabeled as provider-verified.
Use a test-level timeout/output cap here; domain-owned run budgets do not exist until C-FAILURES.

### Milestone C

#### C-EVENTS — ready after effective context is explicit

Start with a closed, discriminated event union and a common envelope containing schema version,
run ID, monotonic sequence, event type, and event-specific data. Turn-request events must include
role/round/turn IDs, the context-policy result, every effective message, controls, and
capabilities. Completion/failure events link to the request; adapter-attempt events preserve
attempt number, status, observable HTTP status, usage, and usage evidence.

Validate `ControlTrace` before serialization. `unsupported` is exclusive with `forwarded`,
`adjusted`, and `providerVerified`; `adjusted` requires a forwarded value equal to its adjusted
value; provider verification must not be inferred from forwarding. Test unknown fields and
unknown event/schema versions according to an explicit compatibility rule.

The secret invariant needs a real boundary, not a key-name assertion alone. Canonical event
types must have no credential/header fields, serialized failures must use sanitized domain error
data rather than arbitrary objects or stacks, and a test should inject known sentinel secrets
through configured secret inputs and prove none appears in serialized output. Free-form user or
model text cannot be guaranteed secret-free unless an explicit redaction policy is added.

#### C-JSONL — ready after C-EVENTS

Serialize one validated event per newline through a single ordered append queue so concurrent
callers cannot reorder or interleave bytes. Define `flush` as waiting for queued writes and
flushing the file handle; make `close` flush and be idempotent. Reject appends after close and
sequence/run-ID mismatches before touching the file.

For interrupted files, the reader should return all complete valid lines and distinguish an
incomplete final line from corruption in the middle. Do not silently repair or discard either.
Use temporary directories and injected failure points in tests; no production-path cleanup or
Markdown belongs here.

#### C-REPLAY — tighten the replay definition

Replay should feed recorded normalized replies into the pure debate scheduler and compare each
newly produced `TurnRequest` with the recorded request. It must not call an `AgentPort` or trust a
stored prompt hash without checking the structured values that produced it. Exclude inherently
observational fields such as timestamps and latency from semantic drift comparison.

Detect drift in role prompts, context-policy output, message order/content, controls,
capabilities, and protocol configuration, with an error locating the first mismatched event.
Replay should reject incomplete or failed runs unless a named partial-replay mode is requested.

#### C-LIVE-ARTIFACT — ready after replay and writer integration

Extend the existing B-LIVE-DEBATE harness rather than clone it. Write to a caller-selected
temporary/output directory, close in `finally`, parse the file back, validate event ordering,
replay it, and scan for configured sentinel secrets. Assert per-attempt accounting using only
what the provider exposes; do not manufacture usage for unobservable retries.

At this point “budget-bounded” can mean two rounds, per-turn output caps, and a harness timeout.
The test must not pretend to exercise domain token/cost stopping rules that arrive later.

#### C-MARKDOWN — ready

Render only validated canonical events and make output deterministic for a fixed event fixture.
Include run status, exact roles/prompts, turns, controls, usage/attempt summaries, and failures
needed for human audit, while keeping raw JSONL authoritative. Safely delimit untrusted model
text so headings or code fences in a reply cannot corrupt the projection's structure.

Snapshot a fixed-clock fixture and test an incomplete run as well as a successful tiny run. Do
not read the Markdown back into replay or evaluation code.

#### C-FAILURES — requires an agent failure/cancellation contract first

Extend `AgentPort` with standard-signal cancellation and a normalized failure carrying any
partial attempt trace. `dispose()` is lifecycle cleanup, not the only turn-cancellation API.
Specify whether whitespace-only output is empty, ensure every started run has exactly one
terminal event, and dispose all agents/writers in `finally` on every table row.

Define counters precisely: a turn is a dispatched `TurnRequest`; attempts are not extra turns;
retry usage is summed once from attempt events; reasoning tokens are not added again when they
are a subset of output; and absent usage remains unknown rather than zero. Checks before a turn
can prevent new work. Checks during provider-managed retries require an adapter observer capable
of aborting; if Pi exposes no usable per-attempt usage until completion, record that limitation
and stop immediately after the first observable over-budget result rather than claiming
mid-retry enforcement.

This is likely larger than one comfortable red/green cycle. Keep the single stable task ID, but
land one failure behavior at a time with the full suite green rather than implementing the table
in one batch. Monetary rows correctly remain deferred to D-PRICING.

#### C-TOOL-POLICY — ready as a pure policy task

Replace `CapabilityPolicy.toolNames` with a versioned policy that states role, protocol phase,
allowed tool IDs/schema versions, aggregate and per-tool call limits, `timeoutMs`, and a
byte-defined result limit. Validate uniqueness and positive/zero semantics. Record the resolved
policy in every request; environment availability is a separate adapter concern.

Test authorization and accounting as pure domain operations with no Pi imports. A call is charged
when accepted for execution, including calls that time out or fail; denied calls should be
recordable but should not consume an allowed-call budget unless the policy explicitly says so.

#### C-TOOL-LOOP — blocked on the ownership decision

Introduce a project-owned tool request/result/error vocabulary and dispatcher. Pi wrappers
translate `AgentTool` calls into that dispatcher; a scripted model driver emits the same
normalized calls. Both paths must enforce the identical C-TOOL-POLICY counters and produce the
same canonical tool events. Tool call IDs, schema/version, validated arguments, start/end
ordering, duration, truncated result metadata, and sanitized errors all need stable shapes.

Test malformed arguments before execution, undeclared tools, timeout, thrown error, cancellation,
oversized output, and a successful call followed by a final model response. Extend replay by
feeding recorded tool results back at the exact message position and comparing the entire tool
trace. Do not let Pi's internal transcript become the only copy of tool-result context.

#### C-WEB-SEARCH — ready after the normalized tool loop

Choose one concrete search backend at task start and keep its credentials/HTTP types behind a
`WebSearchPort`. Define provider-independent inputs and outputs: query, bounded result count,
title, URL/provenance, snippet, retrieval timestamp, and explicit truncation. Contract tests
should use a fake backend for success, empty results, rate limiting, malformed payload, timeout,
and cancellation.

The live test needs a separate opt-in variable and a strict query/result/time budget. Canonical
events may contain the search query and normalized results, but never auth headers, backend
tokens, or arbitrary raw error bodies. Use the dispatcher from C-TOOL-LOOP so web search does not
invent a second policy or trace path.

### Milestone D

#### D-PRICING — ready, with exact arithmetic

Represent rates as decimal strings or integer minor units per fixed token quantum; do not hash or
budget against binary floating-point calculations. The snapshot identity covers schema version,
currency, effective date, provenance, every rate, and the reasoning-billing rule. Match prices
against the provider/model actually reported by the attempt, not only the requested model.

Compute cost from canonical attempt usage, never by adding `AgentReply.usage` again. An absent
token kind is relevant only when its applicable rate is nonzero; a truly zero-priced kind need
not make cost unknown. For `included-in-output`, require output usage and do not add reasoning;
for `unbilled`, retain reasoning evidence but charge zero; for `separate-rate`, require and price
the separate count. Test mixed-model attempts, exact boundary equality, unknown cost, and the
explicit token-only override supplied as policy data until D-STUDY-SPEC owns it.

#### D-CONFIG — separate run configuration from study policy

`ExperimentConfig` should own one run's topic/case reference, role definitions and agent
assignments, protocol/round/context settings, per-turn controls, capabilities, and `RunBudget`.
Do not put aggregate study concurrency or total-study budgets in it; those belong in
D-STUDY-SPEC and D-EXECUTOR. Parse untrusted JSON into validated domain values rather than using
TypeScript casts.

Canonical serialization must distinguish omitted optional controls from explicit values and
must reference the immutable pricing snapshot when a monetary limit exists. Test defaults,
unknown fields/version, cross-field constraints, per-role overrides, retry-inclusive usage, and
round-trip stability. Environment variables can select an external config but must not mutate
domain defaults.

#### D-CONTROLS — revise to an end-to-end propagation audit

By this point all five listed controls already exist. For each one, prove the value travels from
validated config through the schedule/request, adapter or policy enforcement, control report,
and canonical events. Add a matrix-eligibility descriptor only after that path is complete.

Apply the five-state provider taxonomy only where meaningful. Thinking, maximum output, and
temperature can be forwarded/adjusted/unsupported/provider-verified. A creativity instruction
is materialized into an exact prompt and a tool allowlist is enforced by the project dispatcher;
neither should receive a fictitious provider-verification state. Test these dimensions
separately so v1's dial/temperature coupling cannot return.

#### D-CASES — ready

Give each case a schema version, stable case ID, exact topic/source content or immutable content
hashes, rubric reference, and provenance. Treat source context as evidence, not instructions,
and preserve its ordering and media/type metadata if more than plain text is allowed. Fixture
cases should be tiny, timeless, redistributable, and capable of producing deterministic tests.

Validate duplicate IDs, missing referenced content, unsupported versions, and canonical hash
stability. A case may reference a future rubric by opaque ID, as the plan states; loading and
resolving that rubric remains outside this task.

#### D-STUDY-SPEC — ready after run config and cases

Separate fixed run configuration, parameter search space, run budgets, aggregate study budgets,
and stopping rules in the schema. Add the randomization/sampler seed, case-order policy,
baseline definition, holdout-use rule, failure handling, unknown-cost policy, and reward
scalarization reference so later execution cannot choose them after seeing results.

Define canonical hashing over the semantic spec without a self-hash, filesystem path, generated
timestamp, or Git stamp. Evaluator/rubric/pricing references are part of that hash. Git commit and
cleanliness are execution attestations linked later, not inputs that make the same spec hash
differ between machines.

#### D-MATRIX — ready

Generate a stable, sorted Cartesian product from benchmark cases, validated parameter points,
and zero-based repetition IDs. Derive each run ID from the study-spec hash plus semantic case,
configuration, and repetition identities—not input-array positions or execution order. Preserve
the full preimage in the run specification so a hash is never the only explanation of a run.

Test reordered inputs, duplicate values, invalid parameter combinations, hash collisions via an
injected hash fake, and stable output ordering. Holdout cases should be excluded from the
selection matrix unless the preregistered spec explicitly defines a separate final-evaluation
matrix.

#### D-EXECUTOR — ready, but budget concurrency needs a reservation rule

Each run must own fresh agent instances, writer, and artifact directory. Resume only a validated
terminal artifact whose run/spec hashes match; file existence alone is not completion. Use an
atomic claim/temporary-directory strategy so two workers cannot execute the same run ID, and
publish the final location only after closure.

Bounded concurrency can overspend an aggregate study budget if workers are dispatched against
stale totals. Either reserve each run's maximum declared budget before launch or define and test
a permitted overshoot bound. Continue after individual failures while preserving deterministic
result ordering, always release reservations/resources, and distinguish retryable interruption
from terminal run failure.

#### D-LOCAL-MODEL — ready as an opt-in route

Keep endpoint, provider ID, model ID, and any compatibility metadata in adapter/runtime
configuration. The test should skip clearly when the local endpoint or model is absent, use a
short timeout/output cap, and verify requested/response identities and control reporting without
assuming a particular Gemma build is installed.

Link the run to the explicit zero-cost local pricing entry, while making clear that zero API
price is not a claim about hardware/electricity cost. No localhost URL or local model name belongs
in domain defaults.

### Milestone E

#### E-DETERMINISTIC — ready

Define `EvaluatorPort` and a versioned evaluator result here so deterministic and judge-backed
evaluators share one domain boundary. Inputs are declared canonical events/artifacts, never
provider state or rendered Markdown. Each result records evaluator ID/version, score or
unavailable status, range/direction, and evidence event IDs.

Specify deterministic algorithms and missing-data behavior for every check. Missing token usage
must yield unavailable, not zero; completion comes from terminal events; latency comes from
recorded durations; repetition and contract-marker scores need locked normalization/tokenization
rules. Unit-test boundaries and empty/partial/failed runs.

#### E-RUBRIC — ready, and should define evaluation-record versioning

Version dimension IDs, descriptions, scales, direction, required evidence, and parsing schema.
Keep weights/scalarization outside the raw multidimensional judgment unless the rubric explicitly
versions them. Valid, malformed, and partial judge outputs must produce typed parse outcomes;
never fill a missing dimension with zero or silently discard unknown dimensions.

Also define the canonical evaluation record or assign that explicitly to E-JUDGE. It must link
the rubric and source run/artifact hashes and have space for declared judge inputs, exact prompt,
controls, raw response, parsed dimensions, and sanitized failure data.

#### E-JUDGE — ready after the evaluation record exists

Use a fresh or explicitly reset Pi-backed judge for every independent evaluation so no prior
candidate leaks into context. Build its exact message list only from the declared artifact
manifest, default to no tools, and record every message and control using the same observability
standards as debate agents. Preserve raw response even when parsing fails.

Resolve the `EvaluatorPort` result from the E-RUBRIC parser and write the linked evaluation
record atomically. Unit/contract tests use scripted responses; any provider smoke is separately
opt-in, budget-bounded, and not required for the task to pass.

#### E-RELIABILITY — tighten experimental design before spending

Split the work conceptually into an offline deterministic analyzer and an opt-in live collector.
The study spec must fix sample size, judges, candidate/model strata, permutations, random seed,
blinding labels, variance statistic, ordering-bias statistic, self-preference comparison, judge
disagreement statistic, and all thresholds before collection.

“Matching accepted artifact” must mean exact matches for rubric version, judge model(s), judge
prompt, controls, analysis version, and relevant sampling design. Missing/uncomputable threshold
data yields `rejected`. Store every randomized order and raw score vector, and ensure the
collector stops under the same attempt-inclusive turn/token/cost guardrails as other live work.

#### E-REWARD — ready after reliability semantics are fixed

Define whether reward is per run or an aggregate over cases/repetitions. Variance is an aggregate
term and cannot honestly appear in a single-run reward without group input. Preserve a versioned
reward vector with units, direction, missingness, and source evidence, plus a separately
versioned scalarization if the optimizer needs one number.

Use exact cost from the run snapshot and make unknown required components produce an unknown or
structured failure, never a zero contribution. Table-test normalization, weights, penalties,
boundary equality, missing components, and the difference between vector computation and
scalarization.

### Milestone F

#### F-OPTIMIZER-FIXTURE — clarify the implementation target, then ready

Use the optimizer library intended for F-OPTUNA—most likely pinned Python/Optuna—against a pure
deterministic objective without invoking the engine. This task proves seeded trial generation,
durable local storage, resume without duplicate trials, failure/pruning semantics, and
deterministic best-trial tie-breaking. It does not require a reliability artifact because no
model evaluation occurs.

Keep its temporary database and Python environment isolated from production study artifacts.
Avoid inventing a second generic optimizer framework in TypeScript unless a real second backend
requires that abstraction.

#### F-SCHEMA — ready after reward vector/scalarization is explicit

Publish one canonical schema artifact shared by TypeScript and Python fixtures. Specify exact
framing—one JSON value on stdin and one newline-terminated JSON value on stdout—plus schema
version, correlation/run ID, study-spec hash, run specification, success/failure discriminator,
reward vector, optional preregistered scalar objective, and artifact references. Forbid
`NaN`/infinity and unversioned free-form failures.

Clarify that one engine invocation executes one run. The Optuna bridge, not the engine schema,
aggregates cases and repetitions into a trial unless the study spec deliberately defines a
different unit. Test golden cross-language fixtures in addition to TypeScript round trips.

#### F-ENGINE-CLI — ready, but keep the process shell thin

Parse and validate stdin before constructing agents, keep stdout reserved for the single schema
response, and route diagnostics to stderr with secret-safe errors. The shell composes the domain
runner/evaluators, handles signals, disposes resources, and returns an artifact-backed structured
failure whenever possible. Assign stable meanings to exit codes and test them with injected
scripted factories.

Validate artifact paths against traversal/collision, stamp both spec hash and code Git commit,
and enforce the clean/committed preregistration rule before a real run. The explicit development
override must appear in canonical output. This task has many cases; implement them incrementally
under the one stable task ID while keeping domain code free of process/Git concerns.

#### F-OPTUNA — ready after the schema has cross-language fixtures

Invoke the engine with an argument array and JSON stdin, never shell interpolation. Capture
stdout/stderr separately, enforce timeout/cancellation, validate exactly one schema response,
and retain artifact/error references for missing, malformed, mismatched, or nonzero-exit output.
Test with a fake executable implementing the golden fixtures.

The study spec must predeclare how structured engine failures map to failed trials, pruned trials,
or penalties. Aggregate the configured cases/repetitions into the preregistered vector and
scalar objective without dropping failed runs or recomputing historical costs.

#### F-STUDY — execution-ready only after an accepted reliability artifact and preflight

Before any paid calls, verify a committed/clean study spec, matching accepted reliability
artifact, immutable pricing snapshot, available cases/models/credentials, artifact capacity,
declared maximum spend/tokens/turns, and code commit. The user must explicitly authorize the live
study and its budget at execution time.

Use multiple benchmark cases and repetitions for selection, keep holdout artifacts unread by the
optimizer, and stop according to the preregistered rule. Persist model response identities,
attempt usage, environment/tool versions, spec hash, and Git commit with every trial. Unknown
cost or a reliability mismatch fails closed unless the committed spec already permits the exact
exception.

#### F-REPORT — ready after a preregistered holdout comparison

Generate the report from validated canonical artifacts with a versioned analysis, not by
scraping transcripts or rerunning selectively. Compare baseline and selected protocol on the
same holdout cases/repetitions, disclose sample sizes, missing/failed runs, paired uncertainty,
quality dimensions, cost, latency, variance, and every evaluator used.

Any “better” claim must satisfy the study's planned analysis and reliability gates and must not
rest only on benchmark topics or the selecting judge. Link the report to study/spec/code/pricing/
rubric/reliability hashes, label exploratory findings, and run the repository's Markdown style
gate on the generated artifact.

## Round 4 — 2026-07-19, after third revision

All round-3 findings were addressed (log at bottom). **Verdict: the plan is ready to execute from
A-HARNESS.** The remaining comments are polish; none blocks starting.

- **`reasoningTokens` has no pricing rule.** The frozen usage shape includes `reasoningTokens`,
  but D-PRICING lists only input/output/cache rates. Providers differ: some bill reasoning as
  output tokens, some separately, some not at all. Without a rule, the same usage record can
  price two ways. Add to the snapshot either a reasoning rate or an explicit
  included-in-output/unbilled marker per model, so cost stays deterministic.
- **F-ENGINE-CLI now strains working rule 7.** It defines and versions the interchange schema,
  builds the executable, owns git stamping, and carries seven contract-test dimensions — that is
  several commits, not one. The plan's own rule says split it: a small F-SCHEMA task (schema +
  version tests) followed by F-ENGINE-CLI (executable implementing it) is the natural cut.
- **C-FAILURES tests cost-budget exhaustion before cost exists.** Monetary cost arrives with
  D-PRICING, a milestone later. Either scope C-FAILURES to token/turn budgets and add the
  monetary row when D-PRICING lands, or note that its "cost" rows use a stub price so the test
  intent is clear at execution time.

### Verified as genuinely resolved, not papered over

- The fails-closed rule in D-PRICING (missing priced token kind → cost `unknown`, monetary
  enforcement blocks unless the study spec permits token-only accounting) is exactly the right
  default for a lab that makes cost claims.
- The deterministic `accepted`/`rejected` derivation in E-RELIABILITY removes the
  "accepted by vibe" problem entirely; the gate is now mechanical.
- Moving schema definition ahead of the F-OPTUNA fake fixes the round-3 ordering contradiction
  cleanly — the fake now has a schema to conform to.

### Where the next feedback comes from

Nothing further at the plan level once the three polish items are folded in. The next real
feedback loop is execution: run A-HARNESS, then let A-PI-SPIKE's measured findings test ADR-0001
against reality — that spike is the first point where the plan's assumptions about Pi (control
availability, attempt observability, conversation retention) meet evidence.

## Round 3 — 2026-07-18, second revision (all resolved)

1. **Interchange schema implemented before defined** (F-ENGINE-CLI vs F-OPTUNA ordering) →
   schema definition moved into F-ENGINE-CLI; F-OPTUNA now consumes it.
2. **Usage granularity unspecified** → token kinds named and frozen in A-AGENT-PORT, C-EVENTS,
   and ADR-0001, with absent-not-zero semantics; D-PRICING fails closed on missing kinds.
3. **No acceptance mechanism for the reliability artifact** → deterministic `accepted`/`rejected`
   status derived from preregistered thresholds in D-STUDY-SPEC.
4. Smaller: evaluator refs in the study spec declared opaque until resolution; per-run budget
   halting assigned to the domain loop in C-FAILURES; git introspection confined to the
   CLI/executor layer; milestone letters declared historical in rule 9; live-smoke overlap
   resolved — C-LIVE-ARTIFACT reuses and supersedes the B-LIVE-DEBATE harness.

## Implementation reviews

Per-task reviews of executed work, per the plan's "review the diff after each green task" rule.

### A-HARNESS (`02a474e`) — pass

All three commands verified green, independently, with no credentials. Toolchain pinned
consistently (Bun 1.2.11 in `packageManager` and CI); TypeScript beyond strict
(`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`); ESLint
`strictTypeChecked` with the project service; CI runs the identical commands with a frozen
lockfile. The original open item is now resolved: the repository has an `origin`, and the
[Milestone A completion run](https://github.com/vd1/heated-debate-v2/actions/runs/29684875641)
passed install, test, type checking, and linting on GitHub Actions. Trivial: no Bun cache or
concurrency cancellation in the workflow; fold those in only when the workflow is next touched.

### A-PI-SPIKE (`12d0756`) — pass, with three carry-forwards

Every "prove" item is covered offline, and ADR-0001 moved to Accepted on measured findings, the
honest kind: Pi's low-level `Agent` has no dispose (adapter must synthesize
abort → waitForIdle → unsubscribe → reset); `temperature`/`maxTokens` must be injected by the
stream wrapper, not the `Agent` constructor; control forwarding proves nothing about provider
honoring, marked `verification: "request-only"`. Dependencies exact-pinned at 0.80.10.
Carry-forwards raised: (1) replace the plan's "requested and effective" language with the
five-state taxonomy; (2) define a zero-vs-absent rule, since `pi-ai` usage fields are
non-optional numbers; (3) delete `spikes/` when A-PI-ADAPTER lands. **All three were folded into
the plan/ADR/AGENTS.md in `7f66eb9` before the next task — resolved.** Minor, accepted as-is:
temperature-unsupported detection is Anthropic-specific; the `ModelRuntime` test's assertion is
weak (the substance is offline `create()` succeeding).

### A-AGENT-PORT (`d8c0bfa`) — pass, two forward-looking notes

"Done when" holds in its strongest form: `src/domain/agent.ts` has zero imports of any kind.
The zero-vs-absent rule got a real mechanism — `UsageObservation` separates values from an
`explicitlyReported` evidence list, and `normalizeUsage` is tested on all three branches
(positive without evidence kept, explicit zero kept, ambiguous zero dropped) plus input
validation. The five-state `ControlTrace` makes the taxonomy structural; "effective" no longer
exists in the codebase. Notes for later tasks, neither blocking:

1. **`ControlTrace` permits contradictory states** (`unsupported` and `forwarded` can coexist).
   Before C-EVENTS freezes the shape into the canonical schema, add a validation function or
   restructure as a discriminated union so contradictions are unrepresentable.
2. ~~`ScriptedAgent.requests` stores requests by reference.~~ Resolved in `1dc7795` by cloning on
   capture, with a regression test that mutates the caller's request after `reply`.

### A-PI-ADAPTER (`48c65b2`) — pass, with two later-schema carry-forwards

The adapter matches the scripted domain contract without a provider call and keeps all Pi types
behind infrastructure. Tests prove prompt/system/tool-policy forwarding, normalized output and
usage, requested/forwarded/adjusted/unsupported/provider-verified control states, multiple
observable HTTP responses, ambiguous-zero removal, conversation retention, active-turn abort,
and synthesized disposal. The adapter accepts a tool registry and resolves request allowlists
rather than hard-coding no tools. The disposable spike and its dedicated test were deleted, and
the tsconfig no longer includes `spikes/`.

Attempt accounting is honest about the available evidence: pre-final observed responses receive
empty usage, the final response receives normalized final-message usage, and no hidden retry
usage is invented. Provider verification is added only from `responseModel`. The contract test's
fake supplies explicit zero-reporting evidence, so positive, explicit-zero, and ambiguous-zero
semantics agree with `ScriptedAgent`.

Two issues are deliberately carried forward; neither blocks B-EXCHANGE:

1. When `agent.prompt` throws, `runReply` clears `activeResponses` and rethrows, so failed replies
   cannot yet expose partial attempts. C-FAILURES already requires a normalized typed failure or
   attempt observer and must close this gap before retry-inclusive failure budgets are claimed.
2. If Pi invokes no response hook, `buildTrace` correctly synthesizes one logical attempt but
   also synthesizes `httpStatus: 200` for success. HTTP status is observational data and should
   remain absent in that fallback. Add the missing-hook regression test and remove the invented
   status before C-EVENTS freezes the attempt schema.

### A-LIVE-TURN (`0a8230a`) — pass

The ordinary suite discovers the live test and skips it before creating `ModelRuntime` unless
`HEATED_DEBATE_LIVE=1`. Offline factory tests prove explicit model resolution, non-secret auth
status checking, clear missing-model/auth errors, and construction without a provider request.
The live turn uses the required default model unless explicitly overridden, fixes the prompt,
caps output at 128 tokens, races the reply against a 60-second timeout, and disposes in `finally`.
Its report contains only normalized model identity, controls, and usage.

The checked-in ADR records the opted-in observation: stored OAuth reached
`openai-codex/gpt-5.6-sol`, positive input/output usage was exposed, and no `responseModel` was
returned. The adapter therefore left provider verification absent rather than equating it with
forwarding. This review did not repeat the paid call; it verified the offline behavior
(16 passed, one live skip), type checking, linting, and the successful GitHub Actions run linked
above.

### Milestone A completion verdict — pass

All five task IDs meet their intended completion criteria, the domain remains Pi-independent,
the required suite is offline, and live authentication/model wiring now has one bounded opt-in
path. The two adapter carry-forwards are assigned to the schema/failure tasks that need them.
B-EXCHANGE can start; per the revised plan, B-CONTEXT must still land before B-ROUNDS.

### B-EXCHANGE (`8fe4c2b`, corrected by `52f3764`) — pass

The primary behavior is correct and well tested: one proposer turn precedes one reviewer turn,
turn IDs are deterministic, the complete reviewer request contains topic then proposal, controls
and the empty capability policy stay explicit, and the result keeps topic/proposal/review
structurally distinct. The implementation adds no roles, rounds, dials, persistence, or Pi
coupling. The result is recursively frozen, and the required suite, type checking, linting, and
[corrected GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29688465034)
are green.

The initial review found one immutable-snapshot defect: `runExchange` read mutable `input` fields
again after awaiting the proposer and did not clone the proposal reply until after awaiting the
reviewer. Direct probes reproduced both failures:

- mutating `input.topic` while the proposer was pending produced an original-topic proposer
  request, a mutated-topic reviewer request, and a mutated result topic;
- mutating the returned proposal during the reviewer call left the reviewer request containing
  the original proposal while `result.proposal.reply.text` recorded the mutated proposal.

Resolved in `52f3764`: the function now captures exchange ID, topic, systems, agent references,
and cloned controls before its first await; snapshots each request before dispatch; clones each
reply at its resolution boundary; and builds the reviewer prompt from the proposal snapshot. The
new deferred-agent regression test mutates the input identity/topic/reviewer configuration and
both reply objects across the two awaits, proving the recorded requests and frozen result retain
the original values. The full suite passes 19 tests with one intentional live skip, and type
checking and linting remain green. B-ROLES is unblocked.

### B-ROLES (`eb4d00c`) — pass

The task establishes a domain-owned `RoleDefinition` with stable ID, explicit version, and exact
system prompt. `defineRole` returns a defensive frozen copy, and both built-in v1 roles are
locked by exact-text tests plus runtime `Object.isFrozen` assertions. All fields are primitive,
so shallow freezing is sufficient for the current role shape.

`TurnRequest` now carries the complete role snapshot rather than a bare system string.
`runExchange` clones each participant role before its first await, records it in both immutable
request snapshots, and keeps role assignment separate from `RequestedControls` and the
`AgentPort`. `PiAgent` consumes only `request.role.systemPrompt`; role IDs/versions remain domain
data and no Pi type enters the role module. Existing agent, exchange, adapter, and live-smoke
fixtures were migrated without changing their behavior.

The required suite passes 22 tests with one intentional live skip; type checking and linting are
green, as is the
[B-ROLES GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29691240654).
No corrective carry-forward is needed. B-CONTEXT is next and must make the exact ordered
model-input messages explicit before B-ROUNDS.

### B-CONTEXT (`675df68`) — pass

The new domain-owned `ContextDecision` records policy ID/version and the exact ordered normalized
messages. `selectLastExchangeContext` is a pure policy with separate proposer/reviewer inputs;
tests lock first-turn behavior and the stable inclusion order of topic, own prior response,
counterparty response, and current proposal. Version 1 deliberately materializes those selected
sections into one user message, and the decision, message array, and message are frozen.

`TurnRequest` now carries that complete decision instead of an unstructured prompt. `runExchange`
uses the policy for both turns and retains the decision in its immutable request snapshots.
`PiAgent` always replaces its internal transcript with the selected prefix, converts normalized
assistant/user messages at the adapter boundary, and sends the selected final user message. The
two-turn adapter regression asserts the exact second-turn message contents, proving the first
Pi turn cannot leak through retained history. Empty selections and selections not ending in a
user message fail clearly at synchronization, and ADR-0001 now documents reset/replay as the
current mechanism rather than implicit persistence.

The domain context module has no Pi dependency. The required suite passes 26 tests with one
intentional live skip; type checking and linting are green, as is the
[B-CONTEXT GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29692124192).
No corrective carry-forward is needed. B-ROUNDS is unblocked, but it must obtain every later-turn
input through this policy rather than assembling additional prompt text itself.

### B-ROUNDS (`62c6911`) — pass

`runDebate` validates a positive integer round count before dispatch, snapshots debate identity,
topic, roles, and controls before its first await, and runs exchanges sequentially. Round and
turn IDs are deterministic, each round produces exactly proposer then reviewer, and the frozen
chronological result contains the structurally distinct exchange snapshots. With no failure,
the loop therefore dispatches exactly `2 * roundCount` requests.

Only the immediately completed proposal/review pair becomes `PriorExchange` for the next round.
`runExchange` maps that pair into the existing proposer/reviewer `last-exchange` policy inputs
and does not assemble context outside the policy. The two-round test asserts all four complete
context decisions in order; the three-round test proves round-one proposal/review text is absent
from both round-three requests. Combined with B-CONTEXT's adapter synchronization contract, old
Pi transcript state cannot add undeclared exchanges.

Invalid zero, negative, and fractional round counts are rejected before either agent is called.
The task adds no dials, persistence, live calls, or premature failure semantics. The required
suite passes 29 tests with one intentional live skip; type checking and linting are green, as is
the [B-ROUNDS GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29693263516).
No corrective carry-forward is needed. B-DIAL is unblocked.

### B-DIAL (`9fe2d26`, corrected by `9d9c943`) — pass

The pure schedule calculation is correct and remains independent of provider sampling controls.
Its tests lock `[5]`, `[5, 1]`, `[5, 3, 1]`, and `[5, 4, 3, 2, 1]`, all five instruction
strings, schedule identity/version, frozen selections, and invalid count/index boundaries.
`runDebate` selects once per round, both turns record creativity separately from their context
messages, and the debate regression proves temperature does not cool with the prompt dial.

Two corrections are required:

1. `runExchange` clones `input.creativity` once, exposes that object in the proposer request, and
   reuses it to construct the reviewer request after awaiting the proposer. A direct mutating-agent
   probe changed the exposed proposer selection from level 5 / `"original"` to level 1 /
   `"mutated"`; the stored proposer snapshot retained the original selection, but the reviewer
   received level 1 and its prompt began `[Creativity: 1/5] mutated`. This violates the established
   async snapshot boundary and lets one agent alter a later turn. Keep an unexposed master snapshot
   and give each request/context an independent clone, then add a deferred or mutating-agent
   regression that proves both turns retain the selected round value.
2. The exact prompt provenance is unresolved. The two v1 sources already disagree:
   `../heated-debate/shelley.ts` adds a no-code-diffs sentence at level 1, while
   `../heated-debate/later/dials.py` uses a different convergence instruction; both say
   `"Tighten the spec."` at level 2. B-DIAL instead records a third set under
   `scheduleVersion: "1"` (`"Tighten the specification."` and a shortened Shelley-derived level
   1). Choose and document the authoritative v1 source and port its exact strings, or explicitly
   define this as a new v2 prompt schedule with an appropriate identity/version. Keep exact-text
   tests for the resulting choice.

The initial required suite passed 41 tests with one intentional live skip; type checking, linting,
commit whitespace validation, and the
[B-DIAL GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29693879112)
were green, but those checks did not exercise the cross-turn mutation above.

Resolved in `9d9c943`: `runExchange` retains an unexposed creativity snapshot and gives each
`TurnRequest` an independent clone. The new mutating-agent regression changes the proposer copy
and proves the stored proposal selection, reviewer selection, and reviewer prompt all retain the
original round value. ADR-0002 now names Shelley's active TypeScript `DIAL_PROMPTS` as the v1
authority, explains why `later/dials.py` is excluded, and requires a new version for future
wording changes. Levels 2 and 1 now exactly match Shelley, and the existing exact-text tests lock
that choice.

The corrected required suite passes 42 tests with one intentional live skip; the targeted
mutation regression, type checking, linting, commit whitespace validation, and the
[corrected GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29694117580)
are green. Both findings are closed. B-DIAL passes and B-LIVE-DEBATE is unblocked.

### B-LIVE-DEBATE (`dac4d2f`, corrected by `5130a6a` and `6dd2db8`) — pass

The basic smoke path is sound. It is gated by `HEATED_DEBATE_LIVE=1`, defaults to
`openai-codex/gpt-5.6-sol`, accepts provider/model overrides, constructs separate proposer and
reviewer `PiAgent` instances, and runs the real two-round domain scheduler. Assertions cover four
ordered turn IDs, `[5, 5, 1, 1]` creativity, versioned context decisions, prior-response
inclusion, non-empty completed replies, model identity, observable attempts, and normalized
usage. A harness timeout bounds the debate calls, and ADR-0001 records the observed default-route
behavior without claiming that forwarding proves enforcement.

Three corrections are required:

1. The control assertions are not valid for all supported model overrides. They require
   `thinkingLevel: high` and `maxOutputTokens: 128` to be forwarded unchanged, although
   `PiAgent` correctly reports unsupported thinking for a non-reasoning model and adjusts an
   output limit above model metadata. Validate every requested control and the applicable trace
   invariants instead: unsupported excludes forwarding/adjustment/verification, adjustment
   matches the forwarded value, and provider verification is optional but must match the
   observed response identity. Keep unsupported and adjusted branch mechanics in the offline
   adapter tests, as the forward review requires.
2. Clean disposal is attempted but not verified. `Promise.allSettled` discards both cleanup
   outcomes, so the live test can pass after either `dispose()` rejects. Agent creation also
   occurs before the `try`, allowing the proposer to leak if reviewer construction fails. Track
   each acquired agent inside the lifecycle guard, require every disposal to fulfill, and assert
   the exposed disposed/reset state after real latency.
3. `tests/live/support.ts` shares only constants and `withTimeout`; the actual runtime creation,
   two-agent setup, controls, `runDebate` call, and cleanup remain embedded in the test. Thus the
   shared live-debate harness required by the task does not yet exist, and C-LIVE-ARTIFACT would
   have to duplicate or first refactor this path. Extract a reusable runner that returns the
   complete in-memory result and owns lifecycle cleanup; have this smoke invoke it so the later
   artifact smoke can extend the same path.

The offline suite passes 42 tests with both live tests intentionally skipped; type checking,
linting, commit whitespace validation, and the
[B-LIVE-DEBATE GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29697968901)
are green. CI is also skip-only for the live path. This review did not repeat the opt-in provider
calls. Keep B-LIVE-DEBATE active, and do not start C-EVENTS or claim Milestone B complete until
the three lifecycle/harness corrections are resolved and re-reviewed.

Re-review of `5130a6a`: findings 2 and 3 are closed. `runLiveDebateHarness` now acquires agents
inside its guarded lifecycle, disposes every acquired agent even after partial setup or run
failure, propagates individual or aggregate cleanup failures, and returns disposed/reset state
for the live assertion. The offline partial-acquisition regression proves the proposer is
disposed if reviewer creation fails. The extracted runner owns model/runtime setup, controls,
timeouts, the domain call, cleanup, and the complete in-memory result, giving C-LIVE-ARTIFACT one
path to extend rather than copy.

Finding 1 is only partially resolved. The new `assertControlTrace` checks unsupported-state
exclusivity and adjusted/forwarded equality, but it still accepts an unresolved trace containing
only `requested`, or a silently changed `forwarded` value without `adjusted`. It also replaced
the earlier exact forwarded-model assertion with that permissive helper. Require every
non-unsupported requested control to have `forwarded`; when `adjusted` is absent, require
`forwarded` to equal `requested`; when adjustment is present, require `forwarded` to equal the
adjusted value. This will accept legitimate unsupported/adjusted overrides while rejecting
unreported or silently altered controls, and will again prove that the selected model identity
was forwarded.

The corrected offline suite passes 43 tests with two intentional live skips; type checking,
linting, commit whitespace validation, and the
[correction GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29698277421)
are green. This re-review did not repeat the opt-in provider calls. Keep B-LIVE-DEBATE active and
C-EVENTS blocked until the remaining control-trace assertion is corrected and re-reviewed.

Final re-review of `6dd2db8`: finding 1 is closed. Unsupported traces return only after proving
that forwarding, adjustment, and provider verification are absent. Every supported trace must
now contain `forwarded`; an unadjusted value must equal `requested`, while an adjusted value must
equal the recorded adjustment. The same invariant restores proof that the selected override
model identity was forwarded, without rejecting legitimate unsupported-thinking or
adjusted-output-limit states.

The final offline suite passes 43 tests with two intentional live skips; type checking, linting,
commit whitespace validation, and the
[final GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29698392984)
are green. The opt-in provider calls were not repeated for this assertion-only correction. All
three findings are closed: B-LIVE-DEBATE and Milestone B pass, and C-EVENTS is unblocked.

### C-EVENTS (`e13b552`, corrected by `e2625ff`) — pass

The core shape is strong. `CanonicalEvent` is a seven-member discriminated union with a common
schema version, run ID, zero-based sequence, event type, and event-specific data. Turn requests
carry round/turn/role identity, the complete versioned context decision and exact messages,
creativity, requested controls, and capabilities. Separate attempt events retain status,
observable HTTP status, normalized usage, and evidence; completion/failure events link by turn
ID. The Pi correction also stops inventing HTTP 200 when no response hook was observed.

Validation rejects unknown event/schema versions and fields, contradictory or unresolved
control traces, silent adjustments, invalid numbers, and ambiguous zero usage. Failure payloads
exclude arbitrary objects and stacks, while the free-form text test correctly avoids claiming
that user/model prose is secret-free. Three serialization-boundary corrections remain:

1. Failure sanitization is optional rather than enforced. `SanitizedFailure` is a public
   structural interface, and `serializeCanonicalEvent` has no configured-secret input or proof
   that `sanitizeFailure` produced the value. A direct `run.failed` event whose failure message
   contained `"configured-secret-123"` serialized that sentinel unchanged. Make raw failures
   unable to enter the serialization path, or make serialization redact/reject configured
   secrets in the structured failure fields. Add a regression that constructs the failure event
   directly; retain the explicit exemption for free-form user/model text.
2. Runtime validation does not validate the representation that is actually serialized.
   Required fields are checked with the prototype-aware `in` operator, so an event whose entire
   envelope is inherited passes and serializes as `{}`. An otherwise valid event with an
   inherited `toJSON` also passes validation and serialized as
   `{"credentials":"configured-secret-123"}` in a direct probe. Require plain records and own
   required fields, then serialize a validated plain snapshot or validate the serialized
   representation. Lock both inherited-field and `toJSON` cases with sentinel regressions.
3. The runtime compatibility rule and declared type disagree for creativity. The validator
   accepts arbitrary non-empty `scheduleId` and `scheduleVersion`, but then asserts the narrower
   domain `CreativitySelection` whose only valid values are `"linear-cooling"` and `"1"`.
   `parseCanonicalEvent` therefore accepted `"unknown"@999` while returning a type that says this
   is impossible. Either enforce the current literals for schema v1 or define an explicit
   canonical creativity type that permits other identifiers; test the selected compatibility
   rule. The closed-union round-trip table should also include the currently untested
   `run.failed` discriminant.

The required suite passes 51 tests with two intentional live skips; the focused event/adapter
suite, type checking, linting, commit whitespace validation, and the
[C-EVENTS GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29698772760)
are green. Those checks do not cover the reproduced boundary cases above. Keep C-EVENTS active
and C-JSONL blocked until all three findings are resolved and re-reviewed.

Resolved in `e2625ff`: serialization now requires the configured-secret list, snapshots the
validated event, redacts structured failure code/message fields, revalidates the snapshot, and
validates the actual serialized representation. Directly constructed failure events can no
longer leak the sentinel, while free-form user/model messages remain unchanged as explicitly
intended.

Record validation now requires plain objects and own required/optional properties. Both the
inherited-envelope and inherited-`toJSON` probes fail before serialization, with dedicated
regressions. Schema v1 now enforces `linear-cooling@1`, aligning the runtime assertion with
`CreativitySelection`, and both failure discriminants are round-tripped. Re-running all three
original probes confirmed redaction or rejection at the intended boundary.

The corrected suite passes 54 tests with two intentional live skips; the focused event suite,
type checking, linting, commit whitespace validation, and the
[corrected GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29704248259)
are green. All three findings are closed. C-EVENTS passes and C-JSONL is unblocked.

### C-JSONL (`04e4f13`, corrected by `9638254` and `d29734e`) — pass

The basic writer path is well structured. It opens a new file in exclusive append mode, copies
the secret configuration, validates and snapshots each event before queueing, and serializes
exactly one newline-terminated event per append. One promise queue preserves invocation order
without allowing a rejected operation to break later queue scheduling. Sequence and run-ID
checks occur inside that queue before the event's bytes are appended. `flush` queues an `fsync`,
and `close` stops new work, drains earlier operations, syncs, closes, and reuses one close promise.

The reader validates every newline-committed record and the complete prefix's canonical
run/sequence. Three corrections are required:

1. Interrupted-tail state is silently discarded. `readCanonicalJsonl` removes every
   non-newline-terminated final segment and returns only `CanonicalEvent[]`, so callers cannot
   tell a clean file from an interrupted one. Direct probes showed that both a complete valid
   event missing only its newline and malformed `"{not-json"` return the same empty array.
   Return explicit tail/interruption status (without treating it as a committed event), while
   continuing to throw line-located corruption for invalid newline-terminated records in the
   middle. Test clean EOF, a valid-but-uncommitted tail, an incomplete tail, and middle
   corruption.
2. An append I/O failure leaves the writer open with the same expected sequence. In an injected
   probe, the first append wrote `"{\"partial\""` and rejected; retrying sequence 0 then appended
   the full record and newline, converting the interrupted tail into committed invalid JSON.
   Treat any append failure as terminal/poisoned so later appends cannot write behind possibly
   partial bytes, while still permitting reliable close/cleanup. Add an injected file-I/O seam
   and lock partial-write, failure propagation, subsequent rejection, and final-prefix
   readability.
3. Required lifecycle behavior is implemented but not actually isolated by the tests. The flush
   test awaits every append before calling `flush`, so it does not prove that flush drains
   pending work; close draining is tested, but repeated/idempotent close is not. Use the same
   deterministic I/O seam to prove queued append → flush → sync order, close idempotence, and the
   middle-corruption behavior required by the forward review.

The current suite passes 59 tests with two intentional live skips; the focused JSONL suite,
type checking, linting, commit whitespace validation, and the
[C-JSONL GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29704457309)
are green. Those checks do not cover the reproduced failure modes above. Keep C-JSONL active and
C-REPLAY blocked until all three findings are resolved and re-reviewed.

Re-review of `9638254`: the three original findings are closed. The reader now returns committed
events plus explicit clean/interrupted tail status and distinguishes valid-uncommitted,
invalid-event, and invalid-JSON tails; committed middle corruption remains a line-located error.
The injected I/O boundary proves pending flush order and idempotent close. Append failure now
poisons the writer before any queued/later append can write, while `close` still syncs and
releases the handle; the partial-write regression retains a readable committed prefix and an
explicit interrupted tail.

One reader-integrity correction remains. `readFile(path, "utf8")` performs replacement decoding
before records are validated. A direct probe inserted byte `0xC3` inside a newline-committed
topic string; the reader accepted the event and silently changed the canonical topic to Unicode
replacement character `U+FFFD` instead of reporting corruption. Replacement decoding can also
make interrupted-tail `byteLength` differ from the bytes actually present when a write ends
mid-codepoint. Read raw bytes, split on the newline byte, and decode each committed record with
fatal UTF-8 validation; report invalid UTF-8 with its line number. Classify an invalid/truncated
UTF-8 tail explicitly and calculate its length from the original bytes. Add regressions for both
a committed invalid UTF-8 record and a tail ending inside a multibyte sequence.

The corrected suite passes 63 tests with two intentional live skips; the focused JSONL suite,
type checking, linting, commit whitespace validation, and the
[correction GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29704844194)
are green. Keep C-JSONL active and C-REPLAY blocked until this final byte-level corruption gap is
resolved and re-reviewed.

Final re-review of `d29734e`: the byte-level finding is closed. The reader now splits the raw
buffer on newline bytes and decodes each committed record with a fatal UTF-8 decoder, so invalid
encoding produces a line-located error rather than altered canonical text. Uncommitted tail
classification operates on the original bytes, adds an explicit `invalid-utf8` state, and
reports the exact stored byte length. The committed-corruption and truncated-multibyte
regressions lock both branches, and both original probes now produce the expected error/status.

The final suite passes 65 tests with two intentional live skips; the focused JSONL suite, type
checking, linting, commit whitespace validation, and the
[final GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29704961121)
are green. All C-JSONL findings are closed. C-JSONL passes and C-REPLAY is unblocked.

### C-REPLAY (`d46fb37`, corrected by `abc5fdb`) — pass

The implementation validates the canonical sequence and successful-run shape, links attempts
and completions to the active turn, rejects duplicate turn IDs and incomplete or failed runs,
and checks the recorded terminal turn count. Replay remains offline: it never reaches Pi or a
provider. The recursive comparison checks complete structured `TurnRequest` values rather than
trusting a hash and reports the first mismatched path. Recorded reply text drives subsequent
context while observational reply data does not drive request construction.

Three corrections are required before C-LIVE-ARTIFACT:

1. Replay incorrectly requires the canonical envelope `runId` to equal the debate protocol's
   `debateId`. They are separately named and validated identifiers in the canonical schema; only
   the former identifies one event stream, while the latter seeds debate and turn identity. A
   direct valid one-round probe with `runId: "artifact-run-9"` and
   `debateId: "debate-1"` passed sequence validation but replay rejected it with
   `run ID artifact-run-9 does not match debate ID debate-1`. Remove this equality constraint,
   retain each identifier for its own purpose, and add a distinct-identities regression. The
   current fixture uses `"run-1"` for both and masks the bug.
2. Replay is implemented by constructing two `ReplayAgent` instances that implement
   `AgentPort`, passing them into `runDebate`, and allowing the full debate to dispatch before
   comparing requests. That violates the accepted C-REPLAY contract that replay feed replies
   directly into a pure debate scheduler and never call an `AgentPort`. Extract a pure
   scheduler/state transition that produces one request and consumes one supplied normalized
   reply. The production runner can dispatch each produced request through its port; replay
   should compare that request before supplying the corresponding recorded reply. This keeps
   replay structurally incapable of agent dispatch and establishes the boundary later tool
   replay depends on.
3. The test fixture covers only one round and therefore does not lock the core multi-round
   reconstruction or ordered prior-exchange context. Add a two-round replay and table-driven
   drift coverage for role identity/prompt, context policy ID/version, message order/content,
   controls, capabilities, and protocol configuration. Also prove that attempt/usage/latency
   changes are observational rather than semantic, and explicitly cover `turn.failed`,
   `run.failed`, and missing-terminal rejection. These are the acceptance dimensions named in
   the forward review, not optional hardening.

The current suite passes 71 tests with two intentional live skips; the six focused replay tests,
type checking, linting, domain/Pi boundary scan, commit whitespace validation, and the
[C-REPLAY GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29705231437)
are green. Those checks do not cover the reproduced identity failure or the required pure
scheduler boundary. Keep C-REPLAY active and C-LIVE-ARTIFACT blocked until all three findings
are resolved and re-reviewed.

Re-review of `abc5fdb`: all three findings are closed. Canonical `runId` now remains the artifact
stream identity while `debateId` independently drives protocol and turn identity; the dedicated
regression replays a valid trace whose identifiers differ.

The new domain `DebateScheduler` owns deterministic turn construction and state transitions
without an `AgentPort`. Production `runDebate` alone dispatches each scheduled request to the
selected agent, while replay compares each request before directly accepting the corresponding
recorded reply. Static boundary scans confirm that replay and scheduler contain no `AgentPort`,
`runDebate`, Pi, or Pi-package references. Existing debate and exchange behavior remains green
after the extraction.

Coverage now includes exact two-round reconstruction with ordered prior-exchange context,
distinct artifact/debate identities, and table-driven drift checks for role identity/version/
prompt, context policy identity/version, exact message sequence/content, controls,
capabilities, and run configuration. Separate regressions prove attempt/usage/latency data is
observational and reject turn failure, terminal run failure, missing terminal state, and an
uncompleted requested turn.

The corrected suite passes 77 tests with two intentional live skips; the 19 focused replay,
debate, and exchange tests, type checking, linting, boundary scans, commit whitespace
validation, and the
[corrected GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29705631666)
are green. C-REPLAY passes and C-LIVE-ARTIFACT is unblocked.

### C-LIVE-ARTIFACT (`05af69c`, corrections `ea1763b`, `c308710`, and `1b6cc55`) — pass

The implementation correctly extends the existing live-debate harness rather than creating a
second provider path. It retains the explicit opt-in gate, default model, two rounds, high
thinking, 128-token request, debate timeout, and lifecycle cleanup. The successful-result
projection records exact turn requests, every normalized attempt, control reports, replies, and
the terminal count under an independent artifact run ID. The smoke writes to a caller-selected
temporary path, closes the writer on write failure or success, reads and sequence-validates the
JSONL, checks a clean tail and event counts, replays the persisted requests, compares each
persisted attempt with the in-memory trace, and scans the raw artifact for configured secrets.

Two corrections are required before C-MARKDOWN:

1. Persistence occurs only after the entire debate has completed. `runLiveDebateHarness` awaits
   `runDebate`, then projects the final in-memory result, opens the writer, and appends all events
   in one post-run batch. A deferred-reviewer probe confirmed that the artifact path did not
   exist during the second turn and appeared only after the run returned. This does not exercise
   append-only persistence across turns or preserve a committed prefix if the live process is
   interrupted—the resilience C-JSONL was built to provide. Integrate a canonical event sink
   with the scheduler/run path: create the writer before dispatch, append `run.started` and each
   `turn.requested` at their actual boundaries, append observed attempts and completion after
   each reply, flush at a documented turn boundary, and close in `finally`. C-FAILURES can still
   add terminal failure semantics later; this task only needs to retain the valid incomplete
   prefix. Add an offline gated-agent test that inspects the file between turns and after
   interruption.
2. The claimed per-turn output cap is not effective on the required default route. The opt-in
   `openai-codex/gpt-5.6-sol` run requested and reported
   `maxOutputTokens: { requested: 128, forwarded: 128 }`, but its four observed output-token
   values were 1,100, 1,560, 943, and 1,059, with reasoning recorded as a subset. Inspection of
   the pinned Pi 0.80.10 Codex Responses path explains the result: `maxTokens` reaches
   `buildBaseOptions`, but the Codex request-body builder emits no `max_output_tokens` field.
   The live test checks only the control-trace shape and therefore passes despite being
   unbounded. The selected correction is an enforced 4,096-output-token cap per turn, replacing
   the impractically small 128-token request for this high-reasoning smoke. Make the
   adapter/provider capability report truthful and ensure the Codex request actually carries
   that limit (or enforce the same bound client-side); do not label an ignored option as
   supported. Add an offline payload-level regression and make the live assertion verify the
   selected cap semantics using the emitted request plus observable usage/termination evidence,
   without upgrading forwarding to provider verification.

The required offline suite passes 79 tests with two intentional live skips; the 26 focused
event-projection, harness, JSONL, and replay tests, type checking, linting, domain/Pi boundary
scan, commit whitespace validation, and the
[C-LIVE-ARTIFACT GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29706153426)
are green. I also ran the opt-in four-turn smoke against the default model: write/read/replay,
secret scanning, and cleanup passed in 90.8 seconds, but that run exposed the ineffective output
cap above. Keep C-LIVE-ARTIFACT active and C-MARKDOWN blocked until both findings are resolved
and re-reviewed.

Re-review of `ea1763b` and `c308710`: finding 1 is closed. `runDebate` now accepts a domain event
sink and emits and flushes `run.started`, each request before dispatch, each attempt/completion
batch, and the terminal completion at their actual execution boundaries. The live harness
creates the writer before calling the runner and closes it alongside agent cleanup. The
gated-reviewer regression observes a clean committed prefix through the second
`turn.requested`, injects an interruption, and proves that the same prefix remains readable
afterward.

Finding 2 is only partially closed. The adapter now correctly reports the Codex provider token
control as `unsupported`, and the payload regression proves that it does not claim to forward a
field omitted by the pinned Codex route. The selected live request is 4,096, and the repeated
default-model smoke completed with four reported output usages of 1,036, 1,230, 1,054, and 1,112
tokens.

However, the client mechanism reuses that token count as a 4,096-byte ceiling over observable
text/thinking/tool-call deltas. Bytes and tokens are different units, and hidden reasoning—the
same usage category recorded as part of total output tokens—is explicitly not observable to
this limiter. The final `outputTokens <= 4_096` assertion detects an overage only after the
provider has already generated and charged it; it does not enforce the chosen 4,096-token
per-turn budget. The derived byte control is also represented only in an unsupported-reason
string, rather than as a separately named and structured client control in the canonical run
record.

Retain the useful byte safety guard, but do not present it as the selected token cap. Establish a
provider or client mechanism that actually bounds total output, including hidden reasoning, at
4,096 tokens. If the default Codex subscription route cannot support that, explicitly revise the
accepted live-bound contract instead of silently changing units. Any separate observable-byte
limit must have its own name, unit, requested/applied status, and canonical representation.

The corrected offline suite passes 82 tests with two intentional live skips; the 38 focused
harness, adapter, debate, replay, and JSONL tests, type checking, linting, domain/Pi boundary
scan, and commit whitespace validation are green. CI passes for both the
[persistence correction](https://github.com/vd1/heated-debate-v2/actions/runs/29706707583) and
[4,096 update](https://github.com/vd1/heated-debate-v2/actions/runs/29733118120). The opt-in
four-turn smoke also passed write/read/replay, per-attempt equality, secret scanning, cleanup,
and its post-run usage assertion in 92.9 seconds. Keep C-LIVE-ARTIFACT active and C-MARKDOWN
blocked until the remaining token-bound mismatch is resolved and re-reviewed.

Final re-review of `1b6cc55`: the revised honest contract closes the remaining finding. The
observable-byte limiter and the post-generation token-overage assertion are gone. On the
required Codex route, `maxOutputTokens: 4_096` is retained as an auditable request and reported
only as unsupported; its trace contains no forwarded, adjusted, or provider-verified cap. The
adapter does not pass `maxTokens` to the stream on this route, and reported output/reasoning
usage remains observation rather than evidence of enforcement. ADR-0001 records both the live
provider probes and the requirement to use a different provider route for a true total-output
token limit that includes hidden reasoning.

The C-LIVE-ARTIFACT smoke is bounded by its two-round protocol and configurable 180-second
whole-debate test timeout, not by truncating an agent response. The separate 60-second timeout
applies only to the one-turn provider-connectivity smoke. Neither timeout establishes the
eventual production debate budget; cancellation and run-budget semantics remain assigned to
C-FAILURES and later configuration work.

The final offline suite passes 81 tests with two intentional live skips; type checking, linting,
commit whitespace validation, and the
[final GitHub Actions run](https://github.com/vd1/heated-debate-v2/actions/runs/29736852756)
are green for the exact reviewed commit. I independently repeated the opt-in persisted
two-round smoke against `openai-codex/gpt-5.6-sol` at high thinking: all four turns completed in
103.3 seconds, the canonical control traces matched the revised contract, and artifact
write/read/replay, per-attempt equality, secret scanning, and disposal passed. C-LIVE-ARTIFACT
passes and C-MARKDOWN is unblocked.

## Round 2 — 2026-07-18, first revision (all resolved)

1. **No real engine executable** (Optuna bridge tested only against a fake) → F-ENGINE-CLI.
2. **"Maximum estimated cost" had no pricing source** → D-PRICING (versioned snapshot, zero-cost
   local entry, snapshot hash recorded in artifacts).
3. **Evaluator reliability was live/paid but not opt-in** → E-RELIABILITY (skipped by default,
   guardrails enforced, versioned reliability artifact).
4. Smaller: live smoke never exercised persistence → C-LIVE-ARTIFACT; renumbering churn → stable
   slugs and working rule 9; Pi retries vs budgets → per-attempt accounting in ADR-0001 and
   A-PI-ADAPTER; "preregistered" needed a home → D-STUDY-SPEC; unconsumed dials (risk tolerance,
   deference, verbosity) → moved to the deferred list.

## Round 1 — 2026-07-18, initial plan (all resolved)

1. **No experiment runner between matrix generation and the real study** → D-EXECUTOR.
2. **First live debate ~28 tasks in** → B-LIVE-DEBATE at the end of Milestone B.
3. **Replay defined before tools existed** → C-TOOL-LOOP extends replay to tool-using runs.
4. **Toolchain unspecified; CI referenced but never created** → Task A-HARNESS (Bun 1.2+, strict
   TypeScript, `bun test`, ESLint, GitHub Actions).
5. Nits: Optuna interchange → versioned schema; secrets redaction → C-EVENTS invariant; cost
   guardrails → D-CONFIG; ritual red step → meaningful smoke assertion.

Round 1 also endorsed keeping the creativity dial (B-DIAL) separate from provider sampling
controls (D-CONTROLS), fixing v1's coupling of dial and temperature in `dials.py`.
