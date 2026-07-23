# E-JUDGE review

Status: pass

Reviewed on 2026-07-23.

`createJudgeEvaluator` implements a judge behind the shared evaluator contract. Every
evaluation uses a fresh agent that the judge disposes, a deny-all tool policy, and exact
messages built solely from the declared canonical artifact: the transcript is rendered from
`run.started` and `turn.completed` events, hashed, and referenced as the single declared input.
The raw response is preserved even on parse failure, the outcome is derived from that stored
response against the rubric (fabricated quote evidence fails through the source-text check), and
the linked evaluation record is persisted through the injected atomic writer before any result
returns. Agent failures become sanitized-failure records with configured secrets redacted.

A valid outcome produces a known result: the normalized mean across rubric dimensions with
lower-is-better scales inverted, carrying the shared configuration identity, range, direction,
and runId-qualified evidence. Partial and malformed outcomes are unavailable with reasons.
Offline tests use scripted responses only; a live judge smoke remains separately opt-in.

Validation completed successfully with real exit codes.

E-JUDGE is complete. E-RELIABILITY is next.
