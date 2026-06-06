# Selector Read-Not-Compute Audit

Date: 2026-06-04

Scope: `lib/ask/selectors/*`, `lib/ask/answerBuilder.ts` selector wiring, `lib/ask/portfolioAnswerBuilder.ts` selector wiring, and upstream aggregate references used to decide whether a selector value is read or computed.

Result: FAIL - selector layer is not pure read-only yet.

The 60/60 harness can prove sourced and adequate answers. It does not prove the selector read every answer value from canonical truth. This audit found multiple selector-side COMPUTE values, especially counts, validation states, portfolio partitions, ready/blocked booleans, selected project counts, and exception labels. These should be fixed or reclassified before Build Prompt 2 closes.

## Definitions

READ means the selector returns a value already present in a canonical field, rollup, aggregate, finding, decision, document, or structured fact.

COMPUTE means the selector derives a new fact by counting, summing, filtering, ranking, partitioning, comparing, sorting, or using array length to produce a returned/evidence value.

SHAPE means formatting, source conversion, label normalization, source capping, or fallback wrapping that does not create a new operational fact.

DERIVE means a shared utility creates a new aggregate or operational fact.

## Inventory

| Selector | Returned Value | READ or COMPUTE | Canonical Source Read | Evidence |
|---|---|---:|---|---|
| `selectProjectApprovalExecutionState` | Original question text used for branch selection | SHAPE | `params.question.originalQuestion` | Branch only, not returned as fact. |
| `selectProjectApprovalExecutionState` | Project approval/status label | READ | `params.retrieval.rawData.validatorContext.projectStatus` or `params.project.validationStatus` | Returned as "Invoice approval readiness is ...". |
| `selectProjectApprovalExecutionState` | `blockerCount` | COMPUTE | None read; derived from `params.retrieval.validatorFindings` | `findings.filter(...).length`; returned in answer and `validationState`. Canonical count likely exists upstream in validator summary/rollup or should be added. |
| `selectProjectApprovalExecutionState` | `warningCount` | COMPUTE | None read; derived from `params.retrieval.validatorFindings` | `findings.filter(...).length`; returned in answer and `validationState`. Canonical count likely exists upstream in validator summary/rollup or should be added. |
| `selectProjectApprovalExecutionState` | Top blocker/finding basis | READ | `params.retrieval.validatorFindings[0].description/category/blocksProject/linkedActionId/id` | Reads an existing finding, but assumes retrieval order is canonical. |
| `selectProjectApprovalExecutionState` | Top decision/action | READ | `params.retrieval.decisions[0].id/title/status` | Reads an existing decision, but assumes retrieval order is canonical. |
| `selectProjectApprovalExecutionState` | Invoice fact label | READ | Matching `params.retrieval.facts[].fieldKey/label` | Uses first invoice-like fact; no aggregate math. |
| `selectProjectApprovalExecutionState` | Exception type (`blocker exception` vs `warning exception`) | COMPUTE | None read | Derived from `blockerCount > 0`; canonical exception approval condition likely should be a validator/execution fact if this row remains selector-owned. |
| `selectProjectApprovalExecutionState` | Execution blocker flag | COMPUTE | None read | Derived from `blockerCount > 0`; should read execution item blocker flag or validator gate field. |
| `selectProjectApprovalExecutionState` | `sourceLayer` | SHAPE/COMPUTE | Sources selected by helper | `sources.some(type === decision)` chooses label; not an answer fact, but it is derived metadata. |
| `selectProjectApprovalExecutionState` | Confidence state | COMPUTE | None read | Uses `findings.length`, `decisions.length`, `facts.length`; returned as selector confidence. |
| `selectProjectApprovalExecutionState` | Evidence rows | SHAPE | `selectedSources(...)` from facts/findings/decisions | Source labels/snippets are shaped, not aggregated. |
| `selectProjectApprovalExecutionState` | `validationState` | COMPUTE | None read | Derived from `blockerCount` and `warningCount`; should read canonical validator state/status. |
| `selectProjectApprovalExecutionState` | `nextAction` | COMPUTE | None read | Derived from array presence; should read canonical execution priority/action if row needs deterministic next action. |
| `selectProjectInvoiceSupport` | Validation snapshot | READ | `resolveCanonicalProjectValidationSnapshot({ validationStatus, validationSummary })` | Intended canonical project validation snapshot read. |
| `selectProjectInvoiceSupport` | Invoice numbers | READ | `snapshot.invoice_summaries[].invoice_number` | Returned in invoice lines. |
| `selectProjectInvoiceSupport` | Billed amount per invoice | READ | `snapshot.invoice_summaries[].billed_amount` | Formatted only. |
| `selectProjectInvoiceSupport` | Supported amount per invoice | READ | `snapshot.invoice_summaries[].supported_amount` | Formatted only. |
| `selectProjectInvoiceSupport` | Unsupported/at-risk amount per invoice | READ | `snapshot.invoice_summaries[].at_risk_amount` | Formatted only. |
| `selectProjectInvoiceSupport` | Invoice approval status | READ | `snapshot.invoice_summaries[].approval_status` | Returned in invoice lines. |
| `selectProjectInvoiceSupport` | Invoice support source | READ | `snapshot.invoice_summaries[].billed_amount_source` | Returned in invoice lines. |
| `selectProjectInvoiceSupport` | Total exposure | READ | `snapshot.facts.total_at_risk` | Formatted only. |
| `selectProjectInvoiceSupport` | Supported exposure partition | READ | `snapshot.facts.exposure.total_transaction_supported_amount` | Formatted only. |
| `selectProjectInvoiceSupport` | Unsupported exposure partition | READ | `snapshot.facts.unsupported_amount` | Formatted only. |
| `selectProjectInvoiceSupport` | Contract ceiling/NTE | READ | `factValue(facts, ['nte_amount','contract_ceiling']).value` or `snapshot.facts.nte_amount` | Reads fact/snapshot value, no remaining amount computed. |
| `selectProjectInvoiceSupport` | Total billed | READ | `factValue(facts, ['total_billed']).value` or `snapshot.facts.total_billed` | Reads fact/snapshot value. |
| `selectProjectInvoiceSupport` | Ceiling remaining/overage | READ? | Text says canonical snapshot; no value returned | The selector does not calculate remaining/overage, but also does not name or return a canonical `remaining`/`overage` field. Row is only partially proven. |
| `selectProjectInvoiceSupport` | Rate/missing-rate evidence | READ | `params.retrieval.validatorFindings[0].description` | Reads finding description. |
| `selectProjectInvoiceSupport` | Confidence state | COMPUTE | None read | Uses `invoices.length` and `facts.length`; returned as selector confidence. |
| `selectProjectInvoiceSupport` | `validationState` | COMPUTE | None read | Uses `findings.some(...)` and `findings.length`; should read validator state/status. |
| `selectProjectInvoiceSupport` | `nextAction` | COMPUTE | None read | Uses `findings.length`; should read canonical action/route if material. |
| `selectProjectTicketValidation` | Ticket ID/scope | READ | `validatorFindings[0].factId/documentId/id` | Existing finding identifiers. |
| `selectProjectTicketValidation` | Correction reason/missing/rate-code/reviewer basis | READ | `validatorFindings[0].description/linkedActionId/id` | Reads finding/action fields; static field-list text is row wording. |
| `selectProjectTicketValidation` | Confidence state | COMPUTE | None read | Uses `findings.length`; returned as selector confidence. |
| `selectProjectTicketValidation` | `validationState` | COMPUTE | None read | Uses `findings.some(...)` and `findings.length`; should read validator status/count field. |
| `selectProjectTicketValidation` | Evidence rows | SHAPE | `selectedSources({ findings })` | Shapes validator sources. |
| `selectProjectContractAuthority` | Governing fact selection | READ/SHAPE | `params.retrieval.facts[]` matching contract/governing/NTE/rate key | Finds a candidate fact; not aggregating, but retrieval order/key matching should be replaced by canonical field reads where possible. |
| `selectProjectContractAuthority` | Governing document selection | READ/SHAPE | `params.retrieval.documents[]` matching contract/amendment/exhibit/rate | Finds candidate document; not aggregating. |
| `selectProjectContractAuthority` | Governing contract label | READ | `governing.documentName` or `doc.title` | Returned in answer. |
| `selectProjectContractAuthority` | Amendment/exhibit/replacement/conflict/payment documentation/monitoring/GPS/private-property/contingency answer facts | READ? | Mostly generic text plus selected fact/doc/finding | No arithmetic; however exact relationship, replacement chain, conflict winner, documentation received/missing status, and clause states are not read from named canonical fields. Some rows may be under-specified rather than computed. |
| `selectProjectContractAuthority` | Confidence state | COMPUTE | None read | Uses `sources.length`; returned as selector confidence. |
| `selectProjectContractAuthority` | `validationState` | COMPUTE | None read | Uses `findings.some(...)` and `findings.length`; should read validator state/status. |
| `selectProjectContractAuthority` | `nextAction` | COMPUTE | None read | Uses `findings.length`. |
| `selectProjectReviewAuditState` | Document/finding/fact identity | READ | `documents[0]`, `findings[0]`, `facts[0]` | Reads existing records, but assumes retrieval ordering. |
| `selectProjectReviewAuditState` | Reviewed document warning count | COMPUTE | None read | `findings.length`; explicitly returned as "warning count". Canonical reviewed-warning count likely should exist upstream or row needs upstream fact. |
| `selectProjectReviewAuditState` | Confirmed fact value | READ | `facts[0].label/value` | Returned in answer. |
| `selectProjectReviewAuditState` | Override fact value/prior value/actor reason | READ? | `facts[0].label/value` plus generic audit wording | Override/prior/actor fields are not actually read by name; under-specified canonical read. |
| `selectProjectReviewAuditState` | First document to inspect | READ? / COMPUTE risk | `documents[0]` or `findings[0].documentName` | Uses retrieval order as priority. If "inspect first" is a ranking fact, canonical priority should be read. |
| `selectProjectReviewAuditState` | Overridden finding/changed item IDs | READ | `finding.id` or `doc.id` | Existing identifiers. |
| `selectProjectReviewAuditState` | Confidence state | COMPUTE | None read | Uses `sources.length`; returned as selector confidence. |
| `selectProjectReviewAuditState` | `validationState` | COMPUTE | None read | Uses `findings.some(...)` and `findings.length`; should read validator/review state. |
| `selectProjectReviewAuditState` | `nextAction` | COMPUTE | None read | Derived from question text branch. |
| `selectPortfolioProjectStatus` | Question branch eligibility | SHAPE | `params.question` | Branching only. |
| `selectPortfolioProjectStatus` | Project list source | READ | `base.portfolioSections.projectsAffected[]` | Reads portfolio answer-builder section, itself derived upstream. |
| `selectPortfolioProjectStatus` | Blocked project partition | COMPUTE | None read | `projects.filter(project.blockerCount > 0 || /blocked/i.test(...))`; should read a canonical blocked-project aggregate/subset. |
| `selectPortfolioProjectStatus` | Approval-ready project partition | COMPUTE | None read | `projects.filter(blockerCount === 0 && warningCount === 0 && !isStale)`; should read canonical approval-ready aggregate/subset. |
| `selectPortfolioProjectStatus` | Stale validation project partition | COMPUTE | None read | `projects.filter(project.isStale)`; should read canonical stale-validation aggregate/subset or staleness summary. |
| `selectPortfolioProjectStatus` | Fallback selected projects | COMPUTE | None read | `selected.length > 0 ? selected : projects`; branch decision affects returned answer. |
| `selectPortfolioProjectStatus` | Per-row rank number | COMPUTE | None read | `index + 1`; if rank matters, read canonical rank/order from aggregate. |
| `selectPortfolioProjectStatus` | Blocked boolean | COMPUTE | None read | `project.blockerCount > 0`; evidence returns `blocked project true/false`. |
| `selectPortfolioProjectStatus` | Ready status label | COMPUTE | None read | `project.blockerCount === 0 && project.warningCount === 0 ? ...`; evidence returns derived readiness label. |
| `selectPortfolioProjectStatus` | Blocker/warning counts | READ | `base.portfolioSections.projectsAffected[].blockerCount/warningCount` | These were read from the base section. Upstream source is `item.rollup.blocked_count/unresolved_finding_count` in `portfolioAnswerBuilder.ts`. |
| `selectPortfolioProjectStatus` | At-risk amount per project | READ | `base.portfolioSections.projectsAffected[].atRiskAmount` | Upstream source is `PortfolioOverview.topRiskProjects[].atRiskAmount` / portfolio aggregate. |
| `selectPortfolioProjectStatus` | Staleness state/label | READ | `base.portfolioSections.projectsAffected[].isStale/stalenessLabel` | Upstream source is `PortfolioStalenessState`. |
| `selectPortfolioProjectStatus` | Matching project record count | COMPUTE | None read | `fallbackProjects.length`; returned in answer. Should read aggregate subset count. |
| `selectPortfolioProjectStatus` | Aggregate at-risk total | READ | `base.portfolioSections.financialExposure.totalAtRiskAmount` or `params.portfolio.totalAtRisk` | Upstream aggregate. |
| `selectPortfolioProjectStatus` | Pattern label | READ | `base.portfolioSections.patternDetected.label` | Upstream aggregate answer section. |
| `selectPortfolioProjectStatus` | Evidence rows and next action target | SHAPE | selected/fallback project records | Source strings shaped, but include computed booleans/labels above. |

