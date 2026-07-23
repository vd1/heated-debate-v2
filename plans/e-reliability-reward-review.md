# E-RELIABILITY and E-REWARD review

Status: pass

Reviewed on 2026-07-23.

E-RELIABILITY: `analyzeReliability` deterministically measures score variance, ordering bias
(forward versus reversed presentation), model self-preference (same-model versus cross-model
judging), and judge disagreement (spread of per-judge-model means), rejecting out-of-range
scores. `createReliabilityArtifact` persists the versioned canonical artifact: study-spec hash,
judge model/controls/prompt hash, pricing snapshot reference, sample IDs, raw score vectors,
analysis version, conclusions, and per-threshold evaluations against the preregistered
reliability thresholds. Status derives deterministically: accepted only when every threshold
passes. `assertAcceptedReliability` gates optimization on a matching accepted artifact. The live
repeated/permuted probe stays opt-in behind HEATED_DEBATE_LIVE plus an explicit spec and
artifact path, bounded by the spec's sample guardrails.

E-REWARD: `computeReward` is pure and versioned: quality minus weighted token, latency, failure,
variance, and monetary penalties, with the full vector retained beside the scalar. Monetary cost
derives only from recorded per-attempt usage priced against the run's immutable snapshot;
unavailable quality or unpriceable usage makes the reward unavailable rather than a default.
Every term is table-tested, including the zero-penalty and invalid-weight rows.

Validation completed successfully with real exit codes.

Milestone E is complete. F-OPTIMIZER-FIXTURE opens Milestone F.
