# EightForge Document Intelligence — Implementation Plan
## Converting the Output Model Spec into Shippable Increments

**Version:** 1.0
**Date:** 2026-03-17
**Source of truth:** `docs/document-intelligence-output-model.md`
**Constraint:** No new modules unless unavoidable. Map all changes to existing files. Production-safe and incremental.

---

## 1. Highest Priority Outputs to Ship First

Ordered by user value and MVP leverage.

**#1 — Summary sentence above the fold**
The single highest-impact change for a reviewer opening a document. One plain-English sentence tells them what the document is and whether it passed or has issues — before they read anything else. No new infrastructure. Requires one prompt change and one UI render.

**#2 — Operational entity chips from extracted fields**
Contract number, FEMA disaster, NTE, current amount due, billing period, payment monitor — these are the fields a reviewer looks for first. Currently they're buried in a raw JSON blob. Pulling them into chips above the fold makes the detail page immediately useful without scrolling.

**#3 — NTE vs G702 contract sum discrepancy detection**
This is the most critical operational signal EightForge can surface on the EMERG03 dataset: a $50M discrepancy between contract NTE and the invoice's declared contract sum. It's purely arithmetic — no AI required. Requires writing two extraction fields (`nte_amount`, `g702_contract_sum`) into the fact store and comparing them at decision time.

**#4 — Amount match: invoice ↔ payment recommendation**
Once both invoice and payment rec are extracted, confirming the dollar amounts match is the first thing a Thompson consultant or NMDOT reviewer checks. This is a cross-document arithmetic comparison. Requires `current_amount_due` from invoice and `net_recommended_amount` from payment rec as fact rows, then a comparison step in the pipeline.

**#5 — Invoice date discrepancy**
A 5-day date gap between the G702 date field and the payment rec's "Date of Invoice" field is a real audit risk. Catch it automatically and generate a WARNING decision. Pure text extraction + comparison.

---

## 2. File-by-File Implementation Plan

### 2A. `lib/types/extractionSchemas.ts`

**What to change:** Add EMERG03-specific fields to the existing `ContractExtraction` and `InvoiceExtraction` types. Add a new `PaymentRecExtraction` type. Add `summary_sentence` to all three.

**Fields to add to `ContractExtraction`:**
```typescript
contract_number: string | null;         // "EMERG03"
nte_amount: number | null;              // 30000000
fema_disaster: string | null;           // "DR-4652-NM"
payment_monitor: string | null;         // "Thompson Consulting Services"
term_months: number | null;             // 6
computed_expiration: string | null;     // ISO date, derived from executed_date + term_months
summary_sentence: string | null;
```

**Fields to add to `InvoiceExtraction`:**
```typescript
application_number: string | null;      // "05"
period_start: string | null;            // "2025-02-01"
period_end: string | null;              // "2025-02-28"
g702_contract_sum: number | null;       // 80000000  ← critical for NTE check
current_amount_due: number | null;      // 76359.62
summary_sentence: string | null;
```

**New type to add:**
```typescript
export type PaymentRecExtraction = {
  schema_type: 'payment_rec';
  report_reference: string | null;      // "Emerg03_5"
  date_of_invoice: string | null;       // "2025-03-17" ← compare to G702 date
  period_start: string | null;
  period_end: string | null;
  contractor: string | null;
  net_recommended_amount: number | null; // 76359.62
  adjustment_amount: number | null;
  authorized_by: string | null;
  authorization_date: string | null;
  summary_sentence: string | null;
};
```

Update `TypedExtraction` union:
```typescript
export type TypedExtraction =
  | ContractExtraction
  | InvoiceExtraction
  | ReportExtraction
  | PaymentRecExtraction;
```

Update `SupportedDocumentType`:
```typescript
export type SupportedDocumentType = 'contract' | 'invoice' | 'report' | 'payment_rec';
```

**Supports:** outputs #1 (summary), #2 (entity chips), #3 (NTE check), #4 (amount match), #5 (date discrepancy)
**Why it matters:** Every downstream change — extraction, normalization, decisions, UI — depends on these types being defined first.

---

### 2B. `lib/server/documentExtraction.ts`

**What to change:** Add regex patterns and extraction logic for the new fields. Add `extractPaymentRecFields()`. Update `deriveTypedFields()` to route `payment_rec` document type.

