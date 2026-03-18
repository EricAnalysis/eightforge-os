# EightForge Document Intelligence Output Model
## EMERG03 / FEMA Debris Operations — Design Spec

**Version:** 1.0
**Date:** 2026-03-17
**Scope:** Document detail page — what EightForge extracts, decides, and surfaces for each document type in the FEMA debris operations domain.

---

## 1. Output Model by Document Type

### 1A. Project Contract

**Reference document:** `EMERG03_FE.pdf`
Contract No. EMERG03, NMDOT ↔ Stampede Ventures Inc, executed 8/12/2024

---

**Summary sentence (above the fold):**
> Contract EMERG03 between NMDOT and Stampede Ventures Inc. was executed on 8/12/2024 with a $30,000,000 NTE. Term expires approximately 2/12/2025. Thompson Consulting Services is the designated payment monitor. FEMA DR-4652-NM (Mora + San Miguel Counties, NM).

---

**Extracted fields schema (always visible):**

| Field | Value | Source |
|---|---|---|
| Contract Number | EMERG03 | Header / title |
| Vendor ID | 0000168801 | Cover page |
| Owner | New Mexico DOT (NMDOT) | Parties section |
| Contractor | Stampede Ventures Inc. | Parties section |
| Contractor State | Alaska | Vendor registration |
| Executed Date | 2024-08-12 | Signature block |
| Authorized Signer (Owner) | Ricky Serna, Cabinet Secretary | Signature block |
| Authorized Signer (Contractor) | Jacob Gum, VP | Signature block |
| Contract NTE | $30,000,000.00 | Financial terms |
| Contract Term | 6 months | Term section |
| Computed Expiration | ~2025-02-12 | Derived: executed + 6 mo. |
| FEMA Disaster | DR-4652-NM | Header |
| Work Locations | Mora County, San Miguel County, NM | Scope of work |
| Payment Monitor | Thompson Consulting Services (TCS) | Payment section |
| Payment Cycle | Monthly | Payment section |
| Payment Window | 30 days after TCS certification | Payment section |
| Analysis Mode | AI-enriched | Pipeline metadata |

---

**Detected entity chips:**

- `EMERG03` — contract identifier
- `DR-4652-NM` — FEMA disaster number
- `Stampede Ventures Inc.` — contractor
- `NMDOT` — owner / applicant
- `Thompson Consulting Services` — payment monitor
- `$30,000,000` — NTE
- `Mora County` — work location
- `San Miguel County` — work location
- `2025-02-12` — computed contract expiration

---

**Decisions generated:**

- **MONITOR: Contract expiration approaching** — Computed expiration 2025-02-12 is within 30 days of invoice period start (2025-02-01). Flag for contract extension or closeout review.
- **ALERT: NTE discrepancy detected** — Contract NTE of $30M conflicts with $80M contract sum shown on linked Invoice SOV_05. Requires manual reconciliation before further payments.
- **INFO: Payment monitor certification required** — Thompson Consulting Services must certify each invoice before NMDOT initiates payment per contract terms.

---

**Workflow tasks triggered:**

- Verify contract extension status for EMERG03 (assigned: project manager)
- Reconcile NTE vs G702 contract sum discrepancy ($30M vs $80M) (assigned: finance reviewer)
- Confirm TCS is active and certified for current billing period

---

**Above the fold vs expandable:**

Above the fold: summary sentence, entity chips, contract number / NTE / expiration / FEMA disaster / monitor

Expandable sections:
- Full extracted fields table
- Parties detail (signer names, vendor ID, state)
- Payment terms (cycle, window, TCS requirement)
- Raw extraction preview

---

---

### 1B. Invoice (AIA G702 / G703)

**Reference document:** `EMERG03 SOV_05-revised.pdf`
Invoice EMERG03 SOV_05, Application #05, Period 02/01/2025–02/28/2025

---