## selectorUtils.ts Function Audit

| Function | SHAPE or DERIVE | Notes |
|---|---:|---|
| `formatCurrency` | SHAPE | Formatting only. No new amount fact is created. |
| `humanize` | SHAPE | Label normalization only. |
| `canonicalKey` | SHAPE | Key normalization only. |
| `factValue` | SHAPE | Selects first fact with matching canonical key. No aggregate value, but relies on retrieval order if duplicate facts exist. |
| `sourceFromFact` | SHAPE | Converts a canonical fact to a display source. |
| `sourceFromFinding` | SHAPE | Converts a validator finding to a display source. The confidence value is assigned from `blocksProject`; that is display metadata, not answer fact. |
| `sourceFromDecision` | SHAPE | Converts a decision to a display source. |
| `sourceFromDocument` | SHAPE | Converts document metadata to a display source. |
| `fallbackSource` | SHAPE | Creates fallback source metadata. Uses a synthetic `validator-summary` id, not a computed operational fact. |
| `sourceId` | SHAPE | Chooses an identifier. |
| `selectedSources` | SHAPE | Slices/caps sources and maps records to sources. It uses `sources.length` only for fallback selection, not an answer aggregate. |

Verdict for `selectorUtils.ts`: no aggregate DERIVE helper is hidden there. It shapes and caps sources. The closest risk is `factValue`, because duplicate canonical facts are resolved by array order rather than an explicit canonical winner field, but it does not sum/count/rank.

