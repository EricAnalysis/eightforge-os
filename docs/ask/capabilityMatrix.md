# Ask Capability Matrix

This matrix is the specification of record for deterministic Ask expansion before AI. It defines one upstream canonical truth model and two read depths:

- Ask Project reads `project-deep` canonical project truth for one project.
- Ask Portfolio reads `portfolio-safe-aggregate` summaries only and routes to Ask Project when project depth is needed.

| ID | Question (canonical phrasing) | Surface | Read Boundary | Canonical Source | Selector Needed | Evidence Requirement | Coverage Status |
|---|---|---|---|---|---|---|---|
| CM-001 | Is this project ready for invoice approval? | Project | project-deep | Facts, Validator, Execution | selectProjectInvoiceApprovalReadiness(projectId) | readiness state + blocking finding count + invoice approval status source | needs-selector |
| CM-002 | What is preventing approval? | Project | project-deep | Validator, Execution | selectProjectApprovalBlockers(projectId) | each blocker + rule or execution item + gate impact | needs-selector |
| CM-003 | What is the next best action for this project? | Project | project-deep | Execution, Validator | selectProjectNextBestAction(projectId) | recommended action + source finding/item + reason for priority | needs-upstream-fact |
| CM-004 | Are we waiting on contractor, client, monitor, internal reviewer, or validation? | Project | project-deep | Execution, Validator, Communication | selectProjectWaitingOn(projectId) | waiting party + blocking item + source event or finding | needs-upstream-fact |
| CM-005 | Can this invoice move forward while open tickets are pending? | Project | project-deep | Validator, Execution, Facts | selectProjectInvoiceExceptionEligibility(projectId) | invoice ID + open ticket count + approval gate basis | needs-upstream-fact |
| CM-006 | Which invoice amounts are fully supported? | Project | project-deep | Facts, Validator | selectProjectSupportedInvoiceAmounts(projectId) | invoice IDs + supported amount per invoice + support source | needs-selector |
| CM-007 | Which invoice amounts are unsupported? | Project | project-deep | Facts, Validator | selectProjectUnsupportedInvoiceAmounts(projectId) | invoice IDs + unsupported amount + mismatch or missing-support basis | needs-selector |
| CM-008 | Where did this total come from? | Project | project-deep | Facts | selectProjectInvoiceTotalLineage(projectId) (exists via current lineage read path) | rollup total + invoice IDs + per-invoice contribution + rollup source | answerable-now |
| CM-009 | What is the total invoice exposure? | Project | project-deep | Facts, Validator | selectProjectInvoiceExposure(projectId) | total exposure + supported/unsupported split + validator source | needs-selector |
| CM-010 | Can this invoice be approved with exceptions? | Project | project-deep | Validator, Execution, Facts | selectProjectInvoiceExceptionApproval(projectId) | invoice ID + exception type + required approval condition | needs-upstream-fact |
| CM-011 | Which tickets need correction? | Project | project-deep | Validator, Document-facts | selectProjectTicketsNeedingCorrection(projectId) | ticket IDs + correction reason + validator evidence | needs-selector |
| CM-012 | Which tickets changed eligibility after review? | Project | project-deep | Audit, Validator | selectProjectTicketEligibilityChanges(projectId) | ticket IDs + prior/current eligibility + review event | needs-upstream-fact |
| CM-013 | Which tickets have missing disposal site, material, CYD, tonnage, or mileage? | Project | project-deep | Validator, Document-facts | selectProjectTicketsMissingRequiredFields(projectId) | ticket IDs + missing fields + source row/evidence | needs-selector |
| CM-014 | Which tickets have rate-code mismatches? | Project | project-deep | Validator, Document-facts | selectProjectTicketRateCodeMismatches(projectId) | ticket IDs + invoice rate code + expected contract code + evidence | needs-selector |
| CM-015 | Which tickets appear duplicated across invoices? | Project | project-deep | Validator, Document-facts | selectProjectDuplicateInvoiceTickets(projectId) | duplicate ticket IDs + invoice IDs + duplicate basis | needs-upstream-fact |
| CM-016 | Which tickets were added after initial review? | Project | project-deep | Audit, Document-facts | selectProjectTicketsAddedAfterInitialReview(projectId) | ticket IDs + added timestamp + initial review baseline | needs-upstream-fact |
| CM-017 | Which tickets are unresolved by reviewer? | Project | project-deep | Validator, Execution | selectProjectReviewerUnresolvedTickets(projectId) | ticket IDs + reviewer status + open finding/action | needs-selector |
| CM-018 | Which contract is governing? | Project | project-deep | Facts, Document-facts | selectProjectGoverningContract(projectId) | governing contract doc + precedence basis + effective source | needs-selector |
| CM-019 | Which amendment or exhibit controls the rate schedule? | Project | project-deep | Facts, Document-facts | selectProjectRateScheduleAuthority(projectId) | controlling amendment/exhibit + relationship basis + rate schedule source | needs-selector |
| CM-020 | Did a newer document replace an older one? | Project | project-deep | Document-facts, Audit | selectProjectDocumentReplacementChain(projectId) | replacing doc + replaced doc + relationship/effective date | needs-selector |
| CM-021 | Are there conflicting facts across documents? | Project | project-deep | Document-facts, Validator | selectProjectCrossDocumentConflicts(projectId) | conflicting facts + document sources + current canonical winner | needs-selector |
| CM-022 | Does this invoice use the correct contract rates? | Project | project-deep | Validator, Facts | selectProjectInvoiceRateValidation(projectId) | invoice line IDs + expected rate + actual rate + contract source | needs-selector |
| CM-023 | Are tipping fees billable under this contract? | Project | project-deep | Facts, Document-facts | selectProjectTippingFeeBillability(projectId) | governing contract doc + fee clause/rate row + eligibility basis | needs-selector |
| CM-024 | Are mileage tiers applied correctly? | Project | project-deep | Validator, Document-facts | selectProjectMileageTierValidation(projectId) | invoice/ticket IDs + mileage tier + expected rate basis | needs-upstream-fact |
| CM-025 | Are any invoice line items missing from the contract rate table? | Project | project-deep | Validator, Facts | selectProjectMissingContractRateItems(projectId) | line item IDs + canonical category + missing rate-table basis | needs-selector |
| CM-026 | Is the project approaching contract ceiling? | Project | project-deep | Facts, Validator | selectProjectContractCeilingProximity(projectId) | NTE amount + billed total + remaining/overage calculation source | needs-selector |
| CM-027 | Is this work FEMA reimbursable based on current facts? | Project | project-deep | Facts, Document-facts, Validator | selectProjectFemaReimbursability(projectId) | eligibility clauses + work category + unresolved limitations | needs-upstream-fact |
| CM-028 | What documentation is required for payment? | Project | project-deep | Facts, Validator, Document-facts | selectProjectPaymentDocumentationRequirements(projectId) | required document types + governing source + missing/received status | needs-selector |
| CM-029 | Is monitoring required? | Project | project-deep | Facts, Document-facts | selectProjectMonitoringRequirement(projectId) | monitoring clause/fact + governing document + requirement state | needs-selector |
| CM-030 | Are GPS, photos, load tickets, or daily reconciliation required? | Project | project-deep | Facts, Document-facts | selectProjectOperationalDocumentationRequirements(projectId) | each required artifact + source clause + current support status | needs-selector |
| CM-031 | Can the contractor work on private property? | Project | project-deep | Facts, Document-facts | selectProjectPrivatePropertyAuthority(projectId) | private-property clause + permission limits + governing source | needs-selector |
| CM-032 | Are stumps eligible? | Project | project-deep | Facts, Document-facts | selectProjectStumpEligibility(projectId) | eligibility clause + debris category basis + limitations | needs-upstream-fact |
| CM-033 | Is there no-guaranteed-quantity or funding-contingency language? | Project | project-deep | Facts, Document-facts | selectProjectQuantityFundingContingencies(projectId) | clause text summary + governing document + contingency type | needs-selector |
| CM-034 | Which documents still need review? | Project | project-deep | Execution, Audit, Document-facts | selectProjectDocumentsNeedingReview(projectId) | document IDs + review status + reason they remain open | needs-selector |
| CM-035 | Are any documents marked reviewed but still producing warnings? | Project | project-deep | Validator, Audit, Document-facts | selectProjectReviewedDocumentsWithWarnings(projectId) | reviewed document IDs + warning count + review event/source | needs-upstream-fact |
| CM-036 | Which facts were manually confirmed? | Project | project-deep | Audit, Document-facts | selectProjectManuallyConfirmedFacts(projectId) | fact keys + confirmed value + reviewer/review timestamp | needs-selector |
| CM-037 | Which facts were overridden by a human? | Project | project-deep | Audit, Document-facts | selectProjectHumanOverriddenFacts(projectId) | fact keys + override value + prior value if available + actor/reason | needs-selector |
| CM-038 | Which document should the operator inspect first? | Project | project-deep | Validator, Execution, Audit | selectProjectFirstDocumentToInspect(projectId) | document ID + risk reason + linked blocker/warning/action | needs-upstream-fact |
| CM-039 | What execution items are still open? | Project | project-deep | Execution | selectProjectOpenExecutionItems(projectId) | execution item IDs + status + required action + blocker flag | needs-upstream-fact |
| CM-040 | Which findings require action before approval? | Project | project-deep | Validator, Execution | selectProjectPreApprovalActionFindings(projectId) | finding IDs + required action + approval gate effect | needs-selector |
| CM-041 | Which findings were overridden, and why? | Project | project-deep | Audit, Validator | selectProjectOverriddenFindings(projectId) | finding IDs + override reason + actor/timestamp | needs-selector |
| CM-042 | What changed since the last review? | Project | project-deep | Audit, Validator, Execution | selectProjectChangesSinceLastReview(projectId) | changed item IDs + before/after state + review baseline | needs-selector |
| CM-043 | Which actions are blocking payment release? | Project | project-deep | Execution, Validator | selectProjectPaymentReleaseBlockers(projectId) | action IDs + blocker basis + payment gate impact | needs-upstream-fact |
| CM-044 | Which tickets are waiting on a person? | Project | project-deep | Communication | selectProjectTicketsWaitingOnPerson(projectId) | ticket IDs + person + communication thread/event | needs-communication-event |
| CM-045 | Who owns the next response? | Project | project-deep | Communication | selectProjectNextResponseOwner(projectId) | owner + thread/message source + requested response | needs-communication-event |
| CM-046 | What are we waiting on from this thread? | Project | project-deep | Communication | selectProjectThreadWaitingOn(projectId) | thread ID + missing response/decision + latest message source | needs-communication-event |
| CM-047 | What decision is being requested? | Project | project-deep | Communication | selectProjectRequestedCommunicationDecision(projectId) | requested decision + requester + thread evidence | needs-AI |
| CM-048 | What changed between initial review and full review? | Project | project-deep | Communication, Audit | selectProjectInitialToFullReviewDelta(projectId) | changed facts/findings + review baselines + source events | needs-AI |
| CM-049 | Which projects are blocked right now? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioBlockedProjects() | each blocked project + blocker count + at-risk amount + aggregate source | needs-upstream-fact |
| CM-050 | What is the total at-risk amount across all projects? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioAtRiskAmount() (exists via current portfolio aggregate path) | total at-risk amount + per-project aggregate contributions + source | answerable-now |
| CM-051 | Which projects need review first? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioReviewPriority() (exists via current portfolio aggregate path) | ranked projects + deterministic ranking reason + aggregate fields | answerable-now |
| CM-052 | Which issue type is happening most across projects? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioTopIssueType() (exists via current portfolio aggregate path) | issue type + count + percentage + aggregate source | answerable-now |
| CM-053 | Which projects are ready for approval? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioApprovalReadyProjects() | project IDs/names + ready status + aggregate source | needs-upstream-fact |
| CM-054 | Which projects have stale validation snapshots? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioStaleValidationSnapshots() | project IDs/names + stale label + last validation timestamp source | needs-upstream-fact |
| CM-055 | Which contractors have the most repeated issues? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioContractorRepeatedIssues() | contractor names + issue counts + aggregate source | needs-upstream-fact |
| CM-056 | Are any projects approaching contract ceiling? | Portfolio | portfolio-safe-aggregate | Portfolio-aggregate | selectPortfolioContractCeilingProximity() | project IDs/names + ceiling proximity band + aggregate source | needs-upstream-fact |