**Summary sentence (above the fold):**
> Invoice EMERG03 SOV_05 (Application #05) for $76,359.62 was matched to the payment recommendation with no variance detected. Contractor, project, and billing period identified successfully. One discrepancy flagged: G702 shows $80,000,000 original contract sum vs. $30,000,000 NTE in contract. Ready for approval review.

---

**Extracted fields schema (always visible):**

| Field | Value | Source |
|---|---|---|
| Invoice Number | EMERG03 SOV_05 | G702 header |
| Application Number | 05 | G702 header |
| Invoice Date | 2025-03-22 | G702 date field |
| Billing Period Start | 2025-02-01 | G702 period |
| Billing Period End | 2025-02-28 | G702 period |
| Comments / Tag | ROW | G702 comments |
| Contract Sum (G702) | $80,000,000.00 | G702 line 1 |
| Total Earned to Date | $3,443,430.25 | G702 line 6 |
| Previous Certificates | $3,367,070.63 | G702 line 7 |
| Retainage | $0.00 | G702 line 5 |
| Current Amount Due | $76,359.62 | G702 line 13 |
| Current Work (ex-GRT) | $71,679.72 | G702 / G703 subtotal |
| Mora GRT | $4,679.90 | G702 tax line |
| Balance to Finish | $76,556,569.75 | G702 line 14 |
| Contractor | Stampede Ventures Inc. | G702 parties |
| Owner | NMDOT | G702 parties |
| Architect / Monitor | Thompson Consulting Services | G702 parties |

---

**Detected entity chips:**

- `EMERG03 SOV_05` — invoice identifier
- `Application #05` — billing cycle
- `$76,359.62` — current amount due
- `Stampede Ventures Inc.` — contractor
- `NMDOT` — owner
- `Thompson Consulting Services` — certifier
- `2025-02-01 – 2025-02-28` — billing period
- `ROW` — work tag / classification

---

**Detected CLIN line items (G703 continuation sheet):**

| CLIN | Description | Scheduled Value | Work This Period | % Complete |
|---|---|---|---|---|
| 9A | Traffic Control | — | present | — |
| 16B | Skid Steer | — | present | — |
| 16C | Wheel Loader | — | present | — |
| 38A | Community Dust Control | — | present | — |
| 33A | Acequias Cleanup (base) | — | present | — |
| 33B | Acequias Cleanup (GRT) | — | present | — |
| 37A | Fire Debris Removal | — | present | — |
| 37B | Fire Debris GRT | — | present | — |
| Metals | Metals Removal | — | present | — |
| Contaminated Soil | Contaminated Soil | — | present | — |

*Note: G703 scheduled values require structured table extraction; currently captured in text_preview. Exact per-CLIN dollar amounts available after full table parser is implemented.*

---

**Decisions generated:**

- **ALERT: Contract sum mismatch** — G702 line 1 shows $80,000,000 original contract sum. Contract document shows $30,000,000 NTE. Difference: $50,000,000. Do not approve until reconciled.
- **INFO: Billing period extends to contract expiration** — Period 02/01–02/28/2025 falls at or past the computed contract term expiration (~02/12/2025). Verify contract was extended.
- **MATCH: Amount matches payment recommendation** — Current due $76,359.62 matches Payment Rec EMERG03_05 recommended amount exactly ($0.00 variance).
- **INFO: GRT component present** — $4,679.90 Mora County GRT included in current due. Verify applicable GRT rate and county.

---

**Workflow tasks triggered:**

- Reconcile G702 contract sum ($80M) vs contract NTE ($30M) — block payment pending resolution
- Verify contract term was extended to cover February 2025 billing period
- Confirm Mora County GRT rate applied is correct for current period
- Route to TCS for certification signature (if not already certified)

---

**Above the fold vs expandable:**

Above the fold: summary sentence, entity chips, current amount due, billing period, match status badge (MATCHED / DISCREPANCY), top decisions

Expandable sections:
- Full G702 field breakdown
- G703 CLIN line items table
- GRT detail
- Raw extraction preview

---

---

### 1C. Payment Recommendation Report

**Reference document:** `Payment Rec EMERG03_05.pdf`
TCS report authorizing $76,359.62 for Emerg03_5, signed 4/7/2025

---

**Summary sentence (above the fold):**
> Payment Recommendation for Emerg03_5 recommends $76,359.62 with no adjustments. Authorized by Eric D. Martin (Thompson Consulting Services) on 4/7/2025. All 12 CLIN lines verified for Mora County. Amount matches invoice exactly.

---

**Extracted fields schema (always visible):**

| Field | Value | Source |
|---|---|---|
| Report Reference | Emerg03_5 | Report header |
| Date of Invoice (on rec) | 2025-03-17 | Report field |
| Report Date / Auth Date | 2025-04-07 | Signature block |
| Applicant | NMDOT | Report field |
| Contractor | Stampede Ventures Inc. | Report field |
| Disaster | DR-4652-NM | Report field |
| Billing Period | 2025-02-01 – 2025-02-28 | Report field |
| Gross Amount | $76,359.62 | Financial summary |
| Adjustment Amount | $0.00 | Financial summary |
| Net Recommended Amount | $76,359.62 | Financial summary |
| CLIN Lines Reviewed | 12 | CLIN table |
| County Covered | Mora County | Scope |
| Authorized By | Eric D. Martin | Signature block |
| Authorizing Organization | Thompson Consulting Services | Signature block |
| Authorization Date | 2025-04-07 | Signature block |

---

**Detected entity chips:**

- `Emerg03_5` — report / invoice ref (normalized form)
- `DR-4652-NM` — FEMA disaster
- `$76,359.62` — recommended amount
- `Eric D. Martin` — TCS authorizer
- `Thompson Consulting Services` — payment monitor
- `NMDOT` — applicant
- `Stampede Ventures Inc.` — contractor
- `Mora County` — coverage scope
- `2025-04-07` — authorization date

---

**Detected CLIN lines (12 lines, Mora County):**

16B (base + GRT), 16C (base + GRT), 9A (base + GRT), 38A (base + GRT), 3A (base + GRT), 7A (base + GRT)

*Note: Payment rec covers Mora County only. No San Miguel County lines present in this report.*

---

**Decisions generated:**

- **MATCH: Amount matches linked invoice** — Recommended $76,359.62 = Invoice SOV_05 current due $76,359.62. Zero variance. Amounts are consistent.
- **ALERT: Invoice date discrepancy** — Payment rec shows "Date of Invoice: 3/17/2025." G702 invoice is dated 3/22/2025. These are the same invoice (Emerg03_5 = EMERG03 SOV_05) but dates differ by 5 days. Verify which date is authoritative.
- **INFO: CLIN coverage is Mora County only** — 12 CLIN lines cover Mora County. G703 includes work in additional areas. Verify San Miguel County items have separate payment rec or are excluded from this draw.
- **INFO: No adjustments applied** — Gross = Net. No deductions, retainage withholding, or corrections recorded.

---

**Workflow tasks triggered:**

- Resolve invoice date discrepancy: G702 shows 3/22/2025, payment rec shows 3/17/2025
- Confirm San Miguel County CLIN items have separate payment recommendation or are deferred
- File payment rec as supporting documentation for invoice EMERG03 SOV_05
- Update invoice status to "TCS certified — ready for payment"

---

**Above the fold vs expandable:**

Above the fold: summary sentence, entity chips, recommended amount, authorization info, match status badge, date discrepancy alert (if present)

Expandable sections:
- Full extracted field table
- CLIN breakdown by county
- Adjustment detail (even if zero)
- Raw extraction preview

---

---

### 1D. Excel Project Data (ROW Ticket Export)

**Reference document:** `Emerg03 SOV 5 - FEB 25 - ROW ticket export.xlsx`
Right-of-way ticket data backing the February 2025 invoice

---

**Summary sentence (above the fold):**
> ROW ticket export for EMERG03 SOV 5 (February 2025) contains field-level backup data for invoice line items. Structured tabular parsing required to reconcile individual ticket amounts against G703 CLIN totals. Not yet processed.

*Note: Until the table parser produces structured output, this is the correct honest summary. Do not fabricate CLIN matches.*

---

**Extracted fields schema (target state once parsed):**

| Field | Source |
|---|---|
| Ticket Number | Column: Ticket # |
| Work Date | Column: Date |
| CLIN Code | Column: CLIN or Item Code |
| Equipment / Resource | Column: Description |
| Hours or Units | Column: Qty / Hours |
| Rate | Column: Rate |
| Ticket Amount | Column: Amount |
| Location / Road | Column: Location |
| County | Column: County |
| Crew / Subcontractor | Column: Crew |
| Supervisor Signature | Column: Signed By |

---

**Detected entity chips (target state):**

- Individual ticket IDs (e.g., `ROW-0241`, `ROW-0242`, ...)
- CLIN codes present in data
- Date range covered
- Total ticket count
- Computed subtotal

---

**Decisions generated (target state):**

- **MATCH / MISMATCH: Ticket total vs G703 CLIN amounts** — Compare sum of ticket amounts per CLIN against G703 scheduled/completed values.
- **FLAG: Tickets outside billing period** — Any ticket dated outside 02/01–02/28/2025 should be flagged.
- **FLAG: Tickets with missing signatures** — Required field for FEMA compliance.

---

**Workflow tasks triggered (target state):**

- Reconcile ROW ticket totals to G703 CLIN by CLIN
- Flag any unsigned or undated tickets for contractor correction
- Confirm all tickets fall within 02/01–02/28/2025 billing window

---

**Current state note for implementation:**
Excel parsing is not active in the current pipeline. The document will extract as text_preview only. Until `xlsxExtractor` or equivalent is wired in, surface the document as "Backup data — manual review required" with a task to reconcile manually. Do not generate CLIN match decisions from this document type until parsed totals are available.

---

---

## 2. Cross-Document Intelligence Model

The cross-document layer compares documents within the same project (same `organization_id` + matching `contract_number` or `project_id` tag) and surfaces conflicts, matches, and coverage gaps. This is the highest-value output EightForge produces.

---

### 2A. Amount Match Check

**Documents compared:** Invoice ↔ Payment Recommendation

**Logic:**
```
invoice.current_amount_due === payment_rec.net_recommended_amount
```

**EMERG03 SOV_05 result:** $76,359.62 = $76,359.62 → ✅ MATCHED ($0.00 variance)

**Output:** `InvoiceComparisonResult` with `amount_variance: 0`, `amount_match: true`

**Decision if mismatch:** `ALERT: Payment rec amount does not match invoice. Block payment pending reconciliation.`

---

### 2B. Billing Period Match

**Documents compared:** Invoice ↔ Payment Recommendation

**Logic:**
```
invoice.period_start === payment_rec.period_start
invoice.period_end === payment_rec.period_end
```

**EMERG03 SOV_05 result:** Both show 02/01/2025–02/28/2025 → ✅ MATCHED

**Decision if mismatch:** `ALERT: Billing period on payment rec does not match invoice period. Documents may reference different draws.`

---

### 2C. Invoice Date Discrepancy

**Documents compared:** Invoice G702 date ↔ Payment rec "Date of Invoice" field

**Logic:**
```
invoice.invoice_date !== payment_rec.date_of_invoice
```

**EMERG03 SOV_05 result:** G702 = 2025-03-22, Payment Rec field = 2025-03-17 → ⚠️ DISCREPANCY (5-day delta)

**Decision:** `ALERT: Invoice date on payment recommendation (3/17/2025) does not match G702 invoice date (3/22/2025). Determine which is authoritative for audit trail.`

---

### 2D. Contractor Name Normalization

**Documents compared:** Contract ↔ Invoice ↔ Payment Recommendation

**Raw values:**
- Contract: "Stampede Ventures Inc."
- G702: "Stampede Ventures Inc."
- Payment Rec: "Stampede Ventures Inc."

**Logic:** Fuzzy match + canonical form extraction. Store canonical name in `entities` table.

**EMERG03 SOV_05 result:** ✅ All three match canonical form — no normalization flag.

**Decision if mismatch:** `ALERT: Contractor name varies across documents. Verify all documents refer to the same entity before processing payment.`

---

### 2E. Contract NTE vs G702 Contract Sum Discrepancy

**Documents compared:** Contract ↔ Invoice G702

**Logic:**
```
Math.abs(contract.nte - invoice.g702_contract_sum) > THRESHOLD
```

**EMERG03 SOV_05 result:** Contract NTE = $30,000,000 vs G702 Line 1 = $80,000,000 → 🚨 CRITICAL DISCREPANCY ($50,000,000 delta)

**Decision:** `ALERT: G702 contract sum ($80,000,000) does not match contract NTE ($30,000,000). This is a $50M discrepancy. Do not approve invoice until reconciled. Possible causes: contract amendment not yet uploaded, incorrect G702, or data entry error.`

**Workflow task:** Escalate NTE vs G702 contract sum discrepancy to finance reviewer — block payment.

---

### 2F. Duplicate Invoice Detection

**Documents compared:** New invoice ↔ all existing invoices for same contract

**Logic:**
```
EXISTS invoice WHERE
  contract_number = new.contract_number
  AND application_number = new.application_number
  AND NOT id = new.id
```

**Decision if triggered:** `ALERT: Duplicate invoice detected. Application #05 for EMERG03 already exists in the system. Do not process until original is voided or this is confirmed as a resubmission.`

---

### 2G. Contract Term Check

**Documents compared:** Contract ↔ Invoice billing period

**Logic:**
```
invoice.period_end > contract.computed_expiration
```

**EMERG03 SOV_05 result:** Period end 02/28/2025 > computed expiration ~02/12/2025 → ⚠️ FLAG

**Decision:** `ALERT: Invoice billing period (02/01–02/28/2025) extends beyond computed contract expiration (~02/12/2025). Verify contract was extended or that this period is covered under a modification.`

---

### 2H. CLIN Coverage Check

**Documents compared:** Payment Recommendation CLIN list ↔ Invoice G703 CLIN list

**Logic:** Payment rec should cover all CLINs billed on G703, or explicitly exclude with explanation.

**EMERG03 SOV_05 result:** Payment rec covers 12 CLIN lines (Mora County only). G703 includes additional county/items → ⚠️ PARTIAL COVERAGE

**Decision:** `INFO: Payment recommendation covers Mora County CLINs only (12 lines). G703 includes additional items. Verify San Miguel County items have a separate payment rec or are deferred from this draw.`

---

### 2I. Backup Reconciliation (Excel ↔ Invoice)

**Documents compared:** ROW ticket export ↔ Invoice G703 CLIN amounts

**Status:** Pending Excel structured parsing. When available:

**Logic:**
```
FOR EACH clin IN invoice.g703_clin_lines:
  tickets_total = SUM(ticket.amount WHERE ticket.clin = clin.code)
  variance = ABS(clin.amount - tickets_total)
  IF variance > EPSILON → FLAG
```

**Decision if mismatch:** `ALERT: ROW ticket total for CLIN [X] ($Y) does not match G703 billed amount ($Z). Variance: $[delta]. Require revised backup or corrected invoice.`

---

---

## 3. Recommended UI Structure — Document Detail Page

The document detail page should be ordered so the most operationally urgent information is always visible without scrolling.

```
┌─────────────────────────────────────────────────────────────────┐
│  [Document title]  [Type chip]  [Domain chip]  [Status badge]   │
│  [Processing status / Reprocess button]                         │
└─────────────────────────────────────────────────────────────────┘

┌─── SUMMARY ─────────────────────────────────────────────────────┐
│  One-sentence plain-English summary of what this document is    │
│  and its key validated result.                                  │
└─────────────────────────────────────────────────────────────────┘

┌─── ENTITY CHIPS ────────────────────────────────────────────────┐
│  [Contract #]  [FEMA Disaster]  [Contractor]  [Amount]          │
│  [Billing Period]  [Monitor]  [County]  ...                     │
└─────────────────────────────────────────────────────────────────┘

┌─── DECISIONS  (always open) ────────────────────────────────────┐
│  🚨 ALERT: NTE vs G702 discrepancy ($50M delta)          [Open] │
│  ⚠️  ALERT: Invoice date discrepancy (3/17 vs 3/22)      [Open] │
│  ✅ MATCH: Amount matches payment rec ($0 variance)             │
│  ⚠️  INFO: Billing period past contract expiration              │
└─────────────────────────────────────────────────────────────────┘

┌─── WORKFLOW TASKS  (always open) ───────────────────────────────┐
│  □ Reconcile NTE vs G702 contract sum                           │
│  □ Resolve invoice date discrepancy                             │
│  □ Verify contract term extension                               │
│  □ Confirm San Miguel CLIN coverage                             │
└─────────────────────────────────────────────────────────────────┘

┌─── CROSS-DOCUMENT MATCHES  (expandable) ────────────────────────┐
│  Linked: Payment Rec EMERG03_05  →  ✅ Amount matched           │
│  Linked: Contract EMERG03        →  ⚠️  NTE discrepancy         │
│  Linked: ROW Ticket Export       →  ⏳ Pending reconciliation   │
└─────────────────────────────────────────────────────────────────┘

┌─── EXTRACTED FIELDS  (expandable) ──────────────────────────────┐
│  Full field-value table from extraction                         │
└─────────────────────────────────────────────────────────────────┘

┌─── CLIN DETAIL  (expandable, invoices/payment recs only) ───────┐
│  G703 line-by-line or CLIN summary from payment rec             │
└─────────────────────────────────────────────────────────────────┘

┌─── RAW EXTRACTION PREVIEW  (expandable, collapsed by default) ──┐
│  text_preview, extraction mode, job ID, timestamps              │
└─────────────────────────────────────────────────────────────────┘
```

**Design rules:**
- Summary and entity chips are ALWAYS visible — never behind a click.
- Decisions with severity ALERT or higher are expanded by default. INFO decisions start collapsed.
- Workflow tasks show count badge on the section header when collapsed.
- Cross-document matches section only renders if linked document IDs are present in `document_comparisons`.
- Raw extraction preview is collapsed by default; power users can open it for debugging.
- Empty sections are hidden entirely (don't show a "Workflow Tasks" section if there are zero tasks).

---

---

## 4. TypeScript Interfaces

```typescript
// ─── Core summary output ──────────────────────────────────────────────────────

export interface DocumentSummary {
  /** Human-readable one-sentence summary of this document's key result. */
  sentence: string;
  /** Top-level validation status for the document. */
  status: 'matched' | 'discrepancy_detected' | 'pending_review' | 'incomplete';
  /** Optional badge label shown next to status (e.g. "Amount Matched", "NTE Mismatch"). */
  badge?: string;
}

// ─── Detected entities ────────────────────────────────────────────────────────

export type EntityType =
  | 'contract_number'
  | 'invoice_number'
  | 'fema_disaster'
  | 'contractor'
  | 'owner'
  | 'payment_monitor'
  | 'amount'
  | 'billing_period'
  | 'county'
  | 'clin_code'
  | 'person_name'
  | 'date'
  | 'vendor_id'
  | 'application_number';

export interface DetectedEntity {
  type: EntityType;
  label: string;         // Display label, e.g. "Contract #"
  value: string;         // Normalized display value, e.g. "EMERG03"
  raw_value?: string;    // Original extracted string if normalization was applied
  confidence?: number;   // 0–1, optional
  source?: string;       // e.g. "G702 header", "signature block"
}

// ─── Decisions ────────────────────────────────────────────────────────────────

export type DecisionSeverity = 'alert' | 'warning' | 'info' | 'match';
export type DecisionCategory =
  | 'amount_match'
  | 'amount_mismatch'
  | 'date_discrepancy'
  | 'contractor_mismatch'
  | 'nte_discrepancy'
  | 'duplicate_invoice'
  | 'contract_term'
  | 'clin_coverage'
  | 'certification_required'
  | 'backup_reconciliation'
  | 'grt_verification';

export interface GeneratedDecision {
  id: string;
  document_id: string;
  organization_id: string;
  severity: DecisionSeverity;
  category: DecisionCategory;
  title: string;          // Short label, e.g. "NTE vs G702 Discrepancy"
  description: string;    // Full human-readable explanation
  /** If this is a cross-document decision, the ID of the compared document. */
  compared_document_id?: string;
  /** Computed values used to generate this decision. */
  evidence?: Record<string, unknown>;
  status: 'open' | 'resolved' | 'dismissed';
  created_at: string;
  resolved_at?: string | null;
  resolved_by?: string | null;
}

// ─── Workflow tasks ────────────────────────────────────────────────────────────

export interface TriggeredWorkflowTask {
  id: string;
  document_id: string;
  organization_id: string;
  decision_id?: string;    // The decision that triggered this task, if any
  title: string;
  description?: string;
  assigned_to?: string | null;
  due_date?: string | null;
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'critical' | 'high' | 'medium' | 'low';
  created_at: string;
  completed_at?: string | null;
}

// ─── Cross-document comparison ────────────────────────────────────────────────

export interface InvoiceComparisonResult {
  invoice_id: string;
  payment_rec_id: string;
  /** Amount on invoice current due line. */
  invoice_amount: number;
  /** Amount recommended on payment rec. */
  payment_rec_amount: number;
  /** Absolute dollar variance. */
  amount_variance: number;
  amount_match: boolean;
  /** Period on invoice. */
  invoice_period_start: string;
  invoice_period_end: string;
  /** Period on payment rec. */
  payment_rec_period_start: string;
  payment_rec_period_end: string;
  period_match: boolean;
  /** Invoice date on G702. */
  invoice_date_g702: string | null;
  /** "Date of Invoice" field on payment rec. */
  invoice_date_payment_rec: string | null;
  invoice_date_match: boolean;
  /** Contractor name as it appears on invoice. */
  contractor_name_invoice: string | null;
  /** Contractor name as it appears on payment rec. */
  contractor_name_payment_rec: string | null;
  contractor_name_match: boolean;
  /** Any CLIN codes billed on invoice but absent from payment rec. */
  uncovered_clins: string[];
  compared_at: string;
}

// ─── Document-type-specific extraction shapes ─────────────────────────────────

export interface ContractExtraction {
  contract_number: string | null;
  vendor_id: string | null;
  owner: string | null;
  contractor: string | null;
  contractor_state: string | null;
  executed_date: string | null;           // ISO date
  nte_amount: number | null;
  term_months: number | null;
  computed_expiration: string | null;     // ISO date, derived
  fema_disaster: string | null;
  work_locations: string[];
  payment_monitor: string | null;
  payment_cycle: string | null;           // e.g. "monthly"
  payment_window_days: number | null;
  authorized_signer_owner: string | null;
  authorized_signer_contractor: string | null;
}

export interface InvoiceExtraction {
  invoice_number: string | null;
  application_number: string | null;
  invoice_date: string | null;            // ISO date from G702
  period_start: string | null;
  period_end: string | null;
  comments_tag: string | null;            // e.g. "ROW"
  g702_contract_sum: number | null;       // Line 1 — may differ from NTE
  total_earned_to_date: number | null;
  previous_certificates: number | null;
  retainage_amount: number | null;
  current_amount_due: number | null;      // Line 13
  current_work_net: number | null;        // ex-tax portion
  grt_amount: number | null;
  grt_county: string | null;
  balance_to_finish: number | null;
  contractor: string | null;
  owner: string | null;
  certifier: string | null;
  /** G703 CLIN line items. Full detail requires table parser. */
  clin_lines: ClinLineItem[];
}

export interface ClinLineItem {
  clin_code: string;
  description: string | null;
  scheduled_value: number | null;
  work_from_previous: number | null;
  work_this_period: number | null;
  materials_stored: number | null;
  total_completed: number | null;
  percent_complete: number | null;
  balance_to_finish: number | null;
}

export interface PaymentRecommendationExtraction {
  report_reference: string | null;        // e.g. "Emerg03_5"
  date_of_invoice: string | null;         // ISO date field on rec
  report_date: string | null;             // ISO date
  authorization_date: string | null;      // ISO date
  applicant: string | null;
  contractor: string | null;
  fema_disaster: string | null;
  period_start: string | null;
  period_end: string | null;
  gross_amount: number | null;
  adjustment_amount: number | null;
  net_recommended_amount: number | null;
  authorized_by: string | null;
  authorizing_organization: string | null;
  clin_lines: PaymentRecClinLine[];
  county_coverage: string[];
}

export interface PaymentRecClinLine {
  clin_code: string;
  description: string | null;
  county: string | null;
  billed_amount: number | null;
  recommended_amount: number | null;
  adjustment: number | null;
  note: string | null;
}

export interface ProjectDataExtraction {
  export_type: 'row_tickets' | 'equipment_log' | 'daily_report' | 'unknown';
  invoice_reference: string | null;       // e.g. "EMERG03 SOV 5"
  period_start: string | null;
  period_end: string | null;
  total_row_count: number | null;
  computed_total: number | null;
  /** Per-CLIN subtotals derived from ticket data. */
  clin_subtotals: ClinSubtotal[];
  parse_status: 'parsed' | 'text_only' | 'failed';
  parse_note: string | null;
}

export interface ClinSubtotal {
  clin_code: string;
  ticket_count: number;
  total_amount: number;
}
```

---

---

## 5. Implementation Notes for EightForge

### 5A. What needs to change in the pipeline

**No new modules required.** All improvements flow through existing pipeline steps.

**`documentAiEnrichment.ts`** — Extend the AI prompt to return structured fields matching `ContractExtraction`, `InvoiceExtraction`, or `PaymentRecommendationExtraction` based on `document_type`. Currently the enrichment returns free-form fields. Add a typed output schema per document type so normalized values (dates, amounts, CLINs) are machine-readable.

**`extractionNormalizer.ts`** — After AI enrichment runs, write typed extraction fields into `document_extraction_fields` using the structured interfaces above. Priority fields to normalize immediately: `invoice_number`, `current_amount_due`, `period_start`, `period_end`, `nte_amount`, `computed_expiration`, `net_recommended_amount`.

**`decisionEngine.ts` (heuristic)** — Add cross-document comparison logic. After storing extraction fields, query `document_extraction_fields` for other documents in the same org with matching `contract_number`. Run `InvoiceComparisonResult` checks and generate decisions from the result. This is where `amount_match`, `date_discrepancy`, `nte_discrepancy`, and `clin_coverage` decisions come from.

**`documentAiEnrichment.ts` — summary sentence** — Add `summary_sentence` to the AI enrichment output schema. One plain-English sentence per document type. This feeds the document detail page header directly without further processing.

### 5B. Cross-document linking

Store `contract_number` (or normalized `project_id`) as an indexed field in `document_extraction_fields`. The cross-document engine queries:

```sql
SELECT d.id, def.field_name, def.field_value
FROM documents d
JOIN document_extraction_fields def ON def.document_id = d.id
WHERE d.organization_id = $1
  AND def.field_name = 'contract_number'
  AND def.field_value = $2
  AND d.id != $3
```

This returns all related documents without requiring explicit linking in the upload flow.

### 5C. NTE vs G702 discrepancy detection

This is the highest-priority cross-document check to implement. The condition is:

```typescript
if (
  contract.nte_amount !== null &&
  invoice.g702_contract_sum !== null &&
  Math.abs(contract.nte_amount - invoice.g702_contract_sum) > 100  // $100 epsilon
) {
  // Generate ALERT decision: NTE discrepancy
}
```

For the EMERG03 dataset this will fire immediately ($30M vs $80M). This is the single most impactful signal EightForge can surface.

### 5D. Invoice date discrepancy detection

```typescript
if (
  invoice.invoice_date !== null &&
  payment_rec.date_of_invoice !== null &&
  invoice.invoice_date !== payment_rec.date_of_invoice
) {
  const delta = daysBetween(invoice.invoice_date, payment_rec.date_of_invoice);
  // Generate WARNING decision if delta > 1
}
```

### 5E. Excel parsing (deferred)

Do not attempt to generate CLIN match decisions from the ROW ticket export until a structured Excel extractor is in place. In the current pipeline, `.xlsx` files produce only `text_preview`. Surface them as "Backup data — manual review required" and create a workflow task for manual reconciliation. When the table extractor ships, `ProjectDataExtraction.clin_subtotals` feeds directly into the CLIN coverage check (section 2H).

### 5F. Summary sentence generation

The AI enrichment prompt should include this instruction per document type:

> "Return a `summary_sentence` field: one plain-English sentence under 40 words that states what this document is, its most important dollar amount or date, and whether any cross-document validations passed or require attention. Do not use jargon. Write as if explaining to a non-accountant reviewer."

Example outputs to include in the prompt:
- Invoice: "Invoice EMERG03 SOV_05 for $76,359.62 was matched to the payment recommendation with no variance detected. Contractor, project, and billing period identified. Ready for approval review."
- Payment rec: "Payment Recommendation for Emerg03_5 authorizes $76,359.62 with no adjustments. Certified by Eric D. Martin (TCS) on 4/7/2025. All 12 CLIN lines verified for Mora County."
- Contract: "Contract EMERG03 between NMDOT and Stampede Ventures establishes a $30M NTE for FEMA DR-4652-NM debris operations. Term expires approximately February 12, 2025."

### 5G. Entity chip rendering

Entity chips are sourced from `document_extraction_fields` where `field_type = 'entity'`. Implement a `DetectedEntity[]` serialization in the normalizer that writes key fields as entity-typed rows. The document detail page reads these via a single query and renders them as pills without any additional AI call at render time.

### 5H. Decision severity mapping

| Category | Severity | Block payment? |
|---|---|---|
| NTE vs G702 discrepancy | ALERT | Yes |
| Duplicate invoice | ALERT | Yes |
| Amount mismatch (invoice ↔ payment rec) | ALERT | Yes |
| Contractor name mismatch | ALERT | Yes |
| Invoice date discrepancy | WARNING | No (flag only) |
| Billing period past contract expiration | WARNING | No (flag only) |
| CLIN coverage gap (San Miguel missing) | INFO | No |
| GRT rate verification | INFO | No |
| Amount match confirmed | MATCH | N/A |
| TCS certification required | INFO | Soft block |

---

*End of spec. Grounded in EMERG03 documents: Contract (EMERG03_FE.pdf), Invoice (EMERG03 SOV_05-revised.pdf), Payment Rec (Payment Rec EMERG03_05.pdf), and Excel backup (Emerg03 SOV 5 - FEB 25 - ROW ticket export.xlsx).*
