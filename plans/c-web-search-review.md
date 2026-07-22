# C-WEB-SEARCH review

Status: pass

Reviewed on 2026-07-23.

The domain owns a provider-independent `WebSearchPort`: a query with an optional result cap
produces a normalized response carrying the query, a retrieval timestamp from an injected clock,
provider/endpoint provenance, titled results with URLs and snippets, and an explicit truncation
record of available versus returned results. No HTTP or Pi type appears in the domain module.

The HTTP adapter is contract-tested against a fake backend: request formation, result
normalization, non-success statuses, and malformed payloads all produce typed outcomes. The API
key travels only as an Authorization header; sentinel tests prove it reaches neither the
response evidence nor error messages. The Pi tool registration wraps the port as
`web-search@1` with a typed parameter schema and emits the full JSON response as text, so the
project dispatcher records, truncates, and budgets it like any other tool output.

The live smoke stays opt-in behind `HEATED_DEBATE_LIVE=1` plus `HEATED_DEBATE_SEARCH_URL`
(optionally `HEATED_DEBATE_SEARCH_API_KEY`) and asserts secret-free evidence against the
configured backend.

Validation completed successfully:

- Tests: 181 passed. Live tests: 3 skipped by design.
- Type checking: passed.
- Linting: passed.
- Domain and Pi boundary scan: passed.

C-WEB-SEARCH is complete. Milestone C is done; D-PRICING is next.
