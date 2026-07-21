# Canonical Invoice-Line Normalization Boundary — Phase A Audit

**Audit date:** 2026-07-21
**Status:** Audit only. No implementation. No live mutation. No Golden Project revalidation.
**Supersedes:** the root-cause conclusion in `invoice-line-code-recovery-validator-gap-2026-07-21.md`, which was wrong. The `extractionData` call-site fix is inert (see §5).

---

## 1. Question this audit answers

For an effective invoice line fact reaching the Validator as `fact:<document>:line:N` — does it carry only `line_code`, or does it already carry `rate_code`, `billing_rate_key`, `description_match_key`, `invoice_rate_key`, `canonical_category`, `category_confidence`?

**Answer: neither extreme. It carries most canonical fields but not all.** This is closer to a bounded fix than a redesign, and the evidence below narrows it further.

## 2. What the effective fact actually contains

The fact value is `typed_fields.line_items`, copied verbatim. Confirmed write path: `buildFactLookups`/fact assembly at `projectValidator.ts:1269-1281` iterates `Object.entries(typedFields)` and pushes each `[key, value]` pair as a fact with the value untouched (`source: 'legacy_typed_field'`). `applyEffectiveInvoiceFacts` then looks up `['invoice_line_items', 'line_items']` (`projectValidator.ts:2200`) and finds exactly that array.

Those entries conform to `InvoiceLineItem` (`lib/types/extractionSchemas.ts:14-31`):

| Field | In raw fact? | Added by `normalizeTypedInvoiceLine`? |
|---|---|---|
| `line_code` | **Yes** | passthrough |
| `line_description`, `description` | Yes | passthrough |
| `quantity`, `unit`, `unit_price`, `line_total`, `total` | Yes | passthrough |
| `billing_rate_key` | **Yes** (nullable) | derived fallback if null |
| `description_match_key` | **Yes** (nullable) | derived fallback if null |
| `material`, `service_item` | Yes (optional) | passthrough / `service_item` falls back to description |
| `canonical_category` | Schema: optional — **live payload: MISSING on all six lines** | always computed via `resolveCanonicalRateCategory` |
| `category_confidence` | Schema: optional — **live payload: MISSING on all six lines** | always computed |
| `evidence_refs`, `raw_text` | Yes (optional) | passthrough |
| **`rate_code`** | **No** | **derived as `rate_code: line_code`** (`invoiceParser.ts:2331`) |
| **`invoice_rate_key`** | **No** | **derived via `deriveInvoiceRateKey`** (`invoiceParser.ts:2344`) |
| **`line_code_resolution`** | **No** | **added by #92** (`invoiceParser.ts:2352-2364`) |

So the substitution at `applyEffectiveInvoiceFacts` loses exactly three things outright — `rate_code`, `invoice_rate_key`, `line_code_resolution` — plus the *guarantee* that the nullable/optional canonical fields get computed when the extractor left them empty, plus the entire #92 `resolveInvoiceLineCode` pass (quantity-leak rejection, `raw_text` recovery, rejection provenance).

### 2a. Live payload — confirmed (2026-07-21)

Payload inspection of the Williamson 2026-002 `line_items` effective fact, all six lines identical in shape:

| Line | `line_code` | `rate_code` | `billing_rate_key` | `description_match_key` | `canonical_category` | `category_confidence` |
|---:|---|---|---|---|---|---|
| 1-6 | `1A`/`1B`/`1E`/`1F`/`5A`/`6A` | **missing** | populated (= the code) | populated | **missing** | **missing** |

Also missing on all six: `invoice_rate_key`, `line_code_resolution`. Retained on all six: `evidence_refs`, `raw_text`.

**This corrects the §2 table above.** `canonical_category` and `category_confidence` are not merely "optional but probably present" — they are absent in practice. Five of the seven canonical-contract fields are missing, not three.

Fact provenance confirmed: source is `legacy_typed_field`; no active normalized fact rows for the document; no `line_items`/`invoice_line_items` override. Unrelated active overrides exist for `client_name` and `invoice_status` only.

## 3. Blast radius is narrower than feared — with live evidence

The concern was that contract matching, category matching, description matching, and exposure are all degraded. The live system contradicts the broad version of that:

- The Validator **successfully matched** invoice 2026-003 line 4 to the governing contract row (Final Disposal, $4.25, Cubic Yard, `exhibit_a_table:pdf:table:p8:t31:r3`) and invoice 2026-002's vegetative line to $6.90/CY.
- `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` findings appear as **Resolved**, not flooding the open queue.

The mechanism is now confirmed by §2a rather than inferred: **`billing_rate_key` survives and carries the line code itself** (`1A`, `1B`, …), so `billingRateKeyForScheduleItem` exact-key matching still succeeds. `description_match_key` also survives, backing the description-key path. Separately, `financialIntegrity.lineCategory()` and `crossDocumentRateVerification.canonicalizeInvoiceLine()` both recompute category from the row rather than trusting a persisted `canonical_category` — which is why the *absence* of `canonical_category` (§2a) does not break category matching either.

**Confirmed live damage is therefore specific:** `rate_code` is never derived, so `FINANCIAL_RATE_CODE_MISSING` reads `['rate_code', 'contract_rate_code', 'item_code', 'service_code']` (`financialIntegrity.ts:27-32`), finds nothing, and fires — even though `line_code` sits populated on the same row. That is the false-positive mechanism, end to end.

**Unconfirmed and worth checking, not assuming:** whether `invoice_rate_key` absence degrades anything the Validator depends on (it is consumed mainly by transaction-data/spreadsheet-review surfaces per `projectFacts.ts:2934`, `transactionData.ts:345`), and whether any live document has null `billing_rate_key`/`description_match_key` that normalization would have filled.

## 4. Why this path exists at all

`applyEffectiveInvoiceFacts` is not a bug in intent. It is the mechanism by which **human-reviewed and operator-corrected** invoice line items override synthesized ones — effective facts rank above raw extraction in the canonical precedence order. The defect is that it substitutes at the wrong *grain*: it replaces fully-normalized canonical rows with un-normalized extractor output, discarding derived fields that no reviewer ever asserted or intended to remove.

This is why the fix cannot simply be "run `normalizeTypedInvoiceLine` over the replacements." Normalization must **fill derived fields without overwriting asserted ones**, or operator corrections get silently reparsed.

## 5. Why the previous proposed fix was inert

`shouldPreferRecoveredInvoiceLines` (`invoiceParser.ts:1088-1105`) requires `recovered.codeCount > current.codeCount` (line 1095, strict). The live 2026-002 blob already has six typed lines with codes `1A/1B/1E/1F/5A/6A`. Recovery can produce at most six. `6 <= 6` → recovery correctly declines. Passing `extractionData` at `projectValidator.ts:1635` changes nothing for this document. The omission is real and worth closing for thin-blob documents, but it is **not** the cause of the current findings and must not be presented as the fix.

Decisive tell that was available and missed: live finding subjects are `fact:<doc>:line:N`. Canonical synthesis produces `typed:<doc>:invoice:line:N` (`invoiceParser.ts:2325`, `2423`). The `fact:` prefix is generated only at `projectValidator.ts:2218` — inside `applyEffectiveInvoiceFacts`. The subject ID identified the responsible code path the whole time.

## 6. Proposed invariant (Priority 3)

> **Every invoice line entering the Validator must satisfy the canonical invoice-line contract, regardless of origin — OCR, `typed_fields`, `invoice_line_items` fact, operator override, or legacy import.**
>
> Normalization at this boundary is **additive only**: it derives missing canonical fields and must never overwrite a value asserted by a higher-trust source (human review, operator override).

Concretely, the canonical contract should require: `rate_code`, `billing_rate_key`, `description_match_key`, `invoice_rate_key`, `canonical_category`, `category_confidence`, and `line_code_resolution` provenance — each either populated or explicitly null with a recorded reason.

Consequence once true: `financialIntegrity`, `crossDocumentRateVerification`, `contractInvoiceReconciliation`, `exposure`, execution, and any future AI reasoning layer all consume one shape, and no rule pack needs to know which ingestion path produced a row.

## 7. Confirmation semantics — resolved from the existing API contract

