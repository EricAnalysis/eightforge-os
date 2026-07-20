# Validator finding semantics — draft `problem`/`impact` matrix for the 45 unauthored rules

**Date:** 2026-07-19
**Status:** DRAFT — for operator review before Codex wiring. Not yet approved. Do not paste this
directly into `findingSemantics.ts` without review.
**Purpose:** per `docs/audits/validator-all-findings-reviewer-context-audit-2026-07-19.md` §4.1,
45 of 51 Validator rule types have no authored `problem`/`impact` text in
`lib/validator/findingSemantics.ts` and fall back to a de-slugified rule ID
(`lib/truthToAction.ts:104–108`). This document drafts that content from the actual rule logic —
grep'd and read directly from each rule pack — so Codex wires reviewed language rather than
inventing it.
**Explicitly separate from** the combined Phase 1+2 Codex task in the parent audit §7. That task
does not touch `findingSemantics.ts`; this content is a parallel, independent track.

Each entry cites the file/line where the rule's condition was verified. Six entries marked
**(unverified detail)** are grounded in the rule name, evidence field names, and category but the
exact comparison/tolerance logic was not read line-by-line in this pass — flagged so the final
wording gets one more verification pass against the source before wiring, not because the general
description is guessed.

Format matches the existing `findingSemantics.ts` shape:

```
RULE_ID: {
  business_severity: 'low' | 'medium' | 'high',
  source_family: 'contract' | 'invoice' | 'transaction' | 'ticket' | ...,
  approval_gate_effect: 'blocks_approval' | 'requires_operator_review' | 'informational',
  problem: '...',
  impact: '...',
  required_action: '<already exists — unchanged>',
}
```

`required_action` already exists for all 51 rules and is not redrafted here unless it's actively
misleading (none were found to be).

---

## Group 1 — Invoice-line / rate-match findings (`InvoiceLineFindingContext` / `ContractRateFindingContext`)

### `FINANCIAL_UNIT_TYPE_MISMATCH`
*Verified: `financialIntegrity.ts:334–374` — fires when `billedUnit` normalizes differently from
the matched contract rate row's `unit_type`.*
- **problem:** "This invoice line is billed in a unit that does not match the unit specified on the matched contract rate."
- **impact:** "Billed quantity cannot be priced correctly against the contract rate until the unit is reconciled — the extended amount may be wrong even if the rate code is correct."

### `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT`
*Verified: `crossDocumentRateVerification.ts:703–710`, `comparison_status: 'rate_mismatch'`.*
- **problem:** "This invoice line's billed rate does not match the rate on the governing contract schedule row it was matched to."
- **impact:** "The line is linked to a contract rate, but the dollar amount billed does not follow that rate — the difference is unexplained until reviewed."

### `CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS`
*Verified: `crossDocumentRateVerification.ts:696–751`, distinct from `CATEGORY_NEEDS_REVIEW`.*
- **problem:** "The billed category for this invoice line does not align with the canonical category assigned to the matched contract rate."
- **impact:** "Category misalignment can mean the wrong rate schedule row was matched even if the dollar amount happens to look correct."

### `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS`
*Verified: `crossDocumentRateVerification.ts:731–737`, `comparison_status: 'missing_support'`.*
- **problem:** "This invoice line has a matched contract rate, but no ticket or transaction row was found to support the billed quantity."
- **impact:** "Billed work lacks field-level support — the line may be accurate, but there is currently no ticket evidence proving the work was performed."

### `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED`
*Verified: `crossDocumentRateVerification.ts:738–744`, `comparison_status: 'unsupported_work'`.*
- **problem:** "This invoice line has neither a confirmed contract rate nor supporting ticket evidence."
- **impact:** "This is the highest-risk combination in cross-document verification — nothing currently ties this billed line to either an authorized rate or field support."

### `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE`
*Verified: field names `invoice_number`/`rate_code`/`unit_price` persisted, `contractInvoiceReconciliation.ts:1128–1142`.*
- **problem:** "The unit price billed on this invoice line does not match the rate specified for this code on the governing contract."
- **impact:** "The extended amount for this line may be overbilled or underbilled relative to the authorized contract rate."

### `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` *(has semantics already — included for completeness, not a gap)*
Already authored. No draft needed.

---

## Group 2 — Invoice-header findings (`InvoiceLineFindingContext`, invoice grain)

### `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR`
*Verified: `contractInvoiceReconciliation.ts:784`, `fieldName: 'contractor_name'`.*
- **problem:** "The vendor named on this invoice does not match the contractor named on the governing contract."
- **impact:** "Payment may be directed to or claimed by an entity that is not the authorized contractor on this project."

