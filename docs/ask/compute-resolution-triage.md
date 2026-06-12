# Selector COMPUTE Resolution Triage

Date: 2026-06-04

Root cause classification: `duplicate_derivation_issue`.

| Selector | Flagged Value | Bucket | Canonical Source (B1) / Upstream Owner (B2) / Shaping Rationale (B3) |
|---|---|---:|---|
| `selectProjectApprovalExecutionState` | `blockerCount` | 1 | Read `resolveCanonicalProjectValidationSnapshot(...).facts.blocker_count`. |
| `selectProjectApprovalExecutionState` | `warningCount` | 1 | Read `resolveCanonicalProjectValidationSnapshot(...).facts.warning_count`. |
| `selectProjectApprovalExecutionState` | Project approval/status label | 3 | Display renames existing `facts.readiness`, `facts.validator_status`, or `facts.status`; it does not decide readiness from findings. |
| `selectProjectApprovalExecutionState` | `validationState` | 3 | Display maps canonical validation status to Ask's allowed label set; no threshold/count logic remains. |
| `selectProjectApprovalExecutionState` | `sourceLayer` | 3 | Source-layer label is shaped from already selected evidence source types; it is not an operational fact. |
| `selectProjectApprovalExecutionState` | Confidence state | 3 | Confidence is display metadata based on whether the selected source is the fallback summary source, not a count or state decision. |
| `selectProjectApprovalExecutionState` | `nextAction` metadata | 3 | Navigation label maps the selected canonical source type to an allowed UI action; it does not prioritize work. |
| `selectProjectApprovalExecutionState` | CM-003 next best action | 2 | Execution owner must persist `recommended_next_action` with `source_item_id` and `priority_reason`. |
| `selectProjectApprovalExecutionState` | CM-005 open ticket count / exception eligibility | 2 | Validator/Execution owner must persist `invoice_exception_eligibility.open_ticket_count` and approval gate basis. |
| `selectProjectApprovalExecutionState` | CM-010 exception type / approval condition | 2 | Validator/Execution owner must persist `invoice_exception_eligibility.exception_type` and `required_approval_condition`. |
| `selectProjectApprovalExecutionState` | CM-039 execution blocker flag | 2 | Execution owner must persist `open_execution_items[]` with `status`, `required_action`, and `blocker_flag`. |
| `selectProjectApprovalExecutionState` | CM-043 payment release blockers | 2 | Execution owner must persist `payment_release_blockers[]` with `action_id`, `blocker_basis`, and `payment_gate_impact`. |
| `selectProjectInvoiceSupport` | Confidence state | 3 | Confidence is display metadata based on selected source/fallback source, while invoice values are read from the canonical snapshot. |
| `selectProjectInvoiceSupport` | `validationState` | 3 | Display maps canonical validation status to Ask's allowed label set; it does not inspect findings. |
| `selectProjectInvoiceSupport` | `nextAction` metadata | 3 | Navigation label maps the selected source type to `Open Validator` or `Open Evidence`; it does not determine a workflow state. |
| `selectProjectTicketValidation` | Confidence state | 3 | Confidence is display metadata based on selected source/fallback source, not `findings.length`. |
| `selectProjectTicketValidation` | `validationState` | 3 | Display maps canonical validation status to Ask's allowed label set; it does not inspect findings. |
| `selectProjectContractAuthority` | Confidence state | 3 | Confidence is display metadata based on selected source/fallback source, not `sources.length`. |
| `selectProjectContractAuthority` | `validationState` | 3 | Display maps canonical validation status to Ask's allowed label set; it does not inspect findings. |
| `selectProjectContractAuthority` | `nextAction` metadata | 3 | Navigation label maps the selected source type to an allowed UI action; it does not create a task. |
| `selectProjectReviewAuditState` | Reviewed document warning count | 2 | Audit/Validator owner must persist `reviewed_documents_with_warnings[]` with `warning_count` and `review_event_source`. |
| `selectProjectReviewAuditState` | First document to inspect priority | 2 | Validator/Execution owner must persist `first_document_to_inspect` with `document_id`, `risk_reason`, and `priority_source`. |
| `selectProjectReviewAuditState` | Confidence state | 3 | Confidence is display metadata based on selected source/fallback source, not `sources.length`. |
| `selectProjectReviewAuditState` | `validationState` | 3 | Display maps canonical validation status to Ask's allowed label set; it does not inspect findings. |
| `selectProjectReviewAuditState` | `nextAction` metadata | 3 | Remaining action label is UI navigation for the selected audit/evidence source; reviewed-warning and inspect-first priorities are Bucket 2. |
| `selectPortfolioProjectStatus` | Blocked project partition | 2 | Portfolio aggregate owner must persist `blocked_projects[]` and `blocked_project_count`. |
| `selectPortfolioProjectStatus` | Approval-ready project partition | 2 | Portfolio aggregate owner must persist `approval_ready_projects[]` and `approval_ready_project_count`. |
| `selectPortfolioProjectStatus` | Stale validation project partition | 2 | Portfolio aggregate owner must persist `stale_validation_projects[]` and `stale_validation_project_count`. |
| `selectPortfolioProjectStatus` | Fallback selected projects | 2 | Portfolio aggregate owner must provide the requested aggregate subset; selector no longer falls back to the full project list. |
| `selectPortfolioProjectStatus` | Per-row rank number | 2 | Portfolio aggregate owner must persist any meaningful rank/order for these subsets. |
| `selectPortfolioProjectStatus` | Blocked boolean | 2 | Portfolio aggregate owner must persist blocked-project subset/status instead of selector deriving `blockerCount > 0`. |
| `selectPortfolioProjectStatus` | Ready status label | 2 | Portfolio aggregate owner must persist approval-ready subset/status instead of selector applying blocker/warning/stale thresholds. |
| `selectPortfolioProjectStatus` | Matching project record count | 2 | Portfolio aggregate owner must persist subset counts; selector no longer uses array length. |

