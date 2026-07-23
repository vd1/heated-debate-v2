# D-CONFIG review

Status: pass. Codex concerns 23-28 are resolved; canonical identity derives from the validated source input.

Reviewed on 2026-07-23.

`parseExperimentConfig` parses untrusted JSON into a validated, deeply frozen configuration; no
value is cast past a runtime check. The config carries a stable run ID, topic and optional case
reference, round count, the explicit `last-exchange@1` context policy, immutable role
definitions with per-role agent/model assignments, per-turn controls, optional tool capability
policies resolved against each role and phase, timeouts, and a `RunBudget` for turns and tokens
with an optional monetary limit tied to a validated pricing snapshot.

Covered behaviors: defaults materialize to `openai-codex/gpt-5.6-sol` at thinking `high`;
unknown fields at any level and unknown config versions are rejected; omitted values default
while explicit values persist, with per-role overrides winning over config-level controls;
cross-field constraints reject invalid round counts, out-of-range temperatures, partial
budgets, and a whole-run timeout smaller than the per-turn timeout; monetary snapshots must
price both assigned models; canonical JSON round-trips byte-identically and hashes
deterministically for later matrix/study identity. Pricing snapshot parsing was hardened to
reject unknown fields and malformed entry shapes for the untrusted path.

`experimentDebateInput` maps a config onto the domain runner, and a retry-inclusive test proves
config budgets count every observed attempt, not only successful ones. Aggregate study
concurrency and budgets remain out of scope for D-STUDY-SPEC/D-EXECUTOR.

Validation completed successfully:

- Tests: 223 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.

D-CONFIG is complete. D-CONTROLS is next.
