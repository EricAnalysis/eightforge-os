# Validator — reviewer-understandable business context audit (all finding types)

**Date:** 2026-07-19
**Type:** Phase A audit. No implementation, migration, or revalidation performed.
**Scope:** All 51 active Validator finding types — evidence construction, persistence, and the
middle "Evidence & Truth" panel render path.
**Predecessor:** `docs/audits/validator-rate-code-missing-panel-audit-2026-07-19.md` (single rule,
`FINANCIAL_RATE_CODE_MISSING`). This document generalizes that audit's method across every rule
and corrects one assumption it made implicitly — see §4.0.
**Alignment:** `PRODUCT_ALIGNMENT.md` §4, `CLAUDE.md`, `AGENTS.md`.
**Correction (post-review):** an earlier version of this document stated "no screenshots were
received" while simultaneously citing screenshot content as confirming evidence in §4.0/§4.3/§4.4.
That was an error — six screenshots of the live Validator (`Invoice line is missing a confirmed
contract rate match`, subject `validator_finding:dffc6253-…`, rule `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`,
Evidence Inspector cards showing `Document aa3b36ac`, `Canonical Field: invoice_number` →
`Extracted Value: 2026-003`, `description` → `Management Reduction Preparation Management
Segregating Material at DMS`, `quantity` → `70496`) were in fact received and used to ground the
conclusions below. All screenshot-derived claims in this document are accurate to what was shown;
the stated caveat about their absence was wrong and is retracted. Everything below reflects both
direct repository inspection and the screenshot evidence, reconciled together.

---

## 0. Method

- `lib/validator/findingSemantics.ts` parsed programmatically for `problem` / `impact` /
  `required_action` presence across all 51 keys.
- Every rule pack (`lib/validator/rulePacks/*.ts`) and `lib/validator/exposure.ts` searched for
  `ruleId:` / `subjectType:` / `fieldName:` / evidence-construction calls.
- Live finding distribution pulled from `project_validation_findings` (Supabase project
  `jpzeckefppmiujwajgvk`), grouped by `rule_id, subject_type, severity, status` — read-only, no
  write, no revalidation triggered.
- Render path re-confirmed against `components/validator/ValidatorEvidenceDrawer.tsx` and
  `components/evidence/evidenceInspectorModel.ts`.

---

## 1. Finding inventory, grouped by reviewer-context pattern

Three evidence-construction patterns exist across the 51 rules. This is the single most important
structural fact in this audit: **the amount of backend work required depends entirely on which
pattern a rule uses, not on the rule itself.**

- **Pattern A — per-field, rich.** Each business field (`invoice_number`, `description`,
  `quantity`, `unit_price`, `line_total`, `rate_code`, `contractor_name`, `client_name`,
  `service_period`, `canonical_category`) is written as its own evidence row via
  `structuredRowEvidenceInput`, each carrying a real scalar `field_value`. Confirmed in
  `crossDocumentRateVerification.ts:757–800`, `contractInvoiceReconciliation.ts` (7 field-name
  sites), `invoiceTransactionReconciliation.ts` (7 field-name sites). **Data is not lost — it is
  unassembled.** This matches the screenshots' Structured Data cards showing real values
  (`invoice_number` → `2026-003`, `description` → `Management Reduction Preparation...`,
  `quantity` → `70496`) as separate undifferentiated cards.
- **Pattern B — thin, value-poor.** One evidence row with `field_value: null` plus, conditionally,
  one JSON-blob row. This is `financialIntegrity.ts`, fully audited in the predecessor document.
  Here, data genuinely is discarded at persistence.
- **Pattern C — fact/aggregate grain.** Subject is `project`, `contract`, or a synthetic group ID,
  not a single reviewable record. Evidence comes from `evidenceFromFacts` over canonical facts
  (`identityConsistency.ts:152,201`) or `makeEvidenceInput` directly (`requiredSources.ts`,
  `rateBasedContractValidation.ts`). There is no single "invoice line" to resolve — the reviewer
  context model here is inherently a rollup, not a record.