**New regex constants to add** (at top of file with existing patterns):
```typescript
// Contract — NTE and contract number
const CONTRACT_NUMBER_RE = /(?:contract\s*(?:no\.?|number|#)\s*[:=]?\s*)([A-Z0-9\-]+)/gi;
const NTE_RE = /(?:not\s+to\s+exceed|NTE|maximum\s+contract\s+(?:amount|value))\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;
const FEMA_DISASTER_RE = /DR-(\d{4})-([A-Z]{2})/gi;
const PAYMENT_MONITOR_RE = /(?:payment\s+monitor|monitoring\s+(?:consultant|firm|service)|certif(?:ied|ying)\s+by)\s*[:=]?\s*([A-Z][A-Za-z &.,'-]{3,60})/gi;
const TERM_MONTHS_RE = /(\d+)\s*[-\s]?month\s+term/gi;

// Invoice — G702/G703 specific
const PERIOD_RE = /(?:billing\s+period|period\s+(?:of|from|:)|period\s+to|work\s+period)\s*[:=]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*(?:to|through|[-–])\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi;
const CURRENT_DUE_RE = /(?:current\s+payment\s+due|current\s+amount\s+due|amount\s+this\s+(?:application|period)|total\s+current\s+due)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;
const G702_CONTRACT_SUM_RE = /(?:original\s+contract\s+sum|contract\s+sum|line\s+1\.?\s*original)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;
const APPLICATION_NUMBER_RE = /(?:application\s+(?:and\s+certification\s+for\s+payment\s+)?no\.?|application\s*#)\s*[:=]?\s*(\d+)/gi;

// Payment rec specific
const PAYMENT_REC_INVOICE_DATE_RE = /(?:date\s+of\s+invoice|invoice\s+date)\s*[:=]?\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi;
const NET_RECOMMENDED_RE = /(?:net\s+recommended|recommended\s+(?:amount|payment)|net\s+amount\s+recommended)\s*[:=]?\s*\$?\s*([\d,]+(?:\.\d{1,2})?)/gi;
const AUTHORIZED_BY_RE = /(?:authorized\s+by|approved\s+by|certified\s+by|signature)\s*[:=]?\s*([A-Z][A-Za-z .,'-]{3,50})/gi;
```

**Updates to `extractContractFields()`:** After existing extractions, add:
```typescript
const contract_number = firstMatch(text, CONTRACT_NUMBER_RE);
const nteRaw = firstMatch(text, NTE_RE);
const nte_amount = nteRaw ? parseAmount(nteRaw) : null;
const fema_disaster = firstMatch(text, FEMA_DISASTER_RE, 0); // full DR-XXXX-XX match
const payment_monitor = firstMatch(text, PAYMENT_MONITOR_RE);
const termMonthsRaw = firstMatch(text, TERM_MONTHS_RE);
const term_months = termMonthsRaw ? parseInt(termMonthsRaw, 10) : null;
```
Add these fields to the returned `ContractExtraction` object.

**Updates to `extractInvoiceFields()`:** After existing extractions, add:
```typescript
const application_number = firstMatch(text, APPLICATION_NUMBER_RE);
const currentDueRaw = firstMatch(text, CURRENT_DUE_RE);
const current_amount_due = currentDueRaw ? parseAmount(currentDueRaw) : null;
const g702SumRaw = firstMatch(text, G702_CONTRACT_SUM_RE);
const g702_contract_sum = g702SumRaw ? parseAmount(g702SumRaw) : null;
// Period
const periodRe = new RegExp(PERIOD_RE.source, PERIOD_RE.flags);
const periodMatch = periodRe.exec(text);
const period_start = periodMatch?.[1] ?? null;
const period_end = periodMatch?.[2] ?? null;
```
Add these fields to the returned `InvoiceExtraction` object.