### `FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT`
*Verified: `contractInvoiceReconciliation.ts:833,869`, `fieldName: 'client_name'`.*
- **problem:** "The client named on this invoice does not match the client named on the governing contract."
- **impact:** "This may indicate the invoice belongs to a different project or engagement than the one it was uploaded against."

### `FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON`
*Verified: same rule pack, precondition for the rule above.*
- **problem:** "The invoice does not state a client or recipient name, so it cannot be compared against the contract's named client."
- **impact:** "Client-identity verification cannot run for this invoice until the recipient name is captured — this does not itself indicate a mismatch."

### `FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING`
*Verified: `contractInvoiceReconciliation.ts:917`, `fieldName: 'service_period'`.*
- **problem:** "This invoice does not state the service period the billed work covers."
- **impact:** "Without a stated service period, the invoice cannot be confirmed to fall within the contract's active term."

### `FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM`
*Verified: `contractInvoiceReconciliation.ts:967`, `fieldName: 'service_period'`.*
- **problem:** "The service period stated on this invoice falls outside the governing contract's active term."
- **impact:** "Work billed outside the contract's authorized period may not be payable under the current agreement without an amendment or extension."

### `FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS`
*Verified: `contractInvoiceReconciliation.ts:1022,1032`, `fieldName: 'line_total'`/`'total_amount'`.*
- **problem:** "The invoice's stated total does not match the sum of its individual line items."
- **impact:** "The invoice may contain an arithmetic error, an omitted line, or a total carried over from a different version of the document."

### `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE`
*Verified: `exposure.ts:889–919`, fires when `billed_amount_source !== 'invoice_total'`.*
- **problem:** "This invoice's billed total was not read directly from a stated invoice total — the system fell back to summing individual line totals."
- **impact:** "Exposure math for this invoice depends on every line total being individually correct and complete, rather than one authoritative stated total."

### `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED`
*Verified: `exposure.ts:922–964`, fires when `unreconciled_amount > supportGapTolerance`.*
- **problem:** "A portion of this invoice's billed dollars has not been fully reconciled to supporting contract rate or ticket evidence."
- **impact:** "The unsupported dollar amount ({variance} USD) represents billed work whose backing has not yet been confirmed line by line."

### `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO`
*Verified: `exposure.ts:966–1004`, fires when `at_risk_amount > atRiskTolerance`.*
- **problem:** "This invoice has billed dollars flagged as financially at-risk — unreconciled against both contract rate and ticket support."
- **impact:** "At-risk dollars ({variance} USD) are the subset of unsupported billing most likely to be disallowed on review or audit."

### `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED`
*Verified: `exposure.ts:1007–1036`, project-level rollup of the invoice-level rule above.*
- **problem:** "Across the project, a portion of total billed dollars has not been fully reconciled to supporting evidence."
- **impact:** "This is the project-wide total of the unsupported-amount condition — {variance} USD in billed dollars across all invoices remains unreconciled."

### `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO`
*Verified: `exposure.ts:1038+`, project-level rollup of the invoice-level rule above.*
- **problem:** "Across the project, billed dollars remain flagged as financially at-risk after reconciliation."
- **impact:** "This is the project-wide total at-risk exposure — {variance} USD — the figure most relevant to overall project financial risk."

---

## Group 3 — Transaction/reconciliation findings (`TransactionRowFindingContext`)

### `INVOICE_LINE_REQUIRES_BILLING_KEY`
*Verified: `invoiceTransactionReconciliation.ts:965`, `fieldName: 'invoice_number'`/`'rate_code'`/`'description'`.*
- **problem:** "This invoice line has no rate code, description, or service item that can be used to match it against contract or transaction records."
- **impact:** "Without a billing key, this line cannot be automatically reconciled against contract rates or ticket support — it requires manual identification."

### `INVOICE_DUPLICATE_BILLED_LINE`
*Verified: `invoiceTransactionReconciliation.ts:1025`, `fieldName: 'invoice_number'`/`'rate_code'`/`'line_total'`.*
- **problem:** "This invoice line appears to duplicate another billed line — same billing key and matching amount."
- **impact:** "If both lines are paid, the same work may be billed and reimbursed twice."

### `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE`
*Verified: subject `invoice_rate_group`, `invoiceTransactionReconciliation.ts`.*
- **problem:** "No group of supporting transaction or ticket rows was found for this invoice line's rate code."
- **impact:** "This billed rate group currently has no field-level transaction data behind it to confirm the quantity billed."

### `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE`
*Verified: subject `invoice_rate_group`, field `line_total`, invoiceTransactionReconciliation.ts.*
- **problem:** "The total dollar amount from supporting transaction rows does not match the billed line total for this rate group."
- **impact:** "The invoiced dollar amount and the sum of the field-recorded transaction amounts disagree — one of the two may be incorrect."

