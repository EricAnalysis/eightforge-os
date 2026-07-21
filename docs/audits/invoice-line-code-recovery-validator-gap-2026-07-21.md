# Issue #92 Follow-Up: Validator Loses Invoice Line-Item Recovery

**Audit date:** 2026-07-21
**Trigger:** After `44d2b84` (issue #92, shared `resolveInvoiceLineCode`) shipped and the Golden Project was revalidated, the six `FINANCIAL_RATE_CODE_MISSING` findings against `Aftermath-Williamson Co invoice - ROW and LH .xlsx - 2026-002_01INV_InvoiceCover` did not drop. Live example: invoice 2026-002, "Tree Operations Hazardous Tree Removal 6-12 in", qty 5, $95, $475 — Documents renders rate code `5A`, Validator still reports the rate code missing.
**Verdict:** #92 is correct but incomplete. It unified line-code *derivation* across the two paths. It did not address the fact that the two paths are fed **different sets of line items**. The validator's call site disables line-item recovery entirely.

---

## 1. Root cause classification

**Mapping issue + canonical persistence issue.** Not an extraction defect, not an OCR defect, and not a defect in the #92 resolver itself.

## 2. Confirmed mechanism

`buildCanonicalInvoiceRowsFromTypedFields` does not read `typed_fields.line_items` directly. At `lib/invoices/invoiceParser.ts:2418` it routes them through a recovery step first:

```ts
const lineItems = recoverInvoiceLineItemsFromExtractionData({
  lineItems: typed.line_items,
  extractionData: params.extractionData,
  fallbackText: params.fallbackText,
});
```

`recoverInvoiceLineItemsFromExtractionData` (`invoiceParser.ts:1169-1183`) reconstructs line items from the raw extraction blob — `extraction.evidence_v1.page_text`, `content_layers_v1.pdf.text`, PDF table rows, then `extraction.text_preview` — and returns the recovered set when `shouldPreferRecoveredInvoiceLines` judges it richer than the persisted rows.

**That recovery is inert unless the caller supplies `extractionData`.** Three callers exist; only one omits it:

| Caller | Passes `extractionData`? | Effect |
|---|---|---|
| `lib/pipeline/nodes/normalizeNode.ts:4094` | Yes — `document.extraction_data` | Recovery active |
| Documents path — `toInvoiceSurfaceExtraction` → `documentIntelligenceViewModel.ts:5622` | Yes — `params.extractionData` | Recovery active |
| **`lib/validator/projectValidator.ts:1635`** (`synthesizeInvoicesFromLegacyExtractions`) | **No — `{ documentId, typedFields }` only** | **Recovery dead** |

With `extractionData: undefined`, `invoiceRecoveryTextFromExtractionData(undefined)` returns `''` (`invoiceParser.ts:1111-1160`), no lines are recovered, and the canonical rows fall back to whatever thin `typed_fields.line_items` were persisted — rate codes absent. Documents recovers `5A` from the blob; the validator never sees it. Both paths then run the same #92 resolver over different inputs and reach different answers.

## 3. The blob is already in scope at the call site

`synthesizeInvoicesFromLegacyExtractions` (`projectValidator.ts:1629-1638`) already holds the object that needs passing:

```ts
const legacyRow = params.legacyRowsByDocumentId.get(documentId) ?? null;
const legacyData = legacyObject(legacyRow?.data) as BlobExtractionData;
const typedFields = legacyObject(legacyData.fields?.typed_fields);
```

`legacyData` is the full extraction blob. The `BlobExtractionData` type (`projectValidator.ts:198-213`) declares `extraction.evidence_v1.page_text[].text` and `extraction.text_preview` at exactly the nesting `invoiceRecoveryTextFromExtractionData` expects (`asRecord(payload?.extraction)` → `asRecord(extraction?.evidence_v1)` → `page_text`). So `extractionData` should be **`legacyData`** — the whole blob — not `legacyData.fields`. This matches what `normalizeNode.ts` passes (`document.extraction_data`). No new query, no new load path, no schema change.

## 4. Why #92's test suite passed and still missed this

All four regression fixtures (`invoiceParser.test.ts:341/364/537/561`, `documentIntelligenceViewModel.test.ts:4783`) construct `typedFields` inline with line data already present and omit `extractionData`. Recovery was never exercised in any of them. The defect lives at a call site none of the tests touch. This is worth stating plainly: a green suite was not evidence the divergence was closed end to end.

## 5. Open questions Codex must resolve, not assume

1. **Exact nesting.** Verify `legacyData` (not `legacyData.fields`, not `legacyRow`) is the correct shape for `invoiceRecoveryTextFromExtractionData`. Confirm against the `BlobExtractionData` type and the function's actual reads.
2. **`shouldPreferRecoveredInvoiceLines` behavior.** The fix only helps if this heuristic actually prefers the recovered set for this document. If persisted thin rows are judged "complete enough," recovery still won't apply and the finding persists. This must be verified against the real 2026-002 shape, not assumed.
3. **`fallbackText`.** Determine whether it needs threading too, or whether `invoiceRecoveryTextFromExtractionData`'s internal `text_preview` fallback already covers the validator's case.
4. **Blast radius.** Enabling recovery changes which invoice lines the validator sees for *every* project, not just Williamson. Line counts, totals, and finding counts may shift. The Golden Project anchors (CYD `74,617`, Extended Cost `$815,559.35`) must not move.

## 6. Non-goals

- Do not modify `resolveInvoiceLineCode` or anything else shipped in `44d2b84`. It is correct.
- Do not modify the Documents/`InvoiceSurface` path. It is already correct.
- Do not touch manual rate-link resolution (`invoice_line_rate_links`, `manualRateLinkClosure.ts`, `financialIntegrity.ts` suppression). Unrelated.
- Do not change extraction, OCR, or persistence. The data already exists in the blob.

---

## Codex Implementation Prompt

```
TASK: Issue #92 follow-up. The validator's canonical invoice reconstruction
calls buildCanonicalInvoiceRowsFromTypedFields WITHOUT extractionData, which
silently disables recoverInvoiceLineItemsFromExtractionData. As a result the
validator sees thinner invoice line rows than the Documents view, and invoice
line codes present in the extraction blob (e.g. 5A, 6A on Williamson invoice
2026-002) never reach canonical truth — producing false
FINANCIAL_RATE_CODE_MISSING findings.

Read docs/audits/invoice-line-code-recovery-validator-gap-2026-07-21.md first.
It traces every file and line number below.

PHASE A — CONFIRM BEFORE CHANGING (report findings, do not skip)

1. Confirm lib/validator/projectValidator.ts:1635
   (synthesizeInvoicesFromLegacyExtractions) calls
   buildCanonicalInvoiceRowsFromTypedFields with only { documentId, typedFields },
   omitting extractionData and fallbackText.

2. Confirm the other two callers DO pass it:
   - lib/pipeline/nodes/normalizeNode.ts:4094 (document.extraction_data)
   - lib/documentIntelligenceViewModel.ts:5622 (params.extractionData)

3. Determine the correct value to pass at the validator call site. The audit's
   reading is that `legacyData` (the full blob from legacyRow.data) is correct,
   because invoiceRecoveryTextFromExtractionData reads payload.extraction.*
   and BlobExtractionData (projectValidator.ts:198-213) declares
   extraction.evidence_v1.page_text and extraction.text_preview at that level.
   VERIFY this against source rather than accepting it. Report what you find.

4. Inspect shouldPreferRecoveredInvoiceLines. Determine under what conditions
   recovered lines are preferred over persisted ones, and whether the Williamson
   2026-002 shape (thin persisted line_items, populated blob) actually triggers
   preference. If it does NOT, report that before implementing — the fix would
   be inert and the real defect is in that heuristic instead.

5. Determine whether fallbackText also needs threading, or whether the
   text_preview fallback inside invoiceRecoveryTextFromExtractionData suffices.

PHASE B — IMPLEMENTATION (minimal diff)

1. lib/validator/projectValidator.ts — pass the extraction blob (and
   fallbackText if Phase A step 5 shows it is needed) into
   buildCanonicalInvoiceRowsFromTypedFields at the synthesizeInvoicesFromLegacyExtractions
   call site. This should be a small, local change. Do not restructure the
   function, do not add a new load or query — the blob is already in scope as
   `legacyData`.

2. Change nothing else. Specifically do NOT modify resolveInvoiceLineCode,
   normalizeTypedInvoiceLine, the Documents/InvoiceSurface path, extraction,
   persistence, or any manual rate-link code.

REQUIRED TESTS

- New regression in lib/validator/projectValidator.inputLoading.test.ts (or the
  closest existing validator input-loading suite): construct a legacy extraction
  row whose typed_fields.line_items are THIN (line_code absent or leaked as a
  quantity) while the blob's extraction.evidence_v1.page_text contains the full
  row text including the code. Assert the resulting canonical InvoiceLineRow
  resolves the code and carries the expected line_code_resolution provenance.
  This test must FAIL against current main and pass after the change — confirm
  both directions explicitly and report it.

- Regression: a document with complete persisted typed_fields.line_items and no
  usable blob text produces unchanged canonical rows (recovery must not degrade
  the already-correct case).

- Regression: existing invoiceParser and documentIntelligenceViewModel #92 tests
  continue to pass unchanged.

- Golden Project anchors must not move: CYD 74,617 (ticket-grain) and Extended
  Cost $815,559.35. If any existing test asserting project totals, invoice line
  counts, or finding counts changes, STOP and report rather than updating the
  expected values.

VERIFICATION GATES

npx tsc --noEmit
npm run build
npx vitest run lib/validator/projectValidator.inputLoading.test.ts lib/invoices/invoiceParser.test.ts lib/documentIntelligenceViewModel.test.ts lib/validator/exposure.test.ts lib/validator/rulePacks/financialIntegrity.test.ts --reporter verbose

Then, because this changes which invoice lines the validator sees for every
project:
npx vitest run

Do not trigger a live Golden Project revalidation.

REPORT BACK
- Phase A answers to all five questions, especially #4
  (shouldPreferRecoveredInvoiceLines) — if the fix would be inert, say so
  instead of shipping it.
- Exact value passed as extractionData and why that nesting is correct.
- Confirmation the new regression test fails before the change and passes after.
- Any test whose expected values shifted, with the reason.
- Whether any Golden Project anchor moved.
```

---

## 7. Operator note

Until this lands, the six open `FINANCIAL_RATE_CODE_MISSING` findings on invoice 2026-002 should **not** be resolved via manual rate links. Those lines have real codes (`1A`, `1B`, `1E`, `1F`, `5A`, `6A`) in the source document. Confirming manual links now would persist operator overrides that permanently take precedence over the automated matcher (`manualRateLink ?? matchRateScheduleItemForInvoiceLine`), recording six operator decisions where none was warranted and masking whether extraction is working. The 2026-003 line 4 finding (Final Disposal, $4.25/CY) is a separate case — the contract row's own `rate_code` is null, so it may legitimately require a description-based confirmation.