| # | Rule ID | Pattern | Subject grain | File | Decision/Action eligible | Semantics has problem/impact | Live (open/resolved/other) |
|---|---|---|---|---|---|---|---|
| 1 | `FINANCIAL_RATE_CODE_MISSING` | B | `invoice_line` | financialIntegrity.ts:292 | conditional (false if informational) | No/No | 24 open(warn) / 7 open(info) / 7 resolved |
| 2 | `FINANCIAL_UNIT_TYPE_MISMATCH` | B | `invoice_line` | financialIntegrity.ts | true/true | No/No | not observed live |
| 3 | `FINANCIAL_NTE_FACT_MISSING` | C | `project` | financialIntegrity.ts | true/true | No/Yes(impact) | 3 open / 1 resolved |
| 4 | `FINANCIAL_NTE_EXCEEDED` | C | `project`/`contract` | financialIntegrity.ts | true/true | No/No | not observed live |
| 5 | `FINANCIAL_NTE_APPROACHING` | C | `project`/`contract` | financialIntegrity.ts | true/true | No/No | not observed live |
| 6 | `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` | A | `invoice_line` | crossDocumentRateVerification.ts:722 | true/true | **Yes/Yes** | 18 open / 10 resolved / 1 dismissed |
| 7 | `CROSS_DOCUMENT_RATE_MATCHES_CONTRACT` | A | `invoice_line` | crossDocumentRateVerification.ts:704 | true/true | No/No | 1 resolved |
| 8 | `CROSS_DOCUMENT_CANONICAL_CATEGORY_ALIGNS` | A | `invoice_line` | crossDocumentRateVerification.ts | true/true | No/No | 3 resolved |
| 9 | `CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW` | A | `invoice_line` | crossDocumentRateVerification.ts:746 | true/true | No/No | 5 open / 4 resolved |
| 10 | `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS` | A | `invoice_line` | crossDocumentRateVerification.ts:732 | true/true | No/No | 1 resolved |
| 11 | `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED` | A | `invoice_line` | crossDocumentRateVerification.ts:739 | true/true | No/No | 12 resolved |
| 12 | `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR` | A | `invoice` | contractInvoiceReconciliation.ts:784 | true/true | No/No | 5 open / — |
| 13 | `FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT` | A | `invoice` | contractInvoiceReconciliation.ts:833,869 | true/true | No/No | 5 open / 2 resolved |
| 14 | `FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON` | A | `invoice` | contractInvoiceReconciliation.ts | true/true | No/No | 1 resolved |
| 15 | `FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING` | A | `invoice` | contractInvoiceReconciliation.ts:917 | true/true | No/No | 1 resolved |
| 16 | `FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM` | A | `invoice` | contractInvoiceReconciliation.ts:967 | true/true | No/No | not observed live |
| 17 | `FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS` | A | `invoice` | contractInvoiceReconciliation.ts:1022,1032 | true/true | No/No | 4 open |
| 18 | `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` | A | `invoice_line` | contractInvoiceReconciliation.ts:1081,1088 | true/true | **Yes/Yes** | 6 resolved / 1 open |
| 19 | `FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE` | A | `invoice_line` | contractInvoiceReconciliation.ts:1128,1135,1142 | true/true | No/No | not observed live |
| 20 | `INVOICE_LINE_REQUIRES_BILLING_KEY` | A | `invoice_line` | invoiceTransactionReconciliation.ts:965 | true/true | No/No | 2 open |
| 21 | `INVOICE_DUPLICATE_BILLED_LINE` | A | `invoice_line` | invoiceTransactionReconciliation.ts:1025 | true/true | No/No | not observed live |
| 22 | `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` | A | `invoice_rate_group` | invoiceTransactionReconciliation.ts | true/true | No/No | 19 open / 4 resolved |
| 23 | `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE` | A | `invoice_rate_group` | invoiceTransactionReconciliation.ts | true/true | No/No | 6 resolved |
| 24 | `TRANSACTION_QUANTITY_MATCHES_INVOICE` | A | `invoice_rate_group` | invoiceTransactionReconciliation.ts | true/true | No/No | 6 resolved |
| 25 | `TRANSACTION_RATE_OUTLIERS` | A | ? | invoiceTransactionReconciliation.ts | true/true | No/No | not observed live |
| 26 | `SITE_MATERIAL_ANOMALIES` | A | ? | invoiceTransactionReconciliation.ts | true/true | No/No | not observed live |
| 27 | `TRANSACTION_MISSING_INVOICE_LINK` | A | **`transaction_row` *and* `transaction_group`** (grain inconsistent — §4.0) | invoiceTransactionReconciliation.ts:1332 | true/`totalExtendedCost !== 0` | No/No | 283 resolved(`transaction_row`) + 2 resolved / 1 open (`transaction_group`) |
| 28 | `TICKET_QTY_CYD_MISMATCH` | C-row | `mobile_ticket` | ticketIntegrity.ts | true/true | No/No | not observed live |
| 29 | `TICKET_QTY_TONNAGE_MISMATCH` | C-row | `mobile_ticket` | ticketIntegrity.ts | true/true | No/No | not observed live |
| 30 | `TICKET_MATERIAL_MISMATCH` | C-row | `mobile_ticket` | ticketIntegrity.ts | true/true | No/No | not observed live |
| 31 | `TICKET_DISPOSAL_SITE_MISMATCH` | C-row | `mobile_ticket` | ticketIntegrity.ts | true/true | No/No | not observed live |
| 32 | `TICKET_ORPHANED_LOAD` | C-row | `load_ticket` | ticketIntegrity.ts | true/true | No/No | not observed live |
| 33 | `IDENTITY_PROJECT_CODE_MISMATCH` | C | `project_code` | identityConsistency.ts:147 | true/true | No/No | not observed live |
| 34 | `IDENTITY_PARTY_NAME_INCONSISTENCY` | C | `contractor_name` | identityConsistency.ts:195 | true/true | No/No | not observed live |
| 35 | `IDENTITY_DUPLICATE_TICKET` | C-row | `mobile_ticket` | identityConsistency.ts:242 | true/true | No/No | not observed live |
| 36 | `SOURCES_NO_CONTRACT` | C | `project` | requiredSources.ts:65 | true/true | No/No | not observed live |
| 37 | `SOURCES_NO_RATE_SCHEDULE` | C | `project` | requiredSources.ts:97 | true/true | No/No | not observed live |
| 38 | `SOURCES_NO_INVOICE_DATA` | C | `project` | requiredSources.ts:127 | true/true | No/No | not observed live |
| 39 | `SOURCES_NO_TICKET_DATA` | C | `project` | requiredSources.ts:158 | true/true | No/No | 1 resolved |
| 40 | `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` | C | `contract`/`project` | rateBasedContractValidation.ts:325 | true/true | No/No | not observed live |
| 41 | `FINANCIAL_RATE_BASED_ROWS_REQUIRED` | C | `contract`/`project` | rateBasedContractValidation.ts:362 | true/true | No/No | not observed live |
| 42 | `FINANCIAL_RATE_BASED_PAGES_REQUIRED` | C | `contract`/`project` | rateBasedContractValidation.ts:395 | true/true | No/No | not observed live |
| 43 | `FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR` | C | `contract`/`project` | rateBasedContractValidation.ts:428 | true/true | **Yes/Yes** | 2 resolved |
| 44 | `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED` | C | `contract`/`project` | rateBasedContractValidation.ts:465 | true/true | **Yes/Yes** | 1 resolved |
| 45 | `FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE` | C | `contract`/`project` | rateBasedContractValidation.ts:499 | true/true | No/No | 1 resolved |
| 46 | `CONTRACT_RATE_SCHEDULE_HINT_MISMATCH` | C | `contract`/`project` | rateBasedContractValidation.ts:558 | true/true | **Yes/Yes** | not observed live |
| 47 | `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | C | `project` | exposure.ts | true/true | No/No | 2 resolved / 1 open / 1 dismissed |
| 48 | `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO` | C | `project` | exposure.ts | true/true | No/No | 2 resolved / 1 open / 1 dismissed |
| 49 | `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` | A (invoice) | `invoice` | exposure.ts | true/true | No/No | 5 resolved / 5 open |
| 50 | `INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO` | A (invoice) | `invoice` | exposure.ts | true/true | No/No | 5 resolved / 5 open |
| 51 | `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE` | A (invoice) | `invoice` | exposure.ts | true/true | No/No | not observed live |

"Not observed live" means absent from the current `project_validation_findings` snapshot on the
one project queried — not evidence the rule is dead. `decision_eligible`/`action_eligible` default
to `true` in `makeFinding` (`shared.ts:688–723`) unless a rule pack overrides them; only rows 1 and
27 override.

**Reviewer-pattern groups** (for §3 context models): Invoice-line/rate-match (rows 1–2, 6–11,
18–19), Invoice-header (12–17, 49–51), Transaction/reconciliation (20–27), Ticket (28–32, 35),
Identity/cross-document (33–34), Contract/source-readiness (36–46), Project/exposure rollup
(3–5, 47–48).

---

## 2. Reviewer-context matrix

Legend: **Backend work** — D = display-only, W = wire already-loaded data, R = targeted resolver,
P = additive persistence.

| Finding type(s) | Reviewer must understand | Current display | Usable business data available | Source | Missing/discarded | Recommended primary display | Recommended conflict display | Recommended evidence display | Backend |
|---|---|---|---|---|---|---|---|---|---|
| `FINANCIAL_RATE_CODE_MISSING` | Which invoice line lacks a rate code, and whether the semantic match is trustworthy | `fact:…:line:4`, `Document aa3b36ac`, raw JSON | Matched rate `rate_code`/`unit_type`/`rate_amount`/`canonical_category` (when informational) | evidence `field_value` JSON, financialIntegrity.ts:318–323 | Invoice line description/qty/unit/rate/extended amount; match basis signals (financialIntegrity.ts:173–235, computed then discarded) | `Invoice {invoice_number}` / `{description}` / `Qty {quantity} {unit}` / `Billed {unit_rate}` / `Rate code: Not captured during extraction` | Expected: `{rate_code} · {rate_amount}/{unit_type}` · Actual: `No rate code on invoice line` | Matched rate row (already persisted) + resolved line detail (R) | D (Phase1) + R (Phase3) |
| `FINANCIAL_UNIT_TYPE_MISMATCH` | Which invoice line's unit conflicts with the contract's expected unit | Not inspected — same rule pack, same `structuredRowEvidenceInput` gap as row above | `billedUnit` computed in financialIntegrity.ts; scheduleItem.unit_type available | rule logic, not yet persisted per-field | Same as row above — unit and rate-code identity of the line | `Invoice {invoice_number}` / `{description}` / `Billed unit: {billedUnit}` | Expected: `{scheduleItem.unit_type}` · Actual: `{billedUnit}` | Contract rate row | D + R |
| `FINANCIAL_NTE_FACT_MISSING` / `EXCEEDED` / `APPROACHING` | Whether the project/contract ceiling is at risk and by how much | Generic project-level text; `impact` present for FACT_MISSING only | Contract ceiling value, billed-to-date total | canonical project facts (NTE), project totals | `problem`/`impact` prose for EXCEEDED/APPROACHING (semantics gap, findingSemantics.ts) | `Contract ceiling: {nte_amount}` / `Billed to date: {billed_total}` / `Remaining: {remaining}` | Expected: `<= {nte_amount}` · Actual: `{billed_total}` | Contract document + fact anchor | D (add semantics text) |
| `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` and siblings (rows 7–11) | Which invoice line's rate/category/support could not be confirmed against the contract, and against what | `fact:…` subject, `validator_finding:UUID` in Source Trace, six unlabeled Structured Data cards (per screenshots) | **Full row already persisted**: `invoice_number`, `rate_code`, `description`, `quantity`, `unit_price`, `line_total` (crossDocumentRateVerification.ts:758–799) + `canonical_category` blob + contract evidence (`contractEvidence`, :610–644) + up to 8 support rows (`supportEvidence`, :670–685) | Six discrete evidence rows per finding, already field-labeled | Nothing missing for the invoice side; contract side has `canonical_category`/`rate_amount`/`match_source`/`manual_link_resolution` already — only *assembly*, not data, is missing | `Invoice {invoice_number}` / `{description}` / `Qty {quantity}` / `Rate {unit_price}` / `Total {line_total}` — one header block, not 6 cards | Expected: `{contract item description} · {rate_amount}/{unit}` (from contractEvidence) · Actual: `{comparison_status}` reason (rate_mismatch / category_mismatch / missing_contract_rate / missing_support / unsupported_work / needs_review — already distinct per `ruleByStatus`, :696–751) | Contract rate row + up to 8 support rows, already resolvable, already grouped by `evidence_type` | **D only** |
| `FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR` / `CLIENT_MATCHES` / `CLIENT_MISSING` / `SERVICE_PERIOD_*` / `TOTAL_RECONCILES` (rows 12–17) | Whether invoice header identity/dates/total match the contract | Same generic pattern | `contractor_name`, `client_name`, `service_period`, `line_total`/`total_amount` all persisted per-field (contractInvoiceReconciliation.ts, 12 field sites) | evidence rows, per-invoice | Invoice number/filename not consistently in the same evidence set — needs join | `Invoice {invoice_number}` (from doc or header fact) / `Vendor: {contractor_name}` or `Client: {client_name}` or `Period: {service_period}` | Expected vs actual already both persisted per field | Contract header fact + invoice header fact | **D only** (Phase 1) |
| `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` / `UNIT_PRICE_MATCHES_CONTRACT_RATE` (rows 18–19) | Whether a specific invoice line's code/rate exists in the contract schedule | Same generic pattern; semantics has problem/impact for row 18 | `invoice_number`, `rate_code`, `unit_price` persisted per-field (contractInvoiceReconciliation.ts:1081–1142) | evidence rows | Line description not in this rule's evidence set (only code+price) — minor gap | `Invoice {invoice_number}` / `Rate code: {rate_code}` / `Billed rate: {unit_price}` | Expected: contract schedule rate · Actual: `{unit_price}` | Matched/unmatched contract rate row | **D only**, small **R** for description |
| `INVOICE_LINE_REQUIRES_BILLING_KEY` / `INVOICE_DUPLICATE_BILLED_LINE` / `TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE` / `TRANSACTION_TOTAL_MATCHES_INVOICE_LINE` / `TRANSACTION_QUANTITY_MATCHES_INVOICE` (rows 20–24) | Which invoice line/rate group lacks matching transaction support, or duplicates another | Generic; `invoice_rate_group` subject is itself a synthetic key, not a line | `invoice_number`, `rate_code`, `line_total` persisted per-field (invoiceTransactionReconciliation.ts:965–1039) | evidence rows | The group's *member* invoice line IDs are not surfaced — reviewer sees the group aggregate but not which specific lines compose it | `Invoice {invoice_number}` / `Rate {rate_code}` / `Group total: {line_total}` / `{n} invoice lines in this rate group` | Expected: transaction support exists · Actual: `{n} lines, {support_count} supported` | Member invoice lines + linked transaction rows | D + small **R** to list member lines |
| `TRANSACTION_RATE_OUTLIERS` / `SITE_MATERIAL_ANOMALIES` | Which transaction rows have anomalous rates or site/material combinations | Not directly inspected; likely follows sibling pattern in same file | Presumed per-field (same file, same helper) | evidence rows (unverified — flagged for Phase 1 spot-check) | Unverified | `Transaction {transaction_number}` / `Site: {site}` / `Material: {material}` / `Rate: {rate}` (outlier flagged) | Expected: normal range · Actual: outlier value | Transaction row | D (pending verification) |
| `TRANSACTION_MISSING_INVOICE_LINK` | Which transaction rows have no invoice link | `transaction_group` subject `missing_invoice_number` is a **static ID shared by every orphan row in the project** — the reviewer cannot resolve one row from the finding alone | `source_sheet_name`, `source_row_number`, `transaction_number` all computed (invoiceTransactionReconciliation.ts:483–484, embedded in note text at :677) | Computed at validation time, but only as unstructured prose (`` `Source ${sheet} row ${row}` ``), not a structured field | *Grain inconsistency itself is the primary gap* — see §4.0 | For `transaction_row` grain: `Transaction {transaction_number}` / `Sheet {source_sheet_name} row {source_row_number}` / `{n} rows, total {extended_cost}`. For `transaction_group` grain: an explicit list of affected transaction numbers, not a single value | Expected: linked invoice number · Actual: `missing` | Transaction rows list | D + **R** to structure the note text into fields |
| `TICKET_QTY_CYD_MISMATCH` / `TONNAGE_MISMATCH` / `MATERIAL_MISMATCH` / `DISPOSAL_SITE_MISMATCH` / `ORPHANED_LOAD` (rows 28–32) | Which mobile/load ticket has a quantity, material, or disposal-site conflict | Not directly inspected; `structuredRowEvidenceInput` called with a dynamic `fieldName` (ticketIntegrity.ts:88–102) over the mobile/linked-load row pair | `transaction_data_rows` schema carries `transaction_number`, `cyd`, `net_tonnage`, `material`, `disposal_latitude/longitude`, `source_sheet_name`, `source_row_number` — all resolvable from `MOBILE_TICKET_ID_KEYS`/`LOAD_TICKET_ID_KEYS` (ticketIntegrity.ts:20,28) | Row-level, resolvable | Same "computed but note-only" risk as transaction findings — unverified for this file | `Ticket {transaction_number}` / `Material: {material}` / `Qty: {cyd} CYD` or `{net_tonnage} tons` / `Disposal: {disposal_site}` | Expected vs actual mobile-vs-load comparison value (already the `fieldName`/`fieldValue` pair) | Mobile ticket row + linked load ticket row | D + **R** (targeted `transaction_data_rows` read by ticket ID, not full table) |
| `IDENTITY_PROJECT_CODE_MISMATCH` / `PARTY_NAME_INCONSISTENCY` | Whether project code or contractor/party name is inconsistent across contract/invoice/ticket | Generic; evidence built via `evidenceFromFacts` over canonical facts | `entry.actual` (mismatched value) already in evidence (identityConsistency.ts:148,196) | canonical fact evidence | Which two *sources* disagree (contract vs invoice vs ticket) not labeled distinctly | `Project code on {source A}: {value A}` / `Project code on {source B}: {value B}` | Expected: consistent value · Actual: divergent value shown per source | Canonical fact anchors (already fact-based, no new resolver) | **D only** |
| `IDENTITY_DUPLICATE_TICKET` | Which ticket ID appears more than once | `Duplicate mobile ticket detected on row {rowIdentifier}` note (identityConsistency.ts:244) already contains real row identity | `ticket_id` field persisted (:242) | note text | Row already identified by ID; sheet/row number not attached | `Ticket {ticket_id}` / `Duplicate of row {other_row_id}` | Expected: unique ticket ID · Actual: `{n} occurrences` | Duplicate row set | **D only** |
| `SOURCES_NO_CONTRACT` / `NO_RATE_SCHEDULE` / `NO_INVOICE_DATA` / `NO_TICKET_DATA` | Whether a required document category is entirely missing from the project | Project-level generic text, `required_action` only (no problem/impact in semantics) | Document counts by type already loaded in workspace data | `documents` collection (already loaded, not a new query) | `problem`/`impact` prose absent from findingSemantics.ts | `{n} of {expected} required document types uploaded` / `Missing: {category}` | Expected: category present · Actual: `0 documents of type {category}` | Document list, filtered by type | **D only** (semantics text) |
| `FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED` / `ROWS_REQUIRED` / `PAGES_REQUIRED` / `PRICING_APPLICABILITY_UNCLEAR` / `ACTIVATION_GATE_UNRESOLVED` / `UNIT_COVERAGE_INCOMPLETE` / `CONTRACT_RATE_SCHEDULE_HINT_MISMATCH` (rows 40–46) | Whether the governing contract has a usable, activated, complete rate schedule | Best-served group already — 4 of 7 have full `problem`/`impact` prose | Contract document identity, page/row counts (`factLookups.rateRowCount`, upload guidance) | canonical contract facts | 3 of 7 rules (`SCHEDULE_REQUIRED`, `ROWS_REQUIRED`, `PAGES_REQUIRED`, `UNIT_COVERAGE_INCOMPLETE`) lack problem/impact text | `Contract: {document_name}` / `Rate schedule: {rate_row_count} rows on {page_count} pages` | Expected: schedule present & activated · Actual: specific missing element | Contract document + upload guidance | **D only** |
| `PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` / `AT_RISK_AMOUNT_ZERO` (rows 47–48) | Whether total project exposure reconciles | Project-level rollup; no single record | `total_at_risk_amount`, `contract_supported_amount` already computed in `exposure.ts` summary | project exposure summary (already loaded for Overview) | None — this is a legitimate rollup, not a record-resolution gap | `Project total billed: {total}` / `Supported: {supported_amount}` / `At risk: {at_risk_amount}` | Expected: `at_risk_amount = 0` · Actual: `{at_risk_amount}` | Per-invoice exposure breakdown (already computed, listable) | **D only** |
| `INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED` / `AT_RISK_AMOUNT_ZERO` / `INVOICE_BILLED_TOTAL_PRESENT_FOR_EXPOSURE` (rows 49–51) | Same, at invoice grain | Same pattern, one invoice | `invoice_number`, `contract_supported_amount`, `at_risk_amount` per invoice (`exposure.ts` `LineContext`/invoice summary) | invoice exposure summary | None | `Invoice {invoice_number}: billed {total}, supported {supported}, at risk {at_risk}` | Expected: `at_risk = 0` · Actual: `{at_risk}` | Line-level breakdown within the invoice | **D only** |

---

## 3. Shared view-model opportunities

A single bespoke component per rule is not warranted — 51 rules collapse into **five reusable
context shapes**, matching the patterns in §1.

### `InvoiceLineFindingContext`
- **Required:** `invoice_number`, `description`, `quantity`, `unit`, `unit_rate`, `extended_amount`
- **Optional:** `rate_code`, `canonical_category`, `source_document_id`, `sheet_name`, `row_number`
- **Resolution:** Pattern-A rules — assemble directly from the finding's own persisted evidence
  rows (`field_name` → value map), zero new queries. Pattern-B rules (`FINANCIAL_RATE_CODE_MISSING`,
  `FINANCIAL_UNIT_TYPE_MISMATCH`) — targeted read of `document_extractions` by
  `subject.source_document_id`, per predecessor audit §A.6.
- **Fallback:** `Not captured during extraction` per missing field.
- **Reuse:** rows 1–2, 6–24 (20 of 51 rules).
- **Derive at read time.** Do not persist — Pattern A already has the data; Pattern B should fix
  persistence upstream (predecessor audit Phase 4), not duplicate it into a new summary table.

### `ContractRateFindingContext`
- **Required:** `governing_document_name`, `item_description`, `rate_code`, `rate_amount`, `unit`
- **Optional:** `page_number`, `table_or_section`, `match_basis`, `match_confidence`,
  `canonical_category`
- **Resolution:** Already assembled by `contractEvidence()` (crossDocumentRateVerification.ts:610–644)
  for Pattern-A cross-document rules. For Pattern-B, extend `structuredRowEvidenceInput` per
  predecessor audit Phase 4.
- **Fallback:** `Not captured during extraction`.
- **Reuse:** rows 1, 6–11, 18–19, 40–46.
- **Derive at read time** from evidence; the `invoice_line_rate_links` table remains the correct
  persistence layer for *manual* overrides only (predecessor audit §A.7) — do not duplicate.

### `TransactionFindingContext`
- **Required:** `transaction_number`, `source_sheet_name`, `source_row_number`, `material`,
  `quantity`, `unit`
- **Optional:** `invoice_number` (linked or `Not linked`), `service_date`, `disposal_site`,
  `extended_cost`
- **Resolution:** targeted read of `transaction_data_rows` by `row_id`/`transaction_number` — single
  row, not the full table (constraint honored). For group-grain findings (row 27), resolve the
  **list** of member row IDs, not a synthetic aggregate label.
- **Fallback:** `Not captured during extraction`; `invoice_number` fallback is `Not linked` per the
  product-direction example structure.
- **Reuse:** rows 20–27.
- **Derive at read time.**

### `TicketFindingContext`
- **Required:** `transaction_number` (ticket ID), `material`, `quantity`, `unit`
- **Optional:** `disposal_site`, `linked_load_ticket_id`, `service_date`
- **Resolution:** identical mechanism to `TransactionFindingContext` — `transaction_data_rows` is
  the same table backing both mobile and load tickets (per schema: `transaction_number`, `cyd`,
  `net_tonnage`, `material`, `disposal_latitude/longitude`). **These two context models may be the
  same model** — see recommendation below.
- **Fallback:** `Not captured during extraction`.
- **Reuse:** rows 28–32, 35.
- **Derive at read time.**

### `ProjectRollupFindingContext`
- **Required:** `subject_label` (project name or invoice number), `billed_total`,
  `supported_amount`, `at_risk_amount`
- **Optional:** `contract_ceiling`, `remaining_headroom`
- **Resolution:** already computed by `exposure.ts` and available wherever the exposure summary is
  loaded (Overview already consumes this — reuse, do not recompute).
- **Fallback:** `Not captured during extraction` is inapplicable here; use `Not yet computed` if the
  summary hasn't run.
- **Reuse:** rows 3–5, 36–51 (16 of 51 rules).
- **Derive at read time**, always — this is a canonical aggregate, persisting it would create a
  parallel truth path, which `PRODUCT_ALIGNMENT.md` §9 and `CLAUDE.md` explicitly prohibit.

**Recommendation:** collapse `TransactionFindingContext` and `TicketFindingContext` into one
`TransactionRowFindingContext` — both resolve against `transaction_data_rows` by the same key
shape, and ticket-vs-transaction is a distinction in the rule, not in the data. This reduces the
five proposed models to **four**, which is the smallest set that covers all 51 rules without
forcing a rollup rule into a per-record shape or vice versa.

---

## 4. Data-loss and presentation gaps, ranked by impact

### 4.0 — Correction to the predecessor audit's implicit scope (read this first)

The predecessor audit characterized the discard-at-persistence problem
(`structuredRowEvidenceInput` keeping only 5 of a row's fields) as *the* cause of unusable display.
That is true only for **Pattern B** (financialIntegrity.ts — 5 of 51 rules). For the other 46 rules,
the same helper function is called, but the calling rule packs pass the individual field as
`fieldValue` rather than `null`, so the persisted evidence already carries real business data. The
screenshots confirm this directly: `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`'s Structured Data cards
show `2026-003`, a real description, and `70496` — not `Not provided`. **The dominant gap across
the majority of the Validator is presentation (unassembled per-field cards, raw subject/rule
strings in Source Trace, un-humanized field labels), not data loss.** This changes the phased plan
substantially in the Validator's favor: most of the system is a Phase 1 (display-only) fix.

### 4.1 — Highest impact: 45 of 51 rules have no authored Problem text

`findingSemantics.ts` supplies `problem`/`impact` prose for only 6 rule IDs:
`FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR`, `FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED`,
`CONTRACT_RATE_SCHEDULE_HINT_MISMATCH`, `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT`,
`CROSS_DOCUMENT_CONTRACT_RATE_EXISTS`. The other 45 fall through to
`findingProblem()` (`lib/truthToAction.ts:104–108`):
`normalizeValidationFinding(finding).problem ?? humanizeTruthToken(finding.rule_id)` — a
de-slugified rule ID (e.g. `Ticket Qty Cyd Mismatch`) stands in for a real explanation. This is the
single highest-leverage fix in the entire audit: it is pure content authoring, touches zero code
paths, and affects every finding type at once.

### 4.2 — Source Trace renders raw identifiers as primary content (all 51 rules)

`ValidatorEvidenceDrawer.tsx:485–489` renders `Data Source`, `Field Mapping`, `Subject`
(`formatSubject`, :75–77 → `${subject_type}:${subject_id}`), and `Rule` (`rule_id` raw) as one of
the six standard sections, not as a collapsed technical area. Per the screenshots, `Subject` renders
literally as `validator_finding:dffc6253-31dc-4e48-ad22-24a3a1789451` — exactly the pattern the
product direction prohibits. This is universal, not rule-specific.

### 4.3 — Structured Data renders one card per evidence row instead of one assembled block (Pattern A, ~30 rules)

`StructuredEvidenceCard` (`ValidatorEvidenceDrawer.tsx:305–321`) renders `Record ID`, `Field`,
`Category`, `Values` per evidence entry. For a Pattern-A finding with six evidence rows, a reviewer
sees six near-identical cards each showing one field, with `Record ID` repeating the same UUID six
times and `Category` repeating the same category label six times. The data is present and correct;
it has never been joined into `Invoice {number} · {description} · Qty {qty} · Rate {rate}`.

**Correction to the original grouping proposal (post-review):** §7 originally proposed grouping
evidence by `evidence_type` alone. That is too coarse. `supportEvidence()`
(`crossDocumentRateVerification.ts:670–685`) can attach up to 8 rows all sharing
`evidence_type: 'transaction_row'` (or the mapped `row.source_family`) but distinct `record_id`
values — one row per supporting transaction. Grouping by `evidence_type` alone would blend up to 8
distinct transaction records into a single rendered block, which is worse than the current
one-card-per-entry behavior, not better. **The grouping key must be
`evidence_type + source_document_id + record_id`.** Two evidence rows join the same block only when
all three match. `contractEvidence()` (:610–644) and the per-line evidence in
`crossDocumentRateVerification.ts:757–800` both share a single `record_id` per record (the line ID
or the rate row ID), so this key correctly assembles them into one block without over-merging
`supportEvidence()`'s multiple distinct rows. When `record_id` is null on an entry (it can be —
`FindingEvidenceInput.record_id` is optional per `shared.ts`), fall back to
`evidence_type + source_document_id + field_name` and keep entries separate rather than guessing;
an ambiguous merge is worse than an unmerged pair of cards.

### 4.4 — Document identity is a truncated UUID for every rule (all 51 rules)

`ValidatorEvidenceDrawer.tsx:569–571`: `Document ${source_document_id.slice(0, 8)}` — confirmed
directly in the screenshots as `Document aa3b36ac`. The real filename is not queried anywhere in
this component. Per the predecessor audit, the documents collection is already loaded in
`ValidatorTab.tsx` and passed as a prop, but **not threaded into `ValidatorEvidenceDrawer`**
(`ValidatorTab.tsx:1069–1075` — the prop list is `finding`, `evidence`, `executionItemId`,
`odpNote`, `loading`; no `documents`). This is a wiring gap, not a data or query gap.

### 4.5 — Field labels are raw snake_case, not humanized (Pattern A, ~30 rules)

`Canonical Field` in the Evidence Inspector model (`evidenceInspectorModel.ts:221`) renders
`evidence.field_name` directly — `invoice_number`, `rate_code`, `canonical_category` as literal
strings, confirmed in the screenshots. No label map exists.

### 4.6 — Computed identity exists only inside prose notes, not as structured fields (rows 20–32)

`invoiceTransactionReconciliation.ts:677`: `` `${note} Source ${row.source_sheet_name} row
${row.source_row_number}.` `` — sheet name and row number are computed and available at validation
time, but they are concatenated into a sentence rather than attached as their own `field_name`
entries. A future renderer cannot extract them without string parsing, which this audit does not
recommend. Fix at the generation site (append two more `structuredRowEvidenceInput` calls), not in
the panel.

### 4.7 — Subject grain is inconsistent within a single rule ID (row 27, `TRANSACTION_MISSING_INVOICE_LINK`)

Live data shows this rule persisted under **both** `subject_type = 'transaction_row'` (283 rows,
all resolved) and `subject_type = 'transaction_group'` (3 rows, current code path,
`invoiceTransactionReconciliation.ts:1332–1340`, static `subjectId: 'missing_invoice_number'`). The
current code path produces one finding representing an unbounded number of orphan rows under a
synthetic subject ID shared across the entire project — a single finding cannot be resolved to one
real-world record by design, not by omission. This is a modeling question, not a display gap, and
is called out separately in §6 as requiring a decision before any context model is built for this
rule.

### 4.8 — Rules with unverified evidence shape (rows 25–26, 28–32, 35)

`TRANSACTION_RATE_OUTLIERS`, `SITE_MATERIAL_ANOMALIES`, and the five `TICKET_*`/`IDENTITY_DUPLICATE_TICKET`
rules were confirmed to exist and to call `structuredRowEvidenceInput` with dynamic `fieldName`
values, but their exact field sets were not individually traced field-by-field in this pass (time
boxed against the Phase A scope). Flagged for a short follow-up read before Phase 3 resolver work
begins on these specific rules — do not assume they match the richer neighbors in the same file
without checking.

**Impact ranking:** §4.1 (no problem text, 45/51 rules) > §4.2 (raw Source Trace, 51/51) > §4.4
(document identity, 51/51) > §4.3 (unassembled cards, ~30/51) > §4.5 (raw field labels, ~30/51) >
§4.6 (buried sheet/row identity, ~13/51) > §4.7 (grain inconsistency, 1/51 but structurally
important) > §4.8 (unverified, ~7/51).

---

## 5. Recommended information hierarchy

```
Real-world subject identity
  ↓
