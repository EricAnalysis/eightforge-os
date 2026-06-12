# Selector Read-Path Diagnostic

Date: 2026-06-04

Scope: CM-003, CM-005, CM-010, CM-035, CM-038, CM-039, CM-043, CM-049, CM-053, CM-054.

Constraint observed: diagnostic only. No selector, upstream field, matrix, or harness code was changed.

## Findings

| CM ID | Selector File | Reads or Hardcoded-Gap | Field Name Selector Reads | Field Name Built Upstream | Match? | Situation | Fix Needed |
|---|---|---|---|---|---|---|---|
| CM-003 | `lib/ask/selectors/projectApprovalExecutionState.ts` | HARDCODED-GAP. Code path: `if (text.includes('next best action')) { return upstreamGapAnswer(` with message `'Missing upstream field: Execution recommended_next_action with source_item_id and priority_reason.'` | n/a | `ProjectExecutionSummary.recommended_next_action.source_item_id`; `ProjectExecutionSummary.recommended_next_action.priority_reason` | n/a | SITUATION 1 | Add conditional read of `recommended_next_action` and its `source_item_id` / `priority_reason`; gap only when null. |
| CM-005 | `lib/ask/selectors/projectApprovalExecutionState.ts` | HARDCODED-GAP. Code path: `if (text.includes('open tickets')) { return upstreamGapAnswer(` with message `'Missing upstream field: Validator/Execution invoice_exception_eligibility.open_ticket_count.'` | n/a | `ValidationSummary.invoice_exception_eligibility.open_ticket_count`; `ValidationSummary.invoice_exception_eligibility.approval_gate_basis`; canonical reader uses `raw?.invoice_exception_eligibility` and `value.open_ticket_count` / `value.approval_gate_basis` | n/a | SITUATION 1 | Add conditional read of `snapshot.facts.invoice_exception_eligibility?.open_ticket_count` and `approval_gate_basis`; gap only when null. |
| CM-010 | `lib/ask/selectors/projectApprovalExecutionState.ts` | HARDCODED-GAP. Code path: `if (text.includes('approved with exceptions')) { return upstreamGapAnswer(` with message `'Missing upstream field: Validator/Execution invoice_exception_eligibility.exception_type and required_approval_condition.'` | n/a | `ValidationSummary.invoice_exception_eligibility.exception_type`; `ValidationSummary.invoice_exception_eligibility.required_approval_condition`; canonical reader uses `value.exception_type` and `value.required_approval_condition` | n/a | SITUATION 1 | Add conditional read of `snapshot.facts.invoice_exception_eligibility?.exception_type` and `required_approval_condition`; gap only when null. |
| CM-035 | `lib/ask/selectors/projectReviewAuditState.ts` | HARDCODED-GAP. Code path: `if (text.includes('marked reviewed')) { return upstreamGapAnswer(` with message `'Missing upstream field: Audit/Validator reviewed_documents_with_warnings[] with warning_count and review_event_source.'` | n/a | `ValidationSummary.reviewed_documents_with_warnings[].document_id`; `ValidationSummary.reviewed_documents_with_warnings[].warning_count`; `ValidationSummary.reviewed_documents_with_warnings[].review_event_source`; canonical reader uses `raw?.reviewed_documents_with_warnings` | n/a | SITUATION 1 | Add conditional read of `snapshot.facts.reviewed_documents_with_warnings`; gap only when empty/missing. |
| CM-038 | `lib/ask/selectors/projectReviewAuditState.ts` | HARDCODED-GAP. Code path: `if (text.includes('inspect first')) { return upstreamGapAnswer(` with message `'Missing upstream field: Validator/Execution first_document_to_inspect with risk_reason and priority_source.'` | n/a | `ValidationSummary.first_document_to_inspect.document_id`; `ValidationSummary.first_document_to_inspect.risk_reason`; `ValidationSummary.first_document_to_inspect.linked_action_id`; `ValidationSummary.first_document_to_inspect.priority_source`; canonical reader uses `raw?.first_document_to_inspect` | n/a | SITUATION 1 | Add conditional read of `snapshot.facts.first_document_to_inspect`; gap only when null. |
| CM-039 | `lib/ask/selectors/projectApprovalExecutionState.ts` | HARDCODED-GAP. Code path: `if (text.includes('execution items')) { return upstreamGapAnswer(` with message `'Missing upstream field: Execution open_execution_items[] with status, required_action, and blocker_flag.'` | n/a | `ProjectExecutionSummary.open_execution_items[].id`; `ProjectExecutionSummary.open_execution_items[].status`; `ProjectExecutionSummary.open_execution_items[].required_action`; `ProjectExecutionSummary.open_execution_items[].blocker_flag` | n/a | SITUATION 1 | Add conditional read of `open_execution_items`; gap only when empty/missing. |
| CM-043 | `lib/ask/selectors/projectApprovalExecutionState.ts` | HARDCODED-GAP. Code path: `if (text.includes('blocking payment release')) { return upstreamGapAnswer(` with message `'Missing upstream field: Execution payment_release_blockers[] with action_id, blocker_basis, and payment_gate_impact.'` | n/a | `ProjectExecutionSummary.payment_release_blockers[].action_id`; `ProjectExecutionSummary.payment_release_blockers[].blocker_basis`; `ProjectExecutionSummary.payment_release_blockers[].payment_gate_impact` | n/a | SITUATION 1 | Add conditional read of `payment_release_blockers`; gap only when empty/missing. |
| CM-049 | `lib/ask/selectors/portfolioProjectStatus.ts` | HARDCODED-GAP. Code path: `const missingField = ... : 'Portfolio aggregate blocked_projects[] and blocked_project_count';` followed by `return {` and answer line `` `This cannot be answered from current canonical system truth. Missing upstream field: ${missingField}.` `` | n/a | `PortfolioProjectStatusAggregate.blocked_projects[]`; `PortfolioProjectStatusAggregate.blocked_project_count` | n/a | SITUATION 1 | Add conditional read of `blocked_projects` and `blocked_project_count` from the portfolio aggregate. Portfolio note: selector currently does not read the prebuilt aggregate and does not re-filter/re-count; it returns a gap. |
| CM-053 | `lib/ask/selectors/portfolioProjectStatus.ts` | HARDCODED-GAP. Code path: `const missingField = text.includes('ready for approval') ? 'Portfolio aggregate approval_ready_projects[] and approval_ready_project_count'` followed by `return {` and answer line `` `This cannot be answered from current canonical system truth. Missing upstream field: ${missingField}.` `` | n/a | `PortfolioProjectStatusAggregate.approval_ready_projects[]`; `PortfolioProjectStatusAggregate.approval_ready_project_count` | n/a | SITUATION 1 | Add conditional read of `approval_ready_projects` and `approval_ready_project_count` from the portfolio aggregate. Portfolio note: selector currently does not read the prebuilt aggregate and does not re-filter/re-count; it returns a gap. |
| CM-054 | `lib/ask/selectors/portfolioProjectStatus.ts` | HARDCODED-GAP. Code path: `: text.includes('stale validation') ? 'Portfolio aggregate stale_validation_projects[] and stale_validation_project_count'` followed by `return {` and answer line `` `This cannot be answered from current canonical system truth. Missing upstream field: ${missingField}.` `` | n/a | `PortfolioProjectStatusAggregate.stale_validation_projects[]`; `PortfolioProjectStatusAggregate.stale_validation_project_count` | n/a | SITUATION 1 | Add conditional read of `stale_validation_projects` and `stale_validation_project_count` from the portfolio aggregate. Portfolio note: selector currently does not read the prebuilt aggregate and does not re-filter/re-count; it returns a gap. |