### `TRANSACTION_QUANTITY_MATCHES_INVOICE`
*Verified: subject `invoice_rate_group`, invoiceTransactionReconciliation.ts.*
- **problem:** "The quantity recorded across supporting transaction rows does not match the quantity billed on this invoice line."
- **impact:** "The billed quantity is not fully supported by field-recorded transaction quantities for this rate group."

### `TRANSACTION_RATE_OUTLIERS` **(unverified detail)**
- **problem:** "One or more transaction rows for this billing key have an effective rate that falls well outside the typical range for this rate code."
- **impact:** "An outlier rate may indicate a data entry error, an unusual billing circumstance, or a rate applied incorrectly — worth a manual look before approval."
- *Note: exact outlier threshold/statistic not verified in this pass — confirm against source before finalizing wording.*

### `SITE_MATERIAL_ANOMALIES` **(unverified detail)**
- **problem:** "This transaction row records a site/material combination that does not match the pattern typically seen elsewhere in this project."
- **impact:** "An unusual site or material pairing may indicate a misclassified load, a data entry error, or debris moved between sites in a way that needs documentation."
- *Note: exact anomaly-detection logic not verified in this pass — confirm against source before finalizing wording.*

### `TRANSACTION_MISSING_INVOICE_LINK`
*Verified: `invoiceTransactionReconciliation.ts:1310–1340`. Subject grain is currently inconsistent
in live data (§4.7 of the parent audit) — this wording should be reviewed again once that modeling
question is resolved, since "this row" language may need to become "these rows" depending on the
outcome.*
- **problem:** "One or more transaction rows have no invoice number linking them to a billed invoice line."
- **impact:** "Field-recorded work with no invoice link cannot currently be confirmed as billed, or may represent work performed but not yet invoiced."

---

## Group 4 — Ticket findings (`TransactionRowFindingContext`, mobile/load grain)

All five below verified structurally at `ticketIntegrity.ts:20–105` (mobile/load ID keys,
field-key constants for CYD/tonnage/material/disposal) but the exact comparison tolerance per
field was not traced line-by-line — flagged **(unverified detail)** on each; the *what is being
compared* is solid, the *by how much* is not.

### `TICKET_QTY_CYD_MISMATCH` **(unverified detail)**
- **problem:** "The cubic-yard quantity recorded on the mobile ticket does not match the quantity recorded on its linked load ticket."
- **impact:** "One of the two source records may have a data entry error, or the load may have been split or combined without matching documentation."

### `TICKET_QTY_TONNAGE_MISMATCH` **(unverified detail)**
- **problem:** "The tonnage recorded on the mobile ticket does not match the tonnage recorded on its linked load ticket."
- **impact:** "Tonnage-based billing for this load depends on reconciling which of the two recorded values is correct."

### `TICKET_MATERIAL_MISMATCH` **(unverified detail)**
- **problem:** "The material type recorded on the mobile ticket does not match the material type recorded on its linked load ticket."
- **impact:** "Material type can affect the applicable rate — a mismatch here may mean the load was billed under the wrong rate code."

### `TICKET_DISPOSAL_SITE_MISMATCH` **(unverified detail)**
- **problem:** "The disposal site recorded on the mobile ticket does not match the disposal site recorded on its linked load ticket."
- **impact:** "Disposal site can affect eligibility and rate — this mismatch should be resolved before the load is treated as fully documented."

### `TICKET_ORPHANED_LOAD`
*Verified: `LOAD_PARENT_KEYS` exists (`ticketIntegrity.ts:36–42`) specifically to link a load ticket back to a mobile ticket; this rule fires on absence of that link.*
- **problem:** "This load ticket has no linked mobile ticket — it cannot be traced back to a pickup record."
- **impact:** "A load without a linked mobile ticket lacks the pickup-side documentation typically required to support the disposal quantity billed."

---

## Group 5 — Identity/cross-document consistency (`ContractRateFindingContext`-adjacent, fact grain)

### `IDENTITY_PROJECT_CODE_MISMATCH`
*Verified: `identityConsistency.ts:112–159` — ticket project code doesn't match contract/invoice project code facts.*
- **problem:** "A project code recorded on ticket data does not match the project code stated on the contract or invoice."
- **impact:** "Tickets carrying an unexpected project code may belong to a different project, or the code may have been entered incorrectly."

