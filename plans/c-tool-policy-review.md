# C-TOOL-POLICY review

Status: pass

Reviewed on 2026-07-22.

The domain now owns a validated, versioned tool capability policy. Each recorded policy binds to
an exact role and protocol phase and contains tool IDs with schema versions, aggregate and
per-tool call limits, a call timeout in milliseconds, a result limit in bytes, and an explicit
denied-call charging rule. Policies are snapshotted and frozen before they enter a turn request.

Authorization and accounting are pure domain operations. Authorization returns a new immutable
accounting snapshot. An accepted call consumes its aggregate and per-tool allowance before
execution, so later failure or timeout cannot avoid the charge. A denied call is recorded and
does not consume allowance unless the policy selects aggregate charging.

The request and artifact paths preserve policy evidence:

- Debate scheduling and direct exchanges resolve policies separately for proposal and review.
- Canonical schema v3 records the complete policy in every new turn request.
- Schema-v1 and schema-v2 name allowlists migrate to an unrecorded legacy form. No schema,
  timeout, byte limit, or call limit is invented.
- Replay accepts an empty historical allowlist but rejects a non-empty legacy allowlist because
  its missing policy evidence prevents deterministic reconstruction.
- Markdown projection displays recorded policy limits and labels migrated legacy evidence.

Pi tool registration is keyed separately by tool ID and schema version. A non-empty policy is
blocked before provider dispatch until C-TOOL-LOOP installs the project-owned dispatcher. This
prevents direct Pi execution from bypassing policy accounting, timeouts, result limits, and
canonical tool traces.

Validation completed successfully:

- Tests: 123 passed. Live tests: 2 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.
- Git whitespace validation: passed.
- Generated artifact style gate: passed.

C-TOOL-POLICY is complete. C-TOOL-LOOP is next.
