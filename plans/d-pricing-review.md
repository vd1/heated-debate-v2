# D-PRICING review

Status: pass

Reviewed on 2026-07-23.

The domain owns a versioned, validated, frozen pricing snapshot: provider/model identity,
input/output/cache rates per million tokens, an uppercase ISO currency, an ISO effective date,
provenance, and one reasoning billing rule per model. Snapshots hash deterministically over a
canonical key-sorted JSON form, so run artifacts can pin the exact table used. Deterministic
fixtures include a zero-cost local-model entry.

Usage-to-cost calculation is table-tested across all three reasoning modes. Reported reasoning
tokens are treated as a subset of output under `included-in-output` (billed once via output) and
`unbilled` (subtracted from billable output); `separate-rate` bills reasoning as disjoint tokens
at its own rate, so no mode can double charge. A token kind with a positive rate that is absent
from usage makes the cost `unknown` with the missing kinds listed; absence prices as zero only
when the rate itself is zero, which keeps the zero-cost local entry priceable from any usage.

The domain loop enforces an optional monetary budget tied to a snapshot. Canonical schema v6
records `monetary` run controls carrying the amount, currency, snapshot ID, version, and sha256
hash; historical v1-v5 artifacts migrate with `monetary: null` because the control did not
exist. Costs accumulate only from observed per-attempt usage priced against the run's immutable
snapshot; the loop stops at the first observable overage before or after a dispatch with
`monetary_budget_exhausted`. An attempt whose usage cannot be priced fails the run closed with
`cost_unknown` unless `permitTokenOnlyAccounting` is explicitly configured. A snapshot missing a
participant model is rejected before the run starts. Replay reproduces the monetary controls
from configuration and rejects snapshot-hash drift.

Validation completed successfully:

- Tests: 202 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.

D-PRICING is complete. D-CONFIG is next.