**New function `extractPaymentRecFields()`:**
```typescript
function extractPaymentRecFields(text: string): PaymentRecExtraction {
  const report_reference = firstMatch(text, INVOICE_NUMBER_RE) ?? firstMatch(text, CONTRACT_NUMBER_RE);
  const date_of_invoice = firstMatch(text, PAYMENT_REC_INVOICE_DATE_RE);
  const periodRe = new RegExp(PERIOD_RE.source, PERIOD_RE.flags);
  const pm = periodRe.exec(text);
  const period_start = pm?.[1] ?? null;
  const period_end = pm?.[2] ?? null;
  const contractor = firstMatch(text, VENDOR_NAME_RE);
  const netRaw = firstMatch(text, NET_RECOMMENDED_RE);
  const net_recommended_amount = netRaw ? parseAmount(netRaw) : null;
  const adjRaw = firstMatch(text, TOTAL_AMOUNT_RE); // fallback to total if no adjustment line
  const adjustment_amount = 0; // default 0 — real value requires specific pattern
  const authorized_by = firstMatch(text, AUTHORIZED_BY_RE);
  const authorization_date = firstMatch(text, DATE_RE);
  return {
    schema_type: 'payment_rec',
    report_reference,
    date_of_invoice,
    period_start,
    period_end,
    contractor,
    net_recommended_amount,
    adjustment_amount,
    authorized_by,
    authorization_date,
    summary_sentence: null, // populated by AI enrichment
  };
}
```

**Update `deriveTypedFields()`:**
```typescript
case 'payment_rec': return extractPaymentRecFields(text);
```

**Supports:** outputs #3, #4, #5 (all cross-doc checks depend on these values being extracted)
**Why it matters:** Without these fields in `typed_fields`, the normalizer has nothing to write and the decision engine has nothing to compare.

---

### 2C. `lib/server/extractionNormalizer.ts`

**What to change:** Add an explicit "high-value field" pass that writes the EMERG03-critical fields as indexed `field_key` rows regardless of how `flattenTypedFields` handles them. These rows are what the cross-document engine queries by `field_key`.

**Add after the existing `typedFields` block:**
```typescript
// ── High-value operational fields — written as first-class fact rows ──────
// These are the fields the cross-document engine queries by field_key.
// Written explicitly so they survive schema changes in typed_fields.
const typed = payload.fields?.typed_fields;
if (typed && typeof typed === 'object') {
  const t = typed as Record<string, unknown>;

  // Shared across types
  const highValueFields: Array<{ key: string; value: unknown; type: ExtractionFactInput['field_type'] }> = [];

  if (t.schema_type === 'contract') {
    if (t.contract_number)   highValueFields.push({ key: 'contract_number', value: t.contract_number, type: 'text' });
    if (t.nte_amount != null) highValueFields.push({ key: 'nte_amount', value: t.nte_amount, type: 'number' });
    if (t.fema_disaster)     highValueFields.push({ key: 'fema_disaster', value: t.fema_disaster, type: 'text' });
    if (t.payment_monitor)   highValueFields.push({ key: 'payment_monitor', value: t.payment_monitor, type: 'text' });
    if (t.vendor_name)       highValueFields.push({ key: 'contractor_name', value: t.vendor_name, type: 'text' });
    if (t.term_months != null) highValueFields.push({ key: 'term_months', value: t.term_months, type: 'number' });
    if (t.expiration_date)   highValueFields.push({ key: 'expiration_date', value: t.expiration_date, type: 'text' });
  }

  if (t.schema_type === 'invoice') {
    if (t.invoice_number)    highValueFields.push({ key: 'invoice_number', value: t.invoice_number, type: 'text' });
    if (t.application_number) highValueFields.push({ key: 'application_number', value: t.application_number, type: 'text' });
    if (t.current_amount_due != null) highValueFields.push({ key: 'current_amount_due', value: t.current_amount_due, type: 'number' });
    if (t.g702_contract_sum != null)  highValueFields.push({ key: 'g702_contract_sum', value: t.g702_contract_sum, type: 'number' });
    if (t.period_start)      highValueFields.push({ key: 'period_start', value: t.period_start, type: 'text' });
    if (t.period_end)        highValueFields.push({ key: 'period_end', value: t.period_end, type: 'text' });
    if (t.vendor_name)       highValueFields.push({ key: 'contractor_name', value: t.vendor_name, type: 'text' });
    if (t.invoice_date)      highValueFields.push({ key: 'invoice_date', value: t.invoice_date, type: 'text' });
  }

  if (t.schema_type === 'payment_rec') {
    if (t.report_reference)  highValueFields.push({ key: 'report_reference', value: t.report_reference, type: 'text' });
    if (t.net_recommended_amount != null) highValueFields.push({ key: 'net_recommended_amount', value: t.net_recommended_amount, type: 'number' });
    if (t.date_of_invoice)   highValueFields.push({ key: 'date_of_invoice', value: t.date_of_invoice, type: 'text' });
    if (t.period_start)      highValueFields.push({ key: 'period_start', value: t.period_start, type: 'text' });
    if (t.period_end)        highValueFields.push({ key: 'period_end', value: t.period_end, type: 'text' });
    if (t.contractor)        highValueFields.push({ key: 'contractor_name', value: t.contractor, type: 'text' });
    if (t.authorized_by)     highValueFields.push({ key: 'authorized_by', value: t.authorized_by, type: 'text' });
  }

  for (const { key, value, type } of highValueFields) {
    facts.push({
      document_id: documentId,
      organization_id: organizationId,
      field_key: key,
      field_type: type,
      value: value as string | number | boolean | Date | null,
      source: 'heuristic_extraction',
      confidence: 0.8,
    });
  }
}
```

