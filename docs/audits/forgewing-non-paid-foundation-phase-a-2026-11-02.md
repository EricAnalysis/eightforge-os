# Forgewing non-paid foundation: Phase A audit

Date 2026-11-02, from `origin/main` at `9b5b97f`. The operator guidance qualification has not
run, and `FORGEWING_PROJECT_ASK_GUIDANCE_ENABLED` is off. Nothing here calls a provider.

## What already exists, and is reused

| Need | Existing | Use |
| --- | --- | --- |
| Project and intent plan | `lib/projectIntelligence/contextPlan.ts` | Extended |
| Sections with provenance and omissions | `lib/projectIntelligence/projectContext.ts` | Extended |
| Scoped reads | `lib/server/projectIntelligenceRead.ts` | Extended |
| Telemetry fields | `operatorGuidanceTelemetry` in `lib/projectIntelligence/telemetry.ts` | Becomes the row |
| Telemetry table pattern | `forgewing_provider_call_observations`: content-free, append-only, service-role only | Copied |
| Signal categories and codes | `lib/projectIntelligence/improvementSignal.ts` | Stored as is, no second taxonomy |
| Human triage of signals | `improvement_signal_submissions`, `improvement_signal_triage_reviews`, `lib/shared/orchestratorTaxonomy.ts` | Downstream, after human review |
| Assessment and history | `workflow_assessments` (immutable, versioned), `workflow_assessment_reviews`, `workflow_intake_submissions` | Follow-up answers link to these |
| Readiness | `buildFdeReadinessPlan`, `FdeReadinessCard`, the review packet | Extended |
| Ticket aggregates | `transaction_data_datasets` columns and `summary_json` | Read by named path |
| Rule meaning | `lib/validator/ruleExplanations.ts` | Never restated |

## True gaps

1. **No durable guidance telemetry.** It is only `console.info`.
2. **No durable product signal.** `/api/internal/project-intelligence/signals` computes on request.
3. **Nowhere to hold a follow-up answer.** Readiness lists questions and cannot take an answer.
4. **No capability catalogue.** Readiness names a starting rung and proves nothing lower is enough.
5. **No ticket section.** Fixed by this change.
6. **Readiness states are too coarse.** Three states cannot tell configuration from product work.

Gaps 1 to 3 need new tables, which are migrations and stop for owner approval. Gaps 4 to 6 do not.

## What the ticket audit found

- **Ticket quantities must not be summed across uploads.** The canonical reader marks a metric
  `conflicted` when uploads disagree (`resolveCanonicalTransactionMetric`), and it does not add them.
  The section reports per upload.
- **`total_cyd_ticket_grain` means invoiced tickets, and `_full` means all tickets**
  (`sumTicketGrainField(records, field, invoicedOnly)`). The section labels both.
- **The canonical reader loads every row.** `getCanonicalTransactionDataForProject` reads all rows,
  and `summary_json` holds grouped rollups. A new reader takes named JSON paths and no rows.
- **It treats a missing table as an empty project.** The new reader throws instead, so a failed read
  is reported as failed. This follows #286.
- **Truck and trailer checks exist only as review buckets** (`truck_trip_time_review`,
  `linked_mobile_load_consistency_review`). No rule pairs trucks with trailers, so the section reports
  what those buckets flagged and claims nothing more.

## The frozen qualification

The contract pins 22 source files, including ones this work has to edit, so `qualify.ts run` refuses on
`main` after this change. That refusal is correct and stays. The paid run happens from commit `9b5b97f`,
in a checkout of exactly that commit. `lib/evaluation/operatorGuidance/frozenRequests.test.ts` keeps the
result meaningful: `main` must rebuild all 24 requests and floors byte for byte as frozen.

Nothing under `scripts/evaluation/operator-guidance/` and no frozen artifact changes.
