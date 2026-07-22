# Documents Provenance Surfacing — Phase A Audit (Priority 5)

**Audit date:** 2026-07-22
**Scope:** How the Documents surface obtains and renders effective facts, arrays, invoice lines, operator confirmations, corrections, and additively-derived canonical fields — and how clearly it distinguishes extracted / derived / confirmed / corrected provenance.
**Status:** Audit only. No implementation, no schema, no live mutation. Source read this session. Inferences marked **[inferred]**.
**Origin:** Roadmap item 5. Connects to the priority-1 boundary work (rate_code/rate_code_origin/line_code_resolution) and the Forge-lifecycle audit's UX note.

---

## 1. Executive summary

**Scalar-fact provenance is already excellent and fully rendered. Invoice-line provenance is entirely absent, and the validator's additive canonical completion is unavailable to Documents.** Precisely:

- **Scalar facts** carry a rich, correct provenance model (`DocumentFact`) and `FactLedger` renders all of it: an extracted/reviewed/overridden/derived **state** badge, a `human_added`/`human_corrected` **source** badge, a `confirmed`/`corrected`/`needs_followup`/`missing_confirmed` **review** badge, the corrected value **with the machine value shown beside it** (`Machine: …`), plus full review/override history. Precedence is `override > review > machine`, matching `effectiveFacts.ts`.
- **Invoice lines** (`InvoiceSurface`) render straight from the extraction blob (`extraction.lineItems`/`line_items` → `buildInvoiceLedgerLineDisplay`) with **zero** provenance: no confirmation state, no correction indicator, no per-line derived markers. An operator confirming or correcting `line_items` — captured as a scalar array fact with real review/override — is invisible on the line table.
- **Additively-derived canonical fields** (`rate_code`, `rate_code_origin`, `line_code_resolution`, `canonical_category`) are computed in the **validator boundary** (`effectiveInvoiceLineCompletion.ts`), never in the Documents view model, and are **not queried back**. Documents' own `derived` state means something unrelated (no evidence anchor / adapter fallback / human rate-schedule). So the extracted-vs-system-derived distinction we built earlier has **no Documents surface today** and cannot be reliably reconstructed there.

**Bottom line:** the provenance *vocabulary and rendering pattern already exist and are good*. The bounded work is to (a) surface the existing `line_items` array-fact review/override state on `InvoiceSurface` using that same vocabulary, and (b) decide honestly about per-line derived provenance — which is genuinely unavailable and must **not** be fabricated in Documents. No new provenance model is needed.

## 2. How Documents obtains and renders facts (the path)

`buildDocumentIntelligenceViewModel` (`lib/documentIntelligenceViewModel.ts`) is built server-side (`app/platform/documents/[id]/page.tsx:1447`) and client-side (`lib/useForgeDocumentDetail.ts:217`). It assembles each scalar `DocumentFact` then layers provenance in a fixed order (`:5933-5951`):

1. **Base machine fact** — extracted value (`machineValue`/`machineDisplay`), `rawValue`/`rawDisplay`, `displaySource: 'auto'`, `reviewState: 'auto'` (or `'derived'` when no anchor exists / adapter fallback / human schedule — `:3851-3859, 4114, 4195`).
2. **`applyFactReviews`** (`:2949`) — `document_fact_reviews`: `confirmed` (attests; value stays machine), `corrected` + payload → `displaySource: 'human_corrected'`, `missing_confirmed`, `needs_followup`.
3. **`applyFactOverrides`** (`:3059`) — `document_fact_overrides`: `add` → `human_added`, `correct` → `human_corrected`, `reviewState: 'overridden'`. **Overrides applied last, so they win over reviews.**
4. **`applyPersistedFactAnchors`** — evidence geometry/anchors.

`FactLedger` (`components/document-intelligence/FactLedger.tsx`) renders `reviewState` (`:360`), `displaySource` (`:377`), `reviewStatus` (`:380-382`), and `Machine: {machineDisplay}` whenever `displaySource !== 'auto'` (`:403-404`) — i.e. the raw extracted value is preserved alongside a human correction. History arrays are present on the fact.

**Invoice lines take a different path.** `InvoiceSurface` (`components/document-intelligence/InvoiceSurface.tsx:96-112, 283-284`) reads `extraction.lineItems ?? line_items` from the presentational `InvoiceExtraction` blob and renders each via `invoiceSurfaceLineItemToLedgerRecord` → `buildInvoiceLedgerLineDisplay`. It receives no `DocumentFact` and surfaces no provenance.

## 3. Provenance semantics & precedence, from the existing model

| Concept | Existing representation | Effective value | Raw retained? |
|---|---|---|---|
| **Extracted** | `machineValue`/`machineDisplay`; `displaySource: 'auto'`; `reviewState: 'auto'` | machine | `rawValue`/`rawDisplay` |
| **Derived (Documents sense)** | `reviewState: 'derived'` + `derivationKind` (`human_schedule_control`, `adapter_value_fallback`, `decision_signal`, no-anchor) | machine/derived | yes |
| **Confirmed** | `reviewStatus: 'confirmed'`, `reviewState: 'reviewed'`; **value stays machine** (attestation, no replacement) | machine | n/a |
| **Corrected** | `reviewStatus: 'corrected'` (review+payload) **or** override `actionType: 'correct'` → `displaySource: 'human_corrected'`; `humanValue` replaces | human | `machineValue` shown as `Machine:` |
| **Added** | override `actionType: 'add'` → `displaySource: 'human_added'` | human | n/a (no machine value) |
| **Precedence** | `applyFactOverrides` after `applyFactReviews` → **override > review > machine/derived**; matches `effectiveFacts.ts` `human_override > human_review > … > legacy` | — | — |