**Supports:** outputs #3, #4, #5
**Why it matters:** The cross-document engine queries `document_extractions` by `field_key`. If these fields aren't written as rows, the cross-doc query returns nothing. This is the bridge between extraction and decisions.

---

### 2D. `lib/server/documentAiEnrichment.ts`

**What to change:**
1. Add `summary_sentence` to `AiEnrichmentResult` type.
2. Update `buildPrompt()` to request `summary_sentence` in the JSON schema and add document-type-specific guidance for debris ops.
3. Update `normalizeModelOutput()` to extract and clamp `summary_sentence`.

**Type change:**
```typescript
export type AiEnrichmentResult = {
  summary_sentence: string | null;       // ← NEW
  classification: string | null;
  key_clauses: string[];
  pricing_summary: string | null;
  scope_summary: string | null;
  eligibility_risks: string[];
  termination_flags: string[];
  confidence_note: string | null;
  provider: 'claude' | 'openai' | 'openai_mini' | 'gemini' | 'none' | 'error';
  enriched_at: string;
};
```

**`makeBase()` change:** Add `summary_sentence: null` to the returned object.

**`buildPrompt()` schema block change:**
```
{
  "summary_sentence": string | null,   ← ADD (first field)
  "classification": string | null,
  "key_clauses": string[],
  ...
}
```

**`buildPrompt()` guidance block — replace generic guidance with:**
```
Guidance: You are analyzing FEMA Public Assistance debris operations documents for EMERG03 (DR-4652-NM, New Mexico).

summary_sentence: Write ONE plain-English sentence (under 40 words) that states: what document this is, its single most important dollar amount or date, and whether any obvious cross-document validations appear to have passed or need attention. Write for a non-accountant reviewer. Do not use jargon. Examples:
- Invoice: "Invoice EMERG03 SOV_05 for $76,359.62 covers February 2025 debris ops and has been matched to the payment recommendation with no dollar variance."
- Contract: "Contract EMERG03 between NMDOT and Stampede Ventures sets a $30M NTE for DR-4652-NM debris removal; the 6-month term expires approximately February 2025."
- Payment rec: "Payment Recommendation for Emerg03_5 authorizes $76,359.62 with no adjustments; certified by Eric D. Martin (Thompson Consulting Services) on 4/7/2025."

For all other fields: identify operationally relevant signals including FEMA eligibility risks, NTE or payment term concerns, contractor identification, billing period coverage, and rate structure.
```

**`normalizeModelOutput()` change:**
```typescript
return {
  summary_sentence: clampString(obj.summary_sentence, 300),  // ← ADD
  classification: clampString(obj.classification, 200),
  ...
};
```

**Supports:** output #1 (summary sentence)
**Why it matters:** The summary sentence is the above-the-fold anchor. Without it, the document detail page still leads with a filename and status badge — useless to a reviewer.

---

### 2E. `lib/server/heuristicDecisionEngine.ts`

**What to change:** Add a new exported function `runCrossDocumentChecks()` at the bottom of the file. This function takes the current document's extracted facts and queries the org's other documents for matching fact rows. No new file — this is new logic in the existing heuristic engine file.

**New function signature:**
```typescript
export async function runCrossDocumentChecks(params: {
  documentId: string;
  organizationId: string;
  documentType: string | null;
}): Promise<DocumentDecision[]>
```

**Logic inside `runCrossDocumentChecks()`:**

