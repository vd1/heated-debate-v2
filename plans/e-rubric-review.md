# E-RUBRIC review

Status: pass

Reviewed on 2026-07-23.

`parseRubric` parses untrusted JSON into a validated, frozen `rubric@1`: unique dimensions each
carrying a description, an integer scale with max above min, an explicit direction, and a
required-evidence rule. Unknown fields are rejected at every level and `rubricHash` is canonical.

`parseJudgeOutput` maps raw judge text onto typed outcomes: `valid` for a complete conforming
response, `malformed` with a reason when the output is not the required JSON shape, and
`partial` when dimensions are absent, out of scale, non-integer, structurally wrong, or missing
required quote evidence. Missing or rejected dimensions are listed with their reasons and never
become zero scores.

`createEvaluationRecord` versions the canonical evaluation record: rubric identity with its
hash, the source artifact run ID and content hash, judge identity, declared inputs, the exact
prompt messages, controls, the raw response preserved even on parse failure, the parsed outcome,
and sanitized failure data; a record requires an outcome or a failure, and the record itself
hashes canonically.

Validation completed successfully with real exit codes.

E-RUBRIC is complete. E-JUDGE is next.