**Design property to preserve (not a gap):** *confirmed* has no distinct display source and should not get one — a confirmation attests the machine value, it does not replace it. Introducing a `human_confirmed` display source would misrepresent a confirmation as a human-authored value.

## 4. What exists / reconstructable / genuinely unavailable

**Already exists and rendered (scalar facts):** state, source, review-status, machine-vs-human values with raw retention, review & override history, anchors, precedence. Nothing to build here.

**Exists but not surfaced (invoice lines):** the `line_items` array is captured as a scalar array fact and *does* receive `applyFactReviews`/`applyFactOverrides` (document-level: "line items confirmed/corrected by X at T"). This provenance is **reconstructable and available** — it is simply not passed to or rendered by `InvoiceSurface`.

**Genuinely unavailable to Documents (per-line derived canonical fields):** `rate_code`, `rate_code_origin` (`operator_asserted` / `source_asserted` / `system_derived` / `system_unresolved`), `line_code_resolution`, `canonical_category` are produced only inside the validator run (`effectiveInvoiceLineCompletion.ts`) and are **not** persisted back to a document-scoped read path. Documents cannot reliably reconstruct them without querying validator state. **Surfacing per-line "derived" provenance therefore requires a new read path — it must not be faked from the blob.**

## 5. Components & APIs affected

**Read/build:**
- `lib/documentIntelligenceViewModel.ts` — owns the provenance model; would pass `line_items` array-fact provenance into the invoice surface extraction (`toInvoiceSurfaceExtraction` path).
- `components/document-intelligence/InvoiceSurface.tsx` — the only surface with no provenance; primary UI target.
- `components/document-intelligence/FactLedger.tsx` — reference implementation of the provenance vocabulary to reuse (badges, `Machine:` retention).
- `lib/useForgeDocumentDetail.ts` / `app/platform/documents/[id]/page.tsx` — view-model entry points.
- `lib/invoices/invoiceParser.ts` (`buildInvoiceLedgerLineDisplay`, `invoiceSurfaceLineItemToLedgerRecord`) — line display builders.

**Write/provenance sources (unchanged by this work — read only):**
- `document_fact_reviews` (`lib/documentFactReviews.ts`, `POST /api/documents/[id]/facts/review`) — confirm/correct.
- `document_fact_overrides` (`lib/documentFactOverrides.ts`, `POST /api/documents/[id]/facts/override`) — add/correct.
- `document_fact_anchors` (`.../facts/anchor`) — evidence.

## 6. Recommended smallest UI model

**Principle (from the brief): no parallel truth, no new editable state, no speculative provenance.** Reuse the existing `DocumentFact` provenance vocabulary; surface only what is already captured; keep raw extraction reachable.

1. **Invoice-line document-level provenance (the core, fully available):** thread the `line_items` array-fact's `reviewState` / `reviewStatus` / `displaySource` / reviewer+timestamp into `InvoiceSurface` and render a single header chip using the **same** badges as `FactLedger` — e.g. "Line items · confirmed by A. Operator · 2026-05-28" or "corrected". When corrected via a payload, keep the extracted table reachable (a "view extracted" affordance) exactly as `FactLedger` shows `Machine:`. This reuses existing data end to end; no new model, no schema.
2. **Raw / historical access (preserve, don't duplicate):** ensure the existing raw extraction (`rawValue`/blob line items) and review/override history remain one click away from the invoice surface, so the effective view never hides what it superseded.
3. **Per-line derived canonical provenance (`rate_code_origin` etc.) — defer, do not fake.** This data is genuinely unavailable to Documents (§4). Recommend **not** rendering per-line derived badges until a document-scoped read path exposes the validator's completed line (a separate, larger change). Surfacing it from the blob would be speculative provenance and would risk a parallel-truth path — explicitly out of scope. Flag it as a tracked follow-up, not part of this phase.

This keeps the change bounded to "render provenance that already exists on the array fact, in the vocabulary that already exists," and refuses the one piece that would require inventing truth.

## 7. Falsification — the pattern already works

`FactLedger` is proof the provenance model is complete and legible: extracted vs corrected vs added vs confirmed are all distinguishable today, with raw values retained and history preserved, driven entirely by existing tables. Phase B is **extending that proven pattern to `InvoiceSurface`**, not designing provenance. The one genuinely missing capability (per-line derived canonical fields) is correctly identified as unavailable and deferred rather than fabricated.

---

*Inferred, not proven this session: that no current `InvoiceSurface` caller passes a `DocumentFact` for `line_items` (grep of the component found no provenance props); that the `line_items` array fact is not already rendered with provenance elsewhere in the invoice view. Confirm both at Phase B start before adding the header chip.*
