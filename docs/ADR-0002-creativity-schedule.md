# ADR-0002: Use Shelley as the v1 creativity-prompt authority

## Status

Accepted in B-DIAL.

## Decision

The authoritative v1 prompt schedule is the `DIAL_PROMPTS` table in the sibling v1 repository's `shelley.ts`, which is the active TypeScript debate engine. Heated Debate v2 records this port as `linear-cooling@1` and locks all five strings with exact-text tests.

The schedule cools by round as follows:

- one round: `[5]`
- two rounds: `[5, 1]`
- three rounds: `[5, 3, 1]`
- five rounds: `[5, 4, 3, 2, 1]`

## Consequences

The older `later/dials.py` wording is not mixed into version 1. In particular, level 2 uses Shelley's exact “Tighten the spec.” wording, and level 1 retains Shelley's no-code-diffs sentence. Any future wording change requires a new schedule or prompt-set version rather than silently changing `linear-cooling@1`.

The creativity prompt remains separate from provider temperature and other sampling controls.
