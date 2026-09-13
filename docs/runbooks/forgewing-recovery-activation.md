# Forgewing recovery activation

This runbook describes the repo-owned operational ceiling for Forgewing recovery. Deployment configuration may lower activation, but it cannot raise a recovery type above the qualification recorded in code.

## Current policy

| Recovery type | Qualification | Maximum activation | New scheduling |
| --- | --- | --- | --- |
| Priced-schedule continuation attribution | `corpus_qualified` | `controlled` | Permitted when requested |
| Pricing multi-observation cluster V2 | `synthetic_qualified` | `disabled` | Disabled even when requested |
| Pricing single-observation V1 | `synthetic_qualified` | `disabled` | Deprecated and disabled |

`enabled` activation is reserved for `production_qualified` recovery. No Phase 16 recovery type is production-qualified. Human review remains mandatory at every activation level. Policy cannot accept a review or start a reprocess.

Existing V1 proposals, reviews, confirmations, and deterministic re-entry remain valid. Phase 16 disables only new V1 provider scheduling.

## Runtime gates

`FORGEWING_SHADOW_ENABLED` remains the master kill switch.

Continuation attribution additionally requires `FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED=1`. When both gates are set, its effective activation is `controlled`.

Pricing-cluster V2 additionally reads `FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED`, but its synthetic-only qualification ceiling keeps effective activation `disabled`.

V1 continues to read `FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED` for compatibility, but its synthetic-only qualification ceiling keeps new scheduling `disabled`.

Region classification is independent of recovery activation and requires both:

- `FORGEWING_SHADOW_ENABLED=1`
- `FORGEWING_REGION_CLASSIFICATION_ENABLED=1`

The master gate alone performs no region-classification provider call.

Boolean gates accept only `1`, `0`, or an unset/empty value. Malformed values fail closed. Invalid values for `FORGEWING_MAX_CALLS`, `FORGEWING_TIMEOUT_MS`, or `FORGEWING_MAX_OUTPUT_TOKENS` fall back to the existing conservative default and emit a structured engineering warning; values are never silently clamped upward.

## Bounded progression

`FORGEWING_MAX_CALLS` remains the overall document ceiling for one normal document-processing run. Recovery planning uses that ceiling without introducing another recovery budget. The planner reads existing proposals and generation outcomes once, before allocating any provider slot.

It excludes an exact proposal for the same page representation and candidate set, regardless of review state. It also excludes a confirmed candidate. Remaining never-invoked units are evaluated before previously provider-invoked failures, ordered by physical page and stable unit key. Units beyond the current budget record `budget_exhausted` and remain queued for a later normal processing run.

If prior state cannot be read, recovery schedules zero provider calls and logs `prior_state_unavailable`. No progress state is invented.

## Review and reprocess

Forgewing recovery recommendations are non-authoritative proposals. A human remains the sole authority for accepting, modifying, rejecting, or deferring a proposal, and an accepted review still requires explicit reprocessing before it affects reconstructed output.

`processingPurpose='recovery_reprocess'` suppresses all Forgewing provider work. Phase 16 does not change Unstructured extraction, OpenAI Instructor extraction/classification, or OpenAI vision extraction; those providers belong to separate extraction-policy concerns.

## Operational visibility

Document diagnostics derive the current code policy at read time and distinguish recovery availability, policy disablement, incomplete production qualification, queued evaluation, required human review, and required reprocessing. Diagnostics remain read-only and never create proposals, accept reviews, or invoke reprocessing.

The policy version and canonical digest are logged with planning events. Phase 16 does not persist policy configuration or add database schema.
