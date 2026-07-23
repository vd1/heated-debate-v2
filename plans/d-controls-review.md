# D-CONTROLS review

Status: pass

Reviewed on 2026-07-23.

No control was added. The audit proves each existing dimension travels the full path from
validated `ExperimentConfig` through scheduling and the turn request, the adapter or project
dispatcher, the control report, and canonical events, with every stage asserted from one
recorded end-to-end run per dimension against a fake Pi stream.

- Thinking level, output limit, and temperature carry the provider taxonomy: the requested
  value appears in `turn.requested`, in the adapter's stream options, and in the
  `requested`/`forwarded` control report inside `turn.completed`.
- Temperature is audited separately from the creativity dial: varying temperature leaves the
  prompt instruction byte-identical, so the two cannot recouple.
- Creativity materializes as an exact prompt instruction inside the selected model input and
  the forwarded provider prompt; it never appears in the provider control report.
- Tool allowlists are recorded exactly in the turn request; definitions are forwarded for the
  model while execution stays with the project dispatcher, and the provider control report
  never mentions tools, so neither prompt dials nor allowlists can receive fictitious provider
  verification.

`MATRIX_ELIGIBLE_CONTROL_DIMENSIONS` (control-dimensions@1) declares exactly the five audited
dimensions with their enforcement class, and the audit test pins that list, so D-MATRIX can
only vary dimensions whose propagation is proven.

Validation completed successfully:

- Tests: 229 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.

D-CONTROLS is complete. D-CASES is next.