## Contract Alignment Notes

- Matrix and triage contract names match the upstream names now built:
  - CM-003: `recommended_next_action` with `source_item_id` and `priority_reason`.
  - CM-005: `invoice_exception_eligibility.open_ticket_count` and `invoice_exception_eligibility.approval_gate_basis`.
  - CM-010: `invoice_exception_eligibility.exception_type` and `invoice_exception_eligibility.required_approval_condition`.
  - CM-035: `reviewed_documents_with_warnings[]` with `document_id`, `warning_count`, and `review_event_source`.
  - CM-038: `first_document_to_inspect` with `document_id`, `risk_reason`, `linked_action_id`, and `priority_source`.
  - CM-039: `open_execution_items[]` with `id`, `status`, `required_action`, and `blocker_flag`.
  - CM-043: `payment_release_blockers[]` with `action_id`, `blocker_basis`, and `payment_gate_impact`.
  - CM-049: `blocked_projects[]` and `blocked_project_count`.
  - CM-053: `approval_ready_projects[]` and `approval_ready_project_count`.
  - CM-054: `stale_validation_projects[]` and `stale_validation_project_count`.
- No Situation 2 name mismatch was found because no targeted selector currently reads any of the newly built fields.
- Portfolio rows do not currently breach by re-filtering/re-counting inside `selectPortfolioProjectStatus`; they breach by having no aggregate read path at all and returning the portfolio-safe aggregate gap unconditionally for those concepts.

## Summary

SITUATION 1 (hardcoded-gap, needs read path): 10 rows - CM-003, CM-005, CM-010, CM-035, CM-038, CM-039, CM-043, CM-049, CM-053, CM-054

SITUATION 2 (name mismatch, needs alignment): 0 rows - none

ALREADY-CORRECT (reads right field): 0 rows - none

Of which still-red (evidence-shape gap): 0 rows - none

Summary count check: 10 total rows.

Harness status expected unchanged by this read-only pass: 50/60, because no selector read paths were added.