Actual extracted business values
  ↓
Plain-language problem
  ↓
Expected versus actual conflict
  ↓
Source and document evidence
  ↓
Technical details
```

This validates for Pattern A and Pattern B (invoice-line, transaction, ticket, invoice-header
rules — the majority) directly, and maps onto the existing section order with two changes:
promote a new "subject identity" line above the current Issue Overview chips, and demote
`formatSubject`/`rule_id` out of Source Trace into Technical Details.

**Exceptions:**

- **Pattern C rollups** (`PROJECT_EXPOSURE_*`, `SOURCES_NO_*`) have no single "real-world subject"
  — the subject *is* the project or the document-category gap. For these, "subject identity"
  degrades gracefully to `Project {name}` or `Category: {document_type}`, which still fits the
  hierarchy without a special case.
- **Group-grain findings** (`TRANSACTION_GROUP_EXISTS_FOR_INVOICE_LINE`, and the disputed
  `TRANSACTION_MISSING_INVOICE_LINK` group variant, §4.7) have a *set* of subjects, not one. The
  hierarchy still holds if "subject identity" is rendered as a short list (`{n} transactions`,
  expandable) rather than forced into a single line — but this is a real design decision, not a
  mechanical fit, and is called out as needing product sign-off in §6.
- **Contract/source-readiness rules** (`SOURCES_NO_*`, `FINANCIAL_RATE_BASED_*`) have a document
  or document-category as the subject rather than a row. The hierarchy holds with "subject
  identity" = document name or category label.

No rule pattern requires abandoning the hierarchy; two patterns require the "subject identity" slot
to render a set or a category rather than a single record.

---

## 6. Phased implementation plan

### Phase 1+2 — Combined display assembly (merged post-review; zero backend, applies to all 51 rules)

**Decision (post-review):** ship as one bounded Codex task rather than two. Both are display-only,
zero-query changes over data already in scope, and there is little value in shipping an assembled
block that still reads `Document aa3b36ac` — the two changes complete the same reviewer-facing
outcome together.

**Affects:** `components/validator/ValidatorEvidenceDrawer.tsx`,
`components/evidence/evidenceInspectorModel.ts`, `components/projects/ValidatorTab.tsx` (prop
threading only).

- Add a field-label humanizer (`invoice_number` → `Invoice number`, de-underscore + capitalize
  fallback for unmapped keys) applied in `evidenceInspectorModel.ts:221` and
  `StructuredEvidenceCard`.
- Move `formatSubject`, `rule_id`, `check_key`, evidence `record_id` values into a collapsed
  Technical Details section (relocate, never delete — matches predecessor audit Phase 1).
- **Assemble Pattern-A evidence into one subject-identity block per business record**, grouped by
  **`evidence_type + source_document_id + record_id`**, not `evidence_type` alone — see §4.3
  correction. Never combine fields belonging to different records. When `record_id` is absent, fall
  back to `evidence_type + source_document_id + field_name` and preserve separate cards when
  identity is ambiguous.
- **Render a deliberately curated subject-identity summary first**, above Problem — not gated on
  `findingSemantics.ts` authoring, and **not a re-render of the full assembled Structured Data
  block**. This is a correction from an earlier draft of this plan, which risked being implemented
  as "move Structured Data up" — that is not the requirement. The summary is a short, fixed-priority
  field list (see field-priority spec below); the fuller assembled block from requirement 2 stays in
  its existing lower position with its complete field set and provenance. Order becomes: subject
  identity summary → Problem (existing `findingProblem()`/authored text, whichever is available) →
  Conflict → Source Trace → Document/Contract Evidence (full assembled blocks) → Technical Details.
  This keeps every finding understandable even for the 45 rules still using fallback problem text
  (§4.1) — the subject identity carries primary comprehension, not the problem sentence.

  **Field-priority spec for the summary (distinct from the full block):**

  | Primary group's `evidence_type` | Summary fields, in order |
  |---|---|
  | `invoice_line` | subject label `Invoice {invoice_number}` (fallback: humanized subject-type label, never a fabricated number) → `{description}` → `Quantity: {quantity} {unit}` → `Unit price: {unit_price}` → `Line total: {line_total}` → `Rate code: {rate_code}` |
  | `rate_schedule` / `contract` | subject label `{governing document name}` (Phase 2 resolves this) or `Contract rate {rate_code}` → `{item description}` → `Rate: {rate_amount}/{unit}` → `Category: {canonical_category}` |
  | `transaction_row` / `mobile_ticket` / `load_ticket` | subject label `Transaction {transaction_number}` or `Ticket {ticket_id}` → `Material: {material}` → `Quantity: {quantity} {unit}` → `Disposal site: {disposal_site}` (only if the rule concerns disposal) |
  | `project` / `contract` (aggregate/Pattern-C subject types) | **skip evidence-group assembly entirely** — build the summary directly from `finding.subject_id`/project or document name → `finding.expected` → `finding.actual` → `finding.variance` (formatted with `variance_unit` when present). There is no "record" to group for a rollup finding. |

  **Choosing the primary group:** match the finding's `subject_type` to the evidence-group
  `evidence_type` it corresponds to (`invoice_line`→`invoice_line`, `invoice_rate_group`→the
  `invoice_line` group within it, `transaction_row`/`transaction_group`→`transaction_row`,
  `mobile_ticket`/`load_ticket`→the matching type). If multiple groups share that type, pick the one
  with the most populated priority fields, not simply the first one encountered.

  **Honest degradation (the Pattern-B case):** when the primary group's priority fields are mostly
  or entirely empty — e.g. `FINANCIAL_RATE_CODE_MISSING` before the Phase 3 resolver ships, where
  the only `invoice_line` evidence entry carries `field_value: null` — render the humanized
  subject-type label (e.g. "Invoice line") as a neutral header, **do not fabricate** an invoice
  number, description, or any other value, and render each missing priority field as
  `Not captured during extraction`. If a `rate_schedule` group with real values exists on the same
  finding, it belongs in the existing Conflict/Structured Data sections as today — it is the matched
  governing rate, not the invoice line's own identity, and must not be substituted into the
  invoice-line summary as if it were the line's own data.
- Thread the `documents` collection (already fetched by `useProjectWorkspaceData`, already a prop on
  `ValidatorTab`) one level deeper into `ValidatorEvidenceDrawer`. Replace
  `` `Document ${id.slice(0,8)}` `` with a real filename lookup; fall back to
  `Unnamed document ({id8})` when no match exists. No new query — pure prop threading.

**Non-goals:** no persistence changes, no resolver work (Pattern B stays exactly as unusable as
before — that's Phase 3), no authoring of the 45 missing `problem`/`impact` entries (that's the
separate content-authoring track below, not this Codex task).
**Performance:** none — same data, same props, render-only.
**Provenance:** every relocated value must remain reachable in Technical Details; test for this
explicitly.
**Regression risk:** `tests/e2e/golden-overview.smoke.spec.ts:100` asserts the raw string
`FINANCIAL_RATE_CODE_MISSING` is visible — update deliberately per predecessor audit §A.9, do not
delete the assertion. Also grep `tests/` for any `Document ${` / `.slice(0, 8)` assertions before
merging.
**Acceptance:** no finding type renders a raw `fact:…`, `validator_finding:…`, bare UUID, or
truncated document ID outside Technical Details; Pattern-A findings show one assembled
business-record block per distinct `record_id`, never a blended multi-record block; real filenames
render wherever a document is referenced; Golden finding count/severity/status distribution
unchanged (compare against the live snapshot in §1 without triggering revalidation).
**Golden gate:** display parity only — CYD 74,617 / Extended Cost $815,559.35 untouched, since
nothing here reads or writes canonical facts.
**Backward compatibility:** all existing persisted findings/evidence render under the new grouping
logic without schema change — `evidence_type`, `source_document_id`, and `record_id` already exist
on every row.

### Phase 3 — Targeted resolvers (rule-family specific, independently shippable per family)

**3a. Invoice-line resolver** (Pattern B rules only — rows 1–2): single `document_extractions` read
by `source_document_id`, per predecessor audit §A.6/Phase 3. Pattern-A invoice-line rules do **not**
need this — their data is already in evidence (§4.0).

**3b. Transaction/ticket resolver** (rows 20–32, 35): single `transaction_data_rows` read by
`row_id`/`transaction_number`, never the full table. For group-grain findings, resolve the list of
member row IDs (bounded, e.g. first 20 with a count).

**Non-goals:** no join into the findings-list payload (constraint honored); no resolution of
historical findings whose subject ID predates the current key scheme without a fallback path.
**Performance:** one indexed row read per selected finding; verify against Phase C targets in
`PRODUCT_ALIGNMENT.md` (<500ms selection).
**Provenance:** resolver failure must render `Not captured during extraction`, never throw and
never fall back to guessing by position.
**Regression risk:** medium — first resolver work touching a live query path since the predecessor
audit's Phase 1–2 were display-only. Requires its own unit tests per resolver.
**Acceptance:** selected-finding detail populates for 3a/3b rule families without a full-dataset
load; `transaction_data_rows` full-table reads do not appear in query logs for single-finding
selection.
**Golden gate:** confirm resolver output against Williamson's known finding set without triggering
a revalidation run.
**Compatibility:** old findings whose `subject_id` doesn't resolve (e.g. `invoice_line:unknown`,
predecessor audit §A.6 caveat) render the explicit fallback, not a crash.

### Phase 4 — Additive persistence (Pattern B only, and §4.6's buried sheet/row identity)

- Extend Pattern-B evidence (financialIntegrity.ts) per predecessor audit Phase 4 — persist match
  basis and rationale currently computed and discarded (§A.3 Cause 2 in predecessor doc).
- Add explicit `source_sheet_name`/`source_row_number` evidence fields at
  `invoiceTransactionReconciliation.ts:677` instead of embedding them only in note prose (§4.6).

**Non-goals:** no migration in this audit turn — this phase *requires* one, scoped per audit §1.4
discipline (additive only), and requires schema-parity CI to exist first per `PRODUCT_ALIGNMENT.md`
Phase A.
**Provenance/Golden gate:** identical constraints to predecessor audit Phase 4 — old findings must
degrade gracefully, Golden totals unchanged.

### Phase 5 — Rule-authoring pass on `findingSemantics.ts` (content only, no schema)

Author `problem`/`impact` text for the 45 rules currently missing it (§4.1). This can run in
parallel with any other phase — it's a content change to one file, reviewed for accuracy against
what each rule actually checks, not a code architecture change. Recommend doing this **early**,
possibly before Phase 3, since it is pure authoring effort with no engineering risk and fixes the
highest-ranked gap in §4.

### Phase 6 — Subject-grain decision for group findings (owner decision required, no implementation)

Before building a context model for `TRANSACTION_MISSING_INVOICE_LINK` or any other group-grain
rule, decide: does the Validator show one finding per orphan transaction row (matching the
`invoice_rate_group` convention used elsewhere), or does it keep the project-wide aggregate and
render a list inside it? This determines whether `TransactionRowFindingContext` needs a
one-to-many variant. Not resolvable by inspection — it's a product call, flagged per the task's
instruction not to generate implementation prompts for decisions still pending.

---

## 7. Codex work package — Phase 1+2 combined (approved for immediate implementation)

Phases 3–6 require either a resolver design decision already scoped in §6/§3 or an owner decision
(§6 Phase 6) and are intentionally not turned into prompts here. Phase 5 (content authoring for the
45 missing `problem`/`impact` entries) is a separate, parallel, non-code track — see
`docs/audits/validator-finding-semantics-problem-impact-matrix-2026-07-19.md` — and is explicitly
**not** part of this Codex task.

> **Task: Validator Evidence & Truth panel — assemble structured evidence into subject-identity
> blocks, humanize field labels, resolve real document filenames, relocate raw identifiers
> (combined Phase 1+2, display-only + prop-threading, no new queries, no persistence changes, all
> finding types)**
>
> Read `PRODUCT_ALIGNMENT.md`, `CLAUDE.md`, `AGENTS.md`, and both
> `docs/audits/validator-rate-code-missing-panel-audit-2026-07-19.md` and
> `docs/audits/validator-all-findings-reviewer-context-audit-2026-07-19.md` before starting.
> Reviewer: `eightforge-ux-reviewer` + `eightforge-truth-engine-reviewer`.
>
> **Scope — modify only:**
> `components/validator/ValidatorEvidenceDrawer.tsx`,
> `components/evidence/evidenceInspectorModel.ts`,
> `components/projects/ValidatorTab.tsx` (prop threading only — one new prop passed at one call
> site).
>
> Do not modify any rule pack, persistence path, API route, migration, `findingSemantics.ts`, or the
> findings list. Add zero new network calls or queries — every value used here is already loaded.
>
> **Verified findings you may rely on:**
> - Every rule pack calls the shared `structuredRowEvidenceInput` (`lib/validator/shared.ts:668–686`),
>   which persists `evidence_type`, `source_document_id`, `record_id`, `field_name`, `field_value`,
>   `note`. For ~30 of 51 rules (`crossDocumentRateVerification.ts`, `contractInvoiceReconciliation.ts`,
>   `invoiceTransactionReconciliation.ts`), `field_value` is a real scalar per call — the data is not
>   missing, only unassembled.
> - `supportEvidence()` (`crossDocumentRateVerification.ts:670–685`) can attach up to 8 evidence rows
>   sharing the same `evidence_type` but **distinct `record_id` values** — one per supporting
>   transaction. Grouping by `evidence_type` alone would incorrectly blend up to 8 different
>   transaction records into one block.
> - `evidenceInspectorModel.ts:221` renders `evidence.field_name` raw as `canonicalField`.
> - `ValidatorEvidenceDrawer.tsx:305–321` (`StructuredEvidenceCard`) renders one card per evidence
>   entry with no cross-entry grouping.
> - `ValidatorEvidenceDrawer.tsx:485–489` renders `formatSubject` (:75–77) and raw `rule_id` as
>   primary Source Trace content.
> - `ValidatorEvidenceDrawer.tsx:569–571` renders `` `Document ${id.slice(0,8)}` `` because the
>   component has no access to document names. `ValidatorTab.tsx` already receives a `documents`
>   prop (from `useProjectWorkspaceData` via `app/platform/projects/[id]/page.tsx`) but does not pass
>   it to `ValidatorEvidenceDrawer` at the call site (~`ValidatorTab.tsx:1069–1075`). This is prop
>   threading, not a new data source.
> - `findingSemantics.ts` supplies `problem`/`impact` for only 6 of 51 rule IDs; the rest fall
>   through to `findingProblem()` (`lib/truthToAction.ts:104–108`), which humanizes the raw rule key.
>   This task does not fix that — it makes the panel understandable without it (see requirement 4).
>
> **Required changes:**
> 1. Add a field-label map for known canonical field names (`invoice_number` → "Invoice number",
>    `rate_code` → "Rate code", `unit_price` → "Unit price", `line_total` → "Line total",
>    `canonical_category` → "Category", `contractor_name` → "Contractor", `client_name` → "Client",
>    `service_period` → "Service period", `description` → "Description", `quantity` → "Quantity").
>    Unmapped keys fall back to a de-underscored, capitalized label — never render raw
>    `snake_case`.
> 2. In `ValidatorEvidenceDrawer`, before rendering `structuredEvidence` as individual cards, group
>    entries by the composite key **`evidence_type + source_document_id + record_id`** — not
>    `evidence_type` alone. When two or more entries share the full composite key and have distinct,
>    non-null `field_name`/`field_value` pairs, render **one assembled business-record block** per
>    group using the label map (e.g. one `invoice_line` block showing Invoice number / Description /
>    Quantity / Unit price / Line total / Rate code together). **Never combine fields belonging to
>    different records** — verify this explicitly against a fixture modeled on `supportEvidence()`
>    with multiple `record_id`s under one `evidence_type`. When `record_id` is null on an entry, fall
>    back to grouping by `evidence_type + source_document_id + field_name` and keep ambiguous entries
>    as separate cards rather than merging them speculatively.
> 3. **Render the assembled subject-identity block as the first content section of the panel**,
>    above Problem — using only real extracted values from the block built in requirement 2 (e.g.
>    `Invoice 2026-003` / `Management Reduction Preparation Management Segregating Material at DMS`
>    / `Quantity: 70,496 CY` / `Rate code: 2A`). This section must render correctly regardless of
>    whether `findingSemantics.ts` has authored `problem`/`impact` text for the active rule — it does
>    not depend on or wait for that content. Existing Problem/Conflict/Source Trace sections keep
>    their current logic and move below this new section.
> 4. Move `formatSubject` output, `rule_id`, `check_key`, and evidence `record_id` values into a new
>    collapsed `<details>` "Technical Details" section as the final section of the panel. Relocate,
>    do not delete.
> 5. Thread document filenames: add a `documents` prop to `ValidatorEvidenceDrawerProps` (reuse the
>    existing project document type already used in `ValidatorTab.tsx` — do not define a new shape),
>    pass it at the existing call site, and replace `` `Document ${id.slice(0,8)}` `` with a lookup
>    by `source_document_id`. When no match exists, render `Unnamed document ({id8})` — never a bare
>    truncated UUID standing alone as if it were a name.
> 6. Where a value is unavailable, render the literal string `Not captured during extraction`. Do
>    not substitute generated prose or invented values.
>
> **Constraints:** no hardcoded Williamson County IDs, document names, invoice numbers, or rate
> codes. Preserve `isDocumentEvidence`, `classifyDocumentEvidence`, `buildEvidenceTarget`, and all
> existing evidence links/`EvidenceInspector` usage unchanged. Preserve the read-only posture of
> this panel and the three-panel layout. No `findingSemantics.ts` edits.
>
> **Tests:** add/extend `components/validator/ValidatorEvidenceDrawer.test.tsx` with fixtures for
> (a) a Pattern-A finding with 6 field-labeled evidence entries sharing one `record_id` — assert the
> curated summary shows exactly the priority-field subset in order, and separately assert the full
> assembled block (all 6 fields) still renders in its existing lower position; (b) a finding with 8
> support-evidence entries sharing `evidence_type` but 8 distinct `record_id`s — assert 8 separate
> blocks, not one blended block; (c) a Pattern-B finding with a single null-value entry — assert the
> summary renders the neutral humanized label plus `Not captured during extraction` per priority
> field, with no fabricated invoice number or description, and assert a co-present `rate_schedule`
> group is not substituted into the invoice-line summary; (d) a finding with an entry lacking
> `field_name` and `record_id` — assert graceful fallback, no throw, no incorrect merge; (e)
> Technical Details contains `subject_id`/`rule_id`/`record_id` after relocation; (f) an unmapped
> field name renders a humanized fallback label, not raw snake_case; (g) a matching document present
> — assert real filename rendered; (h) no matching document — assert the `Unnamed document (id8)`
> fallback; (i) `documents` prop omitted/empty — assert no throw, same fallback; (j) a Pattern-C
> aggregate finding (`subject_type: 'project'` or `'contract'`) — assert the summary skips
> evidence-group assembly and renders subject label + expected/actual/variance directly, per the
> field-priority spec's aggregate branch. Build fixtures inline; do not import live project data.
>
> **Verification gates, in order:**
> ```bash
> npx tsc --noEmit
> npx vitest run components/validator components/evidence components/projects --reporter verbose
> npm run build
> ```
>
> **Known break — fix deliberately:** `tests/e2e/golden-overview.smoke.spec.ts:100` asserts the raw
> string `FINANCIAL_RATE_CODE_MISSING` is visible on screen. Update it to assert against the
> Technical Details region specifically, per predecessor audit §A.9. Do not delete the assertion.
> Also `grep -rn "Document \$\{" tests/` before merging and flag anything found.
>
> **Required before/after report — four named cases, not optional.** Before/after renderings (text
> dump of rendered output is sufficient if screenshots aren't practical in the execution
> environment; screenshots preferred if available) for exactly these four findings, chosen because
> together they exercise all three evidence patterns and the multi-record grouping edge case:
>
> 1. **One Pattern-A invoice-line finding** — use a `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` or
>    `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` fixture. Confirm the curated summary shows the
>    priority subset (not the full field list) and the full assembled block still appears lower with
>    every field.
> 2. **One finding with several support records sharing the same `evidence_type`** — use a
>    `CROSS_DOCUMENT_INVOICE_WORK_SUPPORTED` or `CROSS_DOCUMENT_TICKET_SUPPORT_EXISTS` fixture built
>    from `supportEvidence()`'s shape (multiple `transaction_row` entries, distinct `record_id`s).
>    Confirm this renders as multiple distinct blocks, never one blended block — this is the case
>    that would fail silently under the old `evidence_type`-only grouping.
> 3. **One aggregate Pattern-C finding** — use `PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO` or
>    `SOURCES_NO_CONTRACT`. Confirm the summary correctly skips evidence-group assembly and renders
>    from `finding.subject_id`/`expected`/`actual`/`variance` directly, with no attempt to force a
>    record-style block onto a rollup subject.
> 4. **One Pattern-B finding where detailed invoice-line data is still unavailable** — use
>    `FINANCIAL_RATE_CODE_MISSING` with no resolver yet (Phase 3 not shipped). Confirm the summary
>    shows the honest-degradation state from the field-priority spec: neutral label, explicit
>    `Not captured during extraction` per field, no invented invoice number/description, and no
>    silent reuse of the matched `rate_schedule` evidence as if it were the line's own identity.
>
> This set is chosen specifically to reveal whether the grouping/summary logic generalizes across
> all three patterns rather than only working for the example finding used during development.
>
> **Report back:** files changed; the four before/after renderings above; confirmation no raw
> identifier was deleted rather than relocated; confirmation no new query was added; confirmation
> the subject-identity summary renders independent of `findingSemantics.ts` content; confirmation
> the summary and the full assembled block are visibly different in content (summary is a subset, not
> a duplicate render); test and build results; the e2e assertion change; whether this is safe to
> commit.

---

## 8. Answers to the stated success criteria

1. **Shared reviewer-context patterns:** four, after collapsing Transaction/Ticket —
   `InvoiceLineFindingContext`, `ContractRateFindingContext`, `TransactionRowFindingContext`,
   `ProjectRollupFindingContext` (§3).
2. **Business data already available per pattern:** full field sets for Pattern A (~30 rules, §4.0);
   partial for Pattern C rollups (already computed, just needs surfacing, §2); minimal for Pattern B
   (5 rules, real gap, §A.3 of predecessor audit).
3. **Data currently lost or ignored:** ranked in §4 — authored problem text (45/51 rules, highest
   impact), raw Source Trace (51/51), document identity (51/51), unassembled Pattern-A cards
   (~30/51), buried sheet/row identity in note prose (~13/51).
4. **Surfaceable without backend changes:** essentially all of Phase 1 + Phase 2 — roughly 40 of 51
   rules improve materially with zero new queries.
5. **Requires a targeted resolver:** Pattern B (rows 1–2) and the transaction/ticket family (rows
   20–32, 35) — §6 Phase 3.
6. **Truly requires additive persistence:** Pattern B match-rationale (predecessor audit Phase 4)
   and the buried sheet/row fields (§4.6) — nothing else in this inventory needs a new column.
7. **Reusable architecture preventing one-at-a-time fixes:** the four context models in §3, plus the
   single field-label map and evidence-grouping-by-type logic in Work Package 1 — one component
   change fixes ~30 rules simultaneously.
8. **Smallest first implementation:** Work Package 1 (§7) — pure display assembly, zero backend,
   fixes the two highest-ranked gaps (§4.1 partially via existing semantics, §4.2, §4.3, §4.5) across
   the majority of finding types in one PR.