## COMPUTE Findings

| Selector | What Is Computed | From Lower-Level Records | Canonical Rollup Exists? | Disposition |
|---|---|---|---:|---|
| `selectProjectApprovalExecutionState` | Blocker count | `validatorFindings.filter(blocksProject || severity === critical).length` | Likely yes | Boundary breach. Read validator snapshot/count/rollup instead. |
| `selectProjectApprovalExecutionState` | Warning count | `validatorFindings.filter(severity === warning).length` | Likely yes | Boundary breach. Read validator snapshot/count/rollup instead. |
| `selectProjectApprovalExecutionState` | Validation state | Computed blocker/warning counts | Yes | Boundary breach. Read canonical project validator status. |
| `selectProjectApprovalExecutionState` | Exception type | `blockerCount > 0` | Unclear | If exception type is material, needs canonical execution/approval condition. |
| `selectProjectApprovalExecutionState` | Execution blocker flag | `blockerCount > 0` | Likely yes | Read execution item blocker/gate flag. |
| `selectProjectApprovalExecutionState` | Confidence/next action | Array presence/length | Unclear | Non-primary, but returned metadata should still read canonical where possible. |
| `selectProjectInvoiceSupport` | Confidence, validation state, next action | `invoices.length`, `facts.length`, `findings.some/length` | Likely yes for validation state | Boundary breach for returned metadata. Exposure values themselves are reads. |
| `selectProjectTicketValidation` | Confidence and validation state | `findings.length`, `findings.some(...)` | Likely yes | Boundary breach for returned metadata. |
| `selectProjectContractAuthority` | Confidence, validation state, next action | `sources.length`, `findings.some/length` | Likely yes for validation state | Boundary breach for returned metadata. |
| `selectProjectReviewAuditState` | Reviewed warning count | `findings.length` | Likely yes | Boundary breach. Read reviewed-warning count or reclassify to needs-upstream-fact. |
| `selectProjectReviewAuditState` | First document to inspect priority | `documents[0]` / `findings[0]` retrieval order | Unclear | If "first" is priority/ranking, needs canonical priority field. |
| `selectProjectReviewAuditState` | Confidence, validation state, next action | `sources.length`, `findings.some/length`, question text | Likely yes for validation state | Boundary breach for returned metadata. |
| `selectPortfolioProjectStatus` | Blocked projects subset | Filter over `base.portfolioSections.projectsAffected` | Should exist upstream for CM-049 | Boundary breach. Read blocked-project aggregate/subset. |
| `selectPortfolioProjectStatus` | Approval-ready projects subset | Filter over project counts/staleness | Should exist upstream for CM-053 | Boundary breach. Read approval-ready aggregate/subset. |
| `selectPortfolioProjectStatus` | Stale projects subset | Filter over `isStale` | Should exist upstream for CM-054 | Boundary breach. Read stale-validation aggregate/subset. |
| `selectPortfolioProjectStatus` | Matching project count | `fallbackProjects.length` | Should exist upstream | Boundary breach. Array length count is compute. |
| `selectPortfolioProjectStatus` | Row rank | `index + 1` after local selection | Should exist upstream if rank is returned | Boundary breach if row rank is meaningful. |
| `selectPortfolioProjectStatus` | Blocked boolean | `project.blockerCount > 0` | Yes, read `validationState` or aggregate status | Boundary breach. |
| `selectPortfolioProjectStatus` | Ready status label | `blockerCount === 0 && warningCount === 0` | Should exist upstream | Boundary breach. Read readiness state/status. |

