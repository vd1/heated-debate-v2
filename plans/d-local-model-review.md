# D-LOCAL-MODEL review

Status: pass

Reviewed on 2026-07-23.

An opt-in live smoke exercises one PiAgent turn against an OpenAI-compatible local endpoint
(Gemma target) through the standard ModelRuntime stream. Endpoint and model selection stay
external to domain code via HEATED_DEBATE_LOCAL_URL and HEATED_DEBATE_LOCAL_MODEL, the test
skips without HEATED_DEBATE_LIVE=1, the model entry is zero-cost, and disposal is guaranteed.

Milestone D is complete. E-DETERMINISTIC opens Milestone E.
