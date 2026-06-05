# Selector Build Queue

Build Prompt 2 groups the 38 GENERIC needs-selector probes by shared deterministic selector. Real selector count: 6.

| Selector Name | CM IDs Served | Surface | Read Boundary | Canonical Source | Evidence Requirement (union) | Probes Count |
|---|---|---|---|---|---|---:|
| selectProjectApprovalExecutionState(projectId) | CM-001, CM-002, CM-003, CM-005, CM-010, CM-039, CM-040, CM-043 | Project | project-deep | Validator, Execution, Facts | readiness state, blockers/findings/execution items, next action, invoice/ticket gate basis, exception condition, open execution status, payment gate impact | 8 |
| selectProjectInvoiceSupport(projectId) | CM-006, CM-007, CM-009, CM-022, CM-025, CM-026 | Project | project-deep | Facts, Validator | supported/unsupported invoice amounts, exposure split, rate validation, missing contract-rate line items, NTE/ceiling proximity source | 6 |
| selectProjectTicketValidation(projectId) | CM-011, CM-013, CM-014, CM-017 | Project | project-deep | Validator, Document-facts | ticket IDs, correction/missing-field/rate-code/reviewer status reason, validator evidence/action | 4 |
| selectProjectContractAuthority(projectId) | CM-018, CM-019, CM-020, CM-021, CM-023, CM-028, CM-029, CM-030, CM-031, CM-033 | Project | project-deep | Facts, Document-facts, Validator | governing contract, precedence/effective source, amendment/exhibit, replacement chain, conflicts, billability and documentation clause status | 10 |
| selectProjectReviewAuditState(projectId) | CM-034, CM-035, CM-036, CM-037, CM-038, CM-041, CM-042 | Project | project-deep | Audit, Validator, Document-facts | document review status, reviewed warnings, confirmed/overridden facts, first inspection target, overridden findings, changed items and review baseline | 7 |
| selectPortfolioProjectStatus() | CM-049, CM-053, CM-054 | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | blocked projects, approval-ready projects, stale validation snapshots, aggregate source and stale labels | 3 |

## Reclassified Rows

None in this pass. Selectors only read canonical project truth, validator findings, execution records already present in the retrieval result, and portfolio-safe aggregates already present in the portfolio answer builder.