### `IDENTITY_PARTY_NAME_INCONSISTENCY`
*Verified: `identityConsistency.ts:162–208` — ticket contractor name differs from contract contractor name.*
- **problem:** "A contractor or party name recorded on ticket data does not match the contractor named on the governing contract, after normalization."
- **impact:** "Work performed by an unrecognized party name may indicate an unauthorized subcontractor or a data entry inconsistency worth confirming."

### `IDENTITY_DUPLICATE_TICKET`
*Verified: `identityConsistency.ts:210–254` — same mobile ticket ID appears on 2+ rows.*
- **problem:** "This mobile ticket ID appears more than once in the project's ticket data."
- **impact:** "If both occurrences represent the same physical load, billing based on both would double-count the quantity."

---

## Group 6 — Contract/source-readiness findings (`ProjectRollupFindingContext`, document/category grain)

### `SOURCES_NO_CONTRACT`
*Verified: `requiredSources.ts:65`, project-level, fires on zero contract documents.*
- **problem:** "No governing contract document has been uploaded to this project."
- **impact:** "Validation cannot confirm billed rates, ceilings, or authorized scope without a governing contract on file."

### `SOURCES_NO_RATE_SCHEDULE`
*Verified: `requiredSources.ts:97`.*
- **problem:** "No rate schedule was found among this project's uploaded documents."
- **impact:** "Rate-based billing cannot be verified against an authorized schedule until one is uploaded or confirmed extracted."

### `SOURCES_NO_INVOICE_DATA`
*Verified: `requiredSources.ts:127`.*
- **problem:** "No invoice data has been uploaded to this project."
- **impact:** "There is nothing yet to validate — billing review requires at least one invoice."

### `SOURCES_NO_TICKET_DATA`
*Verified: `requiredSources.ts:158`.*
- **problem:** "No ticket or transaction support data has been uploaded to this project."
- **impact:** "Billed quantities cannot be confirmed against field-level support until ticket data is uploaded."

### `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED`
*Verified: `rateBasedContractValidation.ts:312–346` — fires when `contractCeilingType === 'rate_based'` and `rateSchedulePresent` is false.*
- **problem:** "This contract is rate-based, but no rate schedule has been extracted from the governing contract document."
- **impact:** "Rate-based billing cannot be validated against contract pricing until the rate schedule is confirmed present."

### `FINANCIAL_RATE_BASED_ROWS_REQUIRED`
*Verified: `rateBasedContractValidation.ts:348–379` — fires when `rateRowCount == null || rateRowCount < 5`.*
- **problem:** "The extracted rate schedule for this contract has fewer than 5 rate rows."
- **impact:** "A rate schedule this small may be incompletely extracted rather than genuinely short — worth confirming against the source document before relying on it for validation."

### `FINANCIAL_RATE_BASED_PAGES_REQUIRED`
*Verified: `rateBasedContractValidation.ts:414–445` — fires when the extracted rate-schedule page range fails `rateSchedulePagesValid`.*
- **problem:** "The pages containing this contract's rate schedule could not be confidently identified."
- **impact:** "Without confirmed page identification, it is harder to verify the extracted rate rows against the original document during review."

### `FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE`
*Verified: `rateBasedContractValidation.ts:485–504` — fires when `!unitCoverage.allMatchedLinesRecognized`, carrying `unknown_units` in `actual`.*
- **problem:** "One or more units billed on matched invoice lines are not recognized among the contract's extracted rate schedule units."
- **impact:** "Lines billed in an unrecognized unit cannot be confidently priced against the contract, even though a rate match was otherwise found."

`CONTRACT_RATE_SCHEDULE_HINT_MISMATCH`, `FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR`, and
`FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED` already have authored semantics — not drafted
here.

---

## Group 7 — Already authored (no draft needed, listed for completeness)

`FINANCIAL_RATE_CODE_MISSING`, `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`,
`FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT`, `CONTRACT_RATE_SCHEDULE_HINT_MISMATCH`,
`FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR`, `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED`.

Not drafted: `FINANCIAL_NTE_EXCEEDED`, `FINANCIAL_NTE_APPROACHING` — logic verified at
`financialIntegrity.ts:414–464` (billed total vs. NTE, with an 80% approaching threshold), but these
are already reasonably self-explanatory via `expected`/`actual`/`variance` and were deprioritized
in this pass; can be added in a follow-up round if requested.

---

## Next step

This is draft content, not final copy. Recommend one review pass against each rule's actual
`expected`/`actual` output on a real finding (not just the static condition) before wiring into
`findingSemantics.ts`, particularly for the six **(unverified detail)** entries in Groups 3–4 where
the comparison threshold wasn't traced to source in this pass. Once approved, wiring this into
`findingSemantics.ts` is a content-only change — no rule logic, evidence shape, or component code
needs to move.