```
Step 1: Load current document's high-value fact rows from document_extractions
        (field_key IN [invoice_number, application_number, current_amount_due,
                       g702_contract_sum, invoice_date, period_start, period_end,
                       nte_amount, net_recommended_amount, date_of_invoice,
                       report_reference, contractor_name])

Step 2: Find related documents in same org that share a contract_number
        or whose invoice_number / report_reference normalizes to same value.
        Query: SELECT d.id, de.field_key, de.field_value_text, de.field_value_number
               FROM documents d JOIN document_extractions de ON de.document_id = d.id
               WHERE d.organization_id = $orgId AND d.id != $documentId
               AND de.field_key IN ('contract_number','invoice_number','report_reference',
                                    'net_recommended_amount','date_of_invoice',
                                    'nte_amount','g702_contract_sum')
               AND de.status = 'active'

Step 3: Run checks based on current document type:

  IF documentType = 'invoice':
    A. NTE check: find contract with field_key='nte_amount' for same contract
       if |nte_amount - g702_contract_sum| > 100 → ALERT: nte_discrepancy
    B. Amount match: find payment_rec with field_key='net_recommended_amount'
       if |current_amount_due - net_recommended_amount| <= 0.01 → MATCH: amount_matched
       else → ALERT: amount_mismatch
    C. Date discrepancy: find payment_rec with field_key='date_of_invoice'
       if invoice_date !== date_of_invoice → WARNING: invoice_date_discrepancy
    D. Term check: find contract with field_key='expiration_date'
       if period_end > expiration_date → WARNING: billing_past_contract_term

  IF documentType = 'payment_rec':
    A. Same checks in reverse — compare against linked invoice
    B. Amount match confirmation or alert

  IF documentType = 'contract':
    A. NTE check against any invoices in org for same contract
```

**Decision row shape for cross-doc decisions** (uses existing `document_decisions` table via the same admin insert pattern already in the file):
```typescript
{
  document_id: params.documentId,
  organization_id: params.organizationId,
  decision_type: 'cross_doc_amount_match' | 'cross_doc_nte_discrepancy' |
                 'cross_doc_date_discrepancy' | 'cross_doc_term_overrun',
  decision_value: string,   // e.g. "$0.00 variance — matched" or "$50M delta"
  confidence: 0.95,
  source: 'deterministic',
}
```

**Supports:** outputs #3 (NTE discrepancy), #4 (amount match), #5 (date discrepancy)
**Why it matters:** This is the core new capability. Without it, EightForge can only analyze documents in isolation.

---

### 2F. `lib/pipeline/processDocument.ts`

**What to change:** Add a call to `runCrossDocumentChecks()` as a new step after step 6 (normalization) and before step 7 (mark extracted). This is the only place to wire the cross-doc engine into the pipeline — no other file owns this flow.

**Import to add:**
```typescript
import { runCrossDocumentChecks } from '@/lib/server/heuristicDecisionEngine';
```

**New step to add** (between steps 6 and 7, inside the try block):
```typescript
// ── 6.5. Cross-document intelligence checks ─────────────────────────────
// Run after normalization writes fact rows so related documents can be
// queried by field_key. Best-effort — never fails the pipeline.
try {
  await runCrossDocumentChecks({
    documentId: params.documentId,
    organizationId: params.organizationId,
    documentType: documentType,
  });
} catch (crossDocErr) {
  console.error('[processDocument] cross-doc checks (non-fatal):', crossDocErr);
}
```

**Supports:** outputs #3, #4, #5 (all cross-doc decisions)
**Why it matters:** The pipeline is the only place that orchestrates the full sequence. Cross-doc checks must run after normalization writes the fact rows.

---

### 2G. `app/platform/documents/[id]/page.tsx`

**What to change:** Four targeted UI changes. No data fetch changes — all new fields are already fetched via existing queries.

**Change 1 — Summary sentence** (add above entity chips, after the status header block):

The AI enrichment result is already in `extractions[0].data.ai_enrichment`. Read `summary_sentence` from there and render it at the top of the page body if present.

```tsx
// Derive summary sentence from latest extraction
const summaryRow = extractions[0]?.data;
const summaryAi = summaryRow?.ai_enrichment as Record<string, unknown> | undefined;
const summaryText = typeof summaryAi?.summary_sentence === 'string'
  ? summaryAi.summary_sentence
  : null;

// Render above entity chips:
{summaryText && (
  <div className="rounded-md border border-[#1A1A3E] bg-[#0A0A2A] px-4 py-3">
    <p className="text-[12px] text-[#F5F7FA] leading-relaxed">{summaryText}</p>
  </div>
)}
```