## Acceptance Notes

- Bucket 1 values now read canonical project validation snapshot fields.
- Bucket 2 rows are reclassified in `docs/ask/capabilityMatrix.md` and return explicit missing-upstream responses instead of selector-computed facts.
- Bucket 3 values are display shaping only: label mapping, source routing, or source/fallback confidence metadata. None make a count, total, rank, or readiness decision from raw records.

## Bucket 2 Matrix Rows

These are the 10 matrix rows that now fail honestly in the 60-query harness.

| CM ID | Computed Value Removed | Upstream Owner | Exact Canonical Field Needed |
|---|---|---|---|
| CM-003 | Next-best-action priority selected from available findings/decisions | Execution | `recommended_next_action` with `source_item_id` and `priority_reason` |
| CM-005 | Open-ticket exception eligibility and open ticket count | Validator | `invoice_exception_eligibility.open_ticket_count` and `invoice_exception_eligibility.approval_gate_basis` |
| CM-010 | Exception type (`blocker exception` / `warning exception`) and required approval condition | Validator | `invoice_exception_eligibility.exception_type` and `invoice_exception_eligibility.required_approval_condition` |
| CM-035 | Reviewed-document warning count from findings length | Validator | `reviewed_documents_with_warnings[]` with `document_id`, `warning_count`, and `review_event_source` |
| CM-038 | First-document-to-inspect priority from retrieval order | Validator | `first_document_to_inspect` with `document_id`, `risk_reason`, `linked_action_id`, and `priority_source` |
| CM-039 | Open execution item blocker flag from blocker count | Execution | `open_execution_items[]` with `id`, `status`, `required_action`, and `blocker_flag` |
| CM-043 | Payment-release blocker action from top finding/action | Execution | `payment_release_blockers[]` with `action_id`, `blocker_basis`, and `payment_gate_impact` |
| CM-049 | Blocked project subset/count/blocked boolean from project list thresholds | Portfolio aggregate | `blocked_projects[]` and `blocked_project_count` |
| CM-053 | Approval-ready subset/count/ready label from blocker/warning/stale thresholds | Portfolio aggregate | `approval_ready_projects[]` and `approval_ready_project_count` |
| CM-054 | Stale validation subset/count from project list filtering | Portfolio aggregate | `stale_validation_projects[]` and `stale_validation_project_count` |

No Bucket 2 state determination is routed to a generic Facts field. Project readiness and validation state remain Validator-owned canonical status values, and portfolio readiness/blockage must be read from portfolio-safe aggregates rather than recomputed in Ask.
