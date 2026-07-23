# D-CASES review

Status: pass

Reviewed on 2026-07-23.

`parseBenchmarkCase` parses untrusted JSON into a validated, frozen `case@1`: case ID, topic,
optional source context, an opaque versioned rubric reference resolved only when evaluation
begins, and mandatory provenance. Unknown fields and versions are rejected at both levels, and
`benchmarkCaseHash` gives a canonical key-sorted identity that distinguishes source-context
presence. Three tiny hand-written fixture cases ship with distinct IDs and round-trip through
the untrusted parser unchanged; no production corpus exists yet.

Validation completed successfully:

- Tests: 246 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.

D-CASES is complete. D-STUDY-SPEC is next.