**Change 2 — Expand entity chip keys** (update `ENTITY_KEYS` constant at line ~194):

```typescript
const ENTITY_KEYS = new Set([
  // Existing
  'ticket_number', 'contract_number', 'invoice_number', 'project_name',
  'location', 'date', 'amount', 'material', 'vendor', 'customer',
  'site', 'hauler', 'disposal_site',
  // NEW: operational fields from EMERG03 spec
  'nte_amount', 'current_amount_due', 'g702_contract_sum',
  'net_recommended_amount', 'fema_disaster', 'payment_monitor',
  'contractor_name', 'period_start', 'period_end', 'application_number',
  'authorized_by', 'report_reference',
]);
```

**Change 3 — Render cross-doc decisions with operational label** (update the `PersistentDecisionRow` section):

Cross-doc decisions land in `workflow_decisions` (persistent decisions table) with `decision_type` starting with `cross_doc_`. Add a label map so they display as human-readable text rather than raw `decision_type` keys:

```typescript
const DECISION_TYPE_LABELS: Record<string, string> = {
  cross_doc_amount_match:        '✅ Amount matched',
  cross_doc_nte_discrepancy:     '🚨 NTE vs contract sum discrepancy',
  cross_doc_date_discrepancy:    '⚠️ Invoice date discrepancy',
  cross_doc_term_overrun:        '⚠️ Billing period past contract term',
  cross_doc_amount_mismatch:     '🚨 Amount mismatch',
};
```

Replace raw `titleize(d.decision_type)` calls with:
```typescript
DECISION_TYPE_LABELS[d.decision_type] ?? titleize(d.decision_type)
```

**Change 4 — Move decisions and workflow tasks above raw extraction JSON**:

Currently the render order is: metadata → decisions → workflow tasks → extraction JSON blob. Confirm the persistent decisions section and workflow tasks section render before the extraction JSON accordion. If they're already in the right order, no change needed. If raw JSON comes before decisions in the current render order, swap the sections so JSON is last.

