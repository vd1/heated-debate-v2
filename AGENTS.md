# Development guide

- This is a greenfield v2 of `../heated-debate/`.
- Follow `plans/implementation-plan.md` in order unless the user explicitly reprioritizes it.
- Work on only one task ID at a time.
- Use strict TDD: add a failing test, make the smallest implementation pass, then refactor while green.
- Keep the domain independent of Pi. Pi belongs behind the `AgentPort` adapter.
- Do not use live models in unit tests. Live-provider tests must be opt-in integration tests.
- The default live model is `openai-codex/gpt-5.6-sol` with thinking level `high`, unless an experiment explicitly overrides it.
- The canonical run record must expose every effective experiment parameter and every message given to an agent.
- Do not silently add context. Context selection must be an explicit policy represented in run data.
- Prefer small commits that each leave tests, type checking, and linting green.
