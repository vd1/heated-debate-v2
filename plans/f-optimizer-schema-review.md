# F-OPTIMIZER-FIXTURE and F-SCHEMA review

Status: pass

Reviewed on 2026-07-23.

F-OPTIMIZER-FIXTURE: a toy-objective loop proves trial generation, persistence, resume, and
best-trial selection with no model involvement. The trial sequence is a pure function of the
sampler seed over the finite grid, trials persist through the injected store after every
completion, resume skips completed trial IDs and executes only the remainder, objective
failures are recorded as failed trials without stopping the loop, and best-trial selection
considers only known results.

F-SCHEMA: the versioned JSON-over-stdio contract. One run specification (schema version,
validated study spec, run identity with parameter point and zero-based repetition) enters on
stdin; exactly one reward vector or structured failure exits on stdout as a single framed JSON
line. Tests cover canonical round trips, schema-version mismatch, malformed values, unknown
fields, and framing violations (multi-line output, trailing noise, empty output), all
independently of any process or model.

Validation completed successfully with real exit codes.

F-ENGINE-CLI is next.