## Arithmetic-Shaped Row Checks

| Probe Shape | Result | Notes |
|---|---:|---|
| Total invoice exposure / supported / unsupported partition | READ | `selectProjectInvoiceSupport` reads `snapshot.facts.total_at_risk`, `snapshot.facts.exposure.total_transaction_supported_amount`, and `snapshot.facts.unsupported_amount`. |
| Approaching contract ceiling, billed vs ceiling | PARTIAL READ | Reads `nte_amount`/`contract_ceiling` and `total_billed`; does not compute remaining/overage. If the row requires remaining/overage value, that canonical field is not read and the answer is under-specified. |
| Which issue type happening most | READ upstream, not selector-owned | `selectPortfolioProjectStatus` does not compute issue type ranking. `buildPortfolioAskAnswer` reads `params.portfolio.issueTypeRanking.find(...)`; upstream `portfolioCommandCenter` computes and sorts ranking. Existing `answerable-now` path should read the aggregate ranking, not sort in Ask. |
| Blocker/warning/execution-item counts | MIXED | Portfolio selector reads counts from `base.portfolioSections.projectsAffected[].blockerCount/warningCount/openExecutionItemCount`; project selectors compute blocker/warning counts with `filter().length`; portfolio selector computes booleans and subset counts from those counts. |
| At-risk amount totals (portfolio) | READ | `selectPortfolioProjectStatus` reads `base.portfolioSections.financialExposure.totalAtRiskAmount` or `params.portfolio.totalAtRisk`; no selector-side sum. |