Payload inspection surfaced that `line_items` on this document was **confirmed three times** (twice 2026-05-28, once 2026-07-20), each with `reviewed_value_json = null`, and that `projectValidator.ts:1319-1325` skips any review whose `reviewed_value_json` is null. So the document is operator-touched but not operator-authored at line level.

This does **not** require inventing a new semantic. The existing review API already defines it (`app/api/documents/[id]/facts/review/route.ts:70-76`):

```ts
const reviewedValueJson = hasOwnProperty(body, 'reviewedValueJson') ? body.reviewedValueJson : null;
if (reviewStatus === 'corrected' && reviewedValueJson == null) {
  return jsonError('reviewedValueJson is required when reviewStatus is corrected', 400);
}
```

A payload is **required for `corrected`** and **optional for `confirmed`**. A null-payload confirmation is therefore intentional API design, not a defect in the review writer:

- `corrected` → carries a replacement payload → asserts new values.
- `confirmed` → carries no payload → **attests that the existing extracted values are correct**.

The validator's current skip is correct as far as it goes (you cannot build a replacement fact from a null payload), but it means a confirmation currently produces *zero* canonical effect.

**Decision:** a `confirmed` review on `line_items` means "these six lines are correct as extracted." It makes no assertion about derived fields. Deriving `rate_code` from a confirmed `line_code` therefore **honors** the confirmation rather than contradicting it. The fix belongs at the validator boundary, not the review writer.

### Adopted precedence rule

> A field-level confirmation of an existing invoice-line array permits **additive canonical completion**. Every populated line value, row identity, evidence reference, and raw-text anchor remains **immutable**.
>
> Ordering: **operator-asserted > system-derived.** A derived field must never overwrite a value present on the row. A future `corrected` review carrying an explicit `rate_code` wins over derivation.
>
> A null `reviewed_value_json` must **never** be treated as a replacement payload. It attests; it does not blank.
>
> Completion must be recorded in provenance (`line_code_resolution`) so the audit trail distinguishes an operator-asserted `rate_code` from a system-derived one.

## 7a. Implementation shape

Calling `normalizeTypedInvoiceLine` directly at this boundary is **unsafe** — it unconditionally assigns `rate_code: line_code` (`invoiceParser.ts:2331`) and reconstructs other fields wholesale, which would reparse rather than complete. A dedicated additive-completion helper is required: fill only fields that are absent, leave every populated field untouched.

Fields to complete: `rate_code`, `invoice_rate_key`, `canonical_category`, `category_confidence`, `line_code_resolution`, plus fallbacks for `billing_rate_key`/`description_match_key` when null.

Required tests (per §8 non-goals and the rule above):
- Fills every missing canonical field without altering any populated field.
- Preserves `evidence_refs`, `raw_text`, and row identity (`fact:<doc>:line:N`) exactly — row-ID drift breaks finding continuity and any existing manual rate links.
- Covers null-value `line_items` confirmations (must complete, must not blank).
- Covers a higher-priority `corrected` review carrying an actual payload (operator value must win over derivation).
- Confirms all six 2026-002 codes reach financial validation as canonical `rate_code`, eliminating the false positives.
- Golden anchors unmoved: CYD `74,617`, Extended Cost `$815,559.35`.

## 8. Non-goals for whatever ships next

- Do not modify `resolveInvoiceLineCode` or anything from `44d2b84`. It is correct.
- Do not modify the Documents/`InvoiceSurface` path. It is correct.
- Do not touch manual rate-link resolution.
- Do not change extraction, OCR, or persistence — the data already exists on the row as `line_code`.
- Do not "fix" this by adding `line_code` to `INVOICE_LINE_RATE_CODE_KEYS` in `financialIntegrity.ts`. That patches one rule while leaving the boundary broken for every other consumer, and directly contradicts the §6 invariant.

## 9. Operator note (unchanged)

The open `FINANCIAL_RATE_CODE_MISSING` findings on invoice 2026-002 are false positives — those lines carry real codes (`1A`, `1B`, `1E`, `1F`, `5A`, `6A`). Do not resolve them with manual rate links; that would persist operator overrides which permanently outrank the automated matcher and mask the defect. Invoice 2026-003 line 4 remains a separate, legitimate case (the contract row's own `rate_code` is null).