*(Based on the current file structure, decisions/tasks appear before the JSON preview — verify this hasn't drifted.)*

**Supports:** all 5 outputs
**Why it matters:** The most important outputs should be visible without scrolling. Raw JSON is for debugging, not for reviewers.

---

## 3. Implementation Order

This is the fastest safe order — each step unblocks the next without requiring a full-stack test cycle after every change.

**Phase 1 — Type foundation** *(~30 min, zero risk)*
1. `lib/types/extractionSchemas.ts` — add new fields and `PaymentRecExtraction` type. TypeScript will immediately highlight all call sites that need updating. No runtime change yet.

**Phase 2 — Extraction layer** *(~1 hour, isolated risk)*
2. `lib/server/documentExtraction.ts` — add regex patterns and update `extractContractFields()`, `extractInvoiceFields()`. Add `extractPaymentRecFields()`. Update `deriveTypedFields()` switch.
3. Test: reprocess one contract and one invoice. Inspect `document_extractions` blob row to confirm `contract_number`, `nte_amount`, `current_amount_due`, `g702_contract_sum` appear in `typed_fields`.

**Phase 3 — Normalization** *(~30 min, isolated risk)*
4. `lib/server/extractionNormalizer.ts` — add explicit high-value field pass.
5. Test: after reprocess, query `document_extractions` for `field_key = 'nte_amount'`. Confirm a row exists with `field_value_number = 30000000` for the contract document.

**Phase 4 — Cross-document engine** *(~2 hours, highest risk, keep non-fatal)*
6. `lib/server/heuristicDecisionEngine.ts` — add `runCrossDocumentChecks()` at the bottom.
7. `lib/pipeline/processDocument.ts` — add step 6.5 call. Keep the entire call wrapped in try/catch so it's non-fatal.
8. Test: reprocess the invoice after the contract is already in the system. Check `document_decisions` for `decision_type LIKE 'cross_doc_%'`. Confirm `cross_doc_nte_discrepancy` appears with `decision_value` containing the delta.

**Phase 5 — AI enrichment** *(~30 min, safe)*
9. `lib/server/documentAiEnrichment.ts` — add `summary_sentence` to type, prompt, and normalizer.
10. Test: reprocess with `analysis_mode = 'ai_enriched'`. Confirm `extractions[0].data.ai_enrichment.summary_sentence` is a non-null string.

**Phase 6 — UI** *(~1 hour, frontend only)*
11. `app/platform/documents/[id]/page.tsx` — apply all 4 changes.
12. Test: open document detail page. Confirm summary sentence renders. Confirm entity chips include `nte_amount` and `current_amount_due`. Confirm cross-doc decision types render with human-readable labels.

---

## 4. First Release Scope

The minimum version of the new output model that should ship in the first release:

**Must ship:**
- `summary_sentence` rendered above the fold (even if null for non-AI orgs — gracefully absent)
- Entity chips for `contract_number`, `nte_amount`, `current_amount_due`, `fema_disaster`, `period_start`, `period_end`
- `extractContractFields()` producing `contract_number` and `nte_amount`
- `extractInvoiceFields()` producing `current_amount_due`, `g702_contract_sum`, `period_start`, `period_end`
- `extractionNormalizer.ts` writing those fields as typed `field_key` rows
- `cross_doc_nte_discrepancy` decision generated when |nte_amount - g702_contract_sum| > 100
- `cross_doc_amount_match` or `cross_doc_amount_mismatch` when invoice and payment rec are both present
- Decision labels rendering as human-readable strings in the UI

**Acceptable gaps for first release:**
- `extractPaymentRecFields()` — ship it but date_of_invoice regex may need tuning on real docs
- `cross_doc_date_discrepancy` — ship but with a wider epsilon (>3 days) to avoid false positives
- `summary_sentence` absent for `analysis_mode = 'deterministic'` orgs — show nothing, not an error
- CLIN-level detail — not in first release

---

## 5. Defer Until Later

These are in the spec but should wait until after the first release of improved outputs.

**CLIN line item structured extraction**
G703 is a table. `pdf-parse` returns linearized text that doesn't preserve table structure. Extracting per-CLIN amounts reliably requires either a table extraction library or Claude vision. Defer until a proper table parser is in place. In the meantime: surface G703 CLINs as a comma-separated list of detected CLIN codes (from keyword scan), not dollar amounts.

**Excel ROW ticket reconciliation**
No structured Excel parser is wired into the pipeline. `.xlsx` files produce `binary_fallback` mode. Do not attempt to generate CLIN match decisions from this document type. Surface as "Backup data — manual reconciliation required" and generate a workflow task. Defer full reconciliation until `xlsx-js` or similar is added to `documentExtraction.ts`.

**`PaymentRecExtraction` - full field coverage**
The `date_of_invoice` pattern and `net_recommended_amount` pattern need to be tuned against more payment rec examples. Ship the type and basic extraction, but the cross-doc date check should be treated as best-effort in first release.

**Computed contract expiration**
Deriving expiration from `executed_date + term_months` requires date parsing that handles multiple date formats (MM/DD/YYYY, spelled-out months). The `expiration_date` regex in `extractContractFields()` tries to pull an explicit date; if not present, computing it from term requires reliable `executed_date` extraction. Defer the derived field until date normalization is more robust.

**Contract term check** (`cross_doc_term_overrun`)
Depends on `expiration_date` or `computed_expiration` being reliably extracted. Ship the detection logic but mark as INFO severity until the expiration date extraction is validated.

**AI-enriched entity chip generation** (`DetectedEntity[]` from prompt)
The current UI derives entity chips by scanning the extraction blob for known keys. The richer approach — AI returning a structured `entities` array — would require a prompt expansion and a new UI fetch. Defer to a later iteration once summary_sentence is validated end-to-end.

**Duplicate invoice detection**
Requires querying all invoices in the org by `application_number + contract_number`. The logic is simple but needs a Supabase index on `document_extractions(organization_id, field_key, field_value_text)` for performance. Add the index first (one migration), then ship the detection. Defer until after first release.

**San Miguel County vs Mora County CLIN split**
Payment rec covers Mora County only. Detecting that San Miguel County CLINs are missing from the payment rec requires both CLIN-level extraction (deferred above) and county tagging. Defer entirely.

---

*End of implementation plan. All changes map to existing files. No new modules required for the first release scope.*