## Wiring Review

`lib/ask/answerBuilder.ts` imports `selectProjectAnswer` and uses the selector answer when `selectorAnswer.value` and `selectorAnswer.sourceId` exist. The wiring itself is a read-through/dispatch path. It does not fix selector-side computed values; those computed values flow into the final response and sections.

`lib/ask/portfolioAnswerBuilder.ts` imports `selectPortfolioProjectStatus` after constructing `base`. The base builder performs portfolio ranking/filtering and section assembly before calling the selector. That computation is upstream of the six-selector audit, but still inside an Ask boundary file. For Build Prompt 2 closure, the selector should not add another partition/count layer on top of `base`; it should read prebuilt portfolio aggregate subsets/counts or return the base answer.

## Acceptance Checklist

- [x] Every returned/evidence value across 6 selectors + utils classified READ or COMPUTE
- [x] Every COMPUTE flagged with what, source records, canonical-rollup-exists yes/no
- [x] `selectorUtils.ts` functions each marked SHAPE or DERIVE
- [x] Five arithmetic-shaped rows checked
- [x] No source code changed in this pass
- [x] Harness still 60/60 unchanged (`npx vitest run --config scripts/ask/vitest.phase3.config.ts`; 60 passing, 0 failing, 0 confirmed gaps)
- [ ] VERDICT zero COMPUTE

## Final Verdict

Not closed.

Build Prompt 2 should not close on the current selector implementation. The 6-selector collapse is structurally good, but the selectors still compute material returned values:

- project blocker/warning counts,
- project validation states derived from findings,
- reviewed warning count,
- approval exception/blocker labels,
- portfolio blocked/ready/stale partitions,
- portfolio matching project count,
- portfolio row ranks and readiness/blocked booleans.

Recommended follow-on: replace these with reads from canonical validator snapshots, execution summaries, review/audit summaries, and portfolio-safe aggregate subsets/counts. If any required count/subset/status does not exist upstream, reclassify that matrix row to `needs-upstream-fact`; do not keep the selector green by deriving it locally.