## Coverage Rollup

- `answerable-now`: CM-008, CM-050, CM-051, CM-052
- `needs-selector`: CM-001, CM-002, CM-006, CM-007, CM-009, CM-011, CM-013, CM-014, CM-017, CM-018, CM-019, CM-020, CM-021, CM-022, CM-023, CM-025, CM-026, CM-028, CM-029, CM-030, CM-031, CM-033, CM-034, CM-036, CM-037, CM-040, CM-041, CM-042
- `needs-upstream-fact`: CM-003, CM-004, CM-005, CM-010, CM-012, CM-015, CM-016, CM-024, CM-027, CM-032, CM-035, CM-038, CM-039, CM-043, CM-049, CM-053, CM-054, CM-055, CM-056
- `needs-communication-event`: CM-044, CM-045, CM-046
- `needs-AI`: CM-047, CM-048

## Upstream Owners For Non-Buildable Rows

- CM-004: Execution/Communication owner must persist a waiting-party event or canonical owner state before Ask can answer.
- CM-003: Execution owner must persist `recommended_next_action` with source item and priority reason.
- CM-005: Validator/Execution owner must persist `invoice_exception_eligibility.open_ticket_count` and approval gate basis.
- CM-010: Validator/Execution owner must persist `invoice_exception_eligibility.exception_type` and required approval condition.
- CM-012: Validator/Audit owner must persist ticket eligibility review deltas.
- CM-015: Validator owner must persist duplicate-ticket findings across invoice scope.
- CM-016: Audit/Document intelligence owner must persist ticket added-after-review events.
- CM-024: Validator owner must persist mileage tier comparison results.
- CM-027: Truth engine/Document intelligence owner must persist FEMA reimbursability facts with evidence.
- CM-032: Truth engine/Document intelligence owner must persist stump eligibility facts with evidence.
- CM-035: Audit/Validator owner must persist `reviewed_documents_with_warnings[]` with warning count and review event source.
- CM-038: Validator/Execution owner must persist `first_document_to_inspect` with risk reason and priority source.
- CM-039: Execution owner must persist `open_execution_items[]` with status, required action, and blocker flag.
- CM-043: Execution owner must persist `payment_release_blockers[]` with action ID, blocker basis, and gate impact.
- CM-049: Portfolio aggregate owner must persist `blocked_projects[]` and `blocked_project_count`.
- CM-053: Portfolio aggregate owner must persist `approval_ready_projects[]` and `approval_ready_project_count`.
- CM-054: Portfolio aggregate owner must persist `stale_validation_projects[]` and `stale_validation_project_count`.
- CM-055: Portfolio aggregate owner must persist contractor issue repetition aggregates without raw project traversal.
- CM-056: Portfolio aggregate owner must persist contract ceiling proximity summaries without raw project traversal.
- CM-044, CM-045, CM-046: Communication Intelligence owner must persist communication events.
- CM-047, CM-048: AI/Communication Intelligence owner must extract intent/delta from communication context before deterministic Ask can read it.

## Boundary Integrity Check

- [ ] Every Portfolio-surface row has Read Boundary = portfolio-safe-aggregate
- [ ] No Portfolio row names Document-facts, Evidence-anchor, or ticket rows as its canonical source
- [ ] Every "Both" row has TWO read paths defined: project-deep + portfolio-safe
- [ ] No "Both" row resolves to a single shared selector across depths
- [ ] Every Category 9 row is marked needs-communication-event or needs-AI (none marked answerable-now or needs-selector)
- [ ] Selector names follow convention: selectProjectXxx / selectPortfolioXxx
