# Canonical Project Truth — Code Review of the Golden Shadow Slice

**Date:** 2026-08-01
**Reviews:** `docs/audits/canonical-project-truth-golden-shadow-2026-08-01.md`
**Mode:** read-first review, then contained surgical correction only. No new feature, no interpreter, no production wiring, no commit, no push.

---

## 1. Git state

Branch `main`, ahead of `origin/main` by four commits. HEAD `732139e feat(evaluation): add synthetic generalization harness and expand mutations`.

The canonical slice is entirely **untracked** (`?? lib/canonical/`), alongside a large pre-existing body of untracked phase3-step4 extraction/evaluation work and eleven modified extraction files. Nothing in this review was committed, staged, or pushed. The working tree at review time contained no canonical file in the staged index.

Because the whole slice is untracked, there is no meaningful `git diff` for it — the "diff" is the file set itself, reviewed in full below.

## 2. Diff reviewed

Read in full (production, non-test):

| File | Lines |
|---|---|
| `lib/canonical/truth/envelope.ts` | 481 |
| `lib/canonical/contract/pricing.ts` | 320 |
| `lib/canonical/contract/pricingAdapter.ts` | 315 |
| `lib/canonical/contract/pricingResolution.ts` | 471 |
| `lib/canonical/invoice/invoice.ts` | 38 |
| `lib/canonical/invoice/invoiceLine.ts` | 41 |
| `lib/canonical/invoice/invoiceAdapter.ts` | 259 |
| `lib/canonical/transaction/transaction.ts` | 45 |
| `lib/canonical/transaction/transactionAdapter.ts` | 261 |
| `lib/canonical/reconciliation/pricingMatch.ts` | 88 |
| `lib/canonical/reconciliation/invoiceTransaction.ts` | 32 |
| `lib/canonical/reconciliation/projectReconciliation.ts` | 46 |
| `lib/canonical/validation/factImpact.ts` | 52 |
| `lib/canonical/project/projectTruth.ts` | 52 |
| `lib/canonical/project/projectTruthBuilder.ts` | 38 |
| `lib/evaluation/canonicalProjectTruthShadowHarness.ts` | 82 |

Tests read in full: `canonicalProjectTruth.test.ts`, `goldenShadowChain.test.ts`, `canonicalProjectTruthShadowHarness.test.ts`, `canonicalPricingRealFixtureParity.test.ts`.

Dependencies traced: `lib/contracts/contractPricingAssembly.ts`, `lib/contracts/exhibitARateTableRows.ts`, `lib/contracts/contractRateScheduleRows.ts`, `lib/validator/billingKeys.ts`, `lib/validator/shared.ts`, `lib/validator/rulePacks/contractInvoiceReconciliation.ts`, `lib/validator/rulePacks/crossDocumentRateVerification.ts`.

**Independent execution performed for this review:** the real Golden contract PDF was run through the genuine production path (`extractDocument` → `runDocumentPipeline` → `assembleContractPricingRows`) via a temporary review-only test, and the raw + assembled rows for the $6.90 cell were dumped. That test was deleted after the trace. Results in §9.

## 3. Architecture compliance

Compliant on the load-bearing rules:

- **No parallel truth-state vocabulary.** `CanonicalTruthState` in `truth/envelope.ts` is the only definition; the architecture guard test (`canonicalProjectTruth.test.ts:242`) asserts no second `TruthState` type exists anywhere under `lib/canonical/**`.
- **No production reachability.** Nothing outside `lib/canonical/**` and `lib/evaluation/**` imports the slice. `lib/projectFacts.ts`, Validator rule packs, UI, and migrations are untouched.
- **No Project Facts import.** `transactionAdapter.ts` defines its own structural `PersistedCanonicalTransactionRowInput` rather than importing the Project Facts projection; the guard test enforces the absence of `@/lib/projectFacts` and `invoiceCanonicalNames`.
- **`sourceKind` is preserved but never authoritative inside `lib/canonical/**`.** `CanonicalPricingSourceFamily` carries `sourceKind`/`sourceQuality` verbatim; no resolution or approval predicate reads them. Verified by reading `pricingResolution.ts` in full — `classifyApprovalEligibility` and `resolveRowState` take no source-family input.
- **Adapters do not filter.** `adaptAssembledPricingRows` returns one candidate per input row; the real-fixture test asserts `canonicalCandidates === assemblerOutputs`.
- **The registry builder performs no interpretation.** `buildCanonicalProjectTruth` sorts and stamps `mode: 'shadow_only', persisted: false`. Nothing else.

One architecture note worth recording, not a defect in this slice: the **current production matcher does let source family determine authority.** `lib/validator/billingKeys.ts:750-765` (`selectOperationalCandidate`) breaks ties by `source_quality === 'clean'` and `source_kind === 'exhibit_a_table' | 'exhibit_a_text_recovery' | record_id.startsWith('exhibit_a_')`. The canonical model's invariant is therefore *stricter than the system it shadows*. That divergence must be surfaced explicitly at any future integration boundary rather than discovered then.

## 4. Provenance review

Strong overall. Specific verifications:

- `confidence` is `number | null` and never defaulted (`buildEnvelope` uses an explicit `?? null` with an inline comment forbidding `?? 0` / `?? 1`).
- `extractor` is read only from observed geometry metadata (`asCanonicalExtractor(geometry.source_type)`), never inferred from `sourceKind`.
- `CanonicalBoundingBox` refuses to assert `page_normalized` for legacy geometry and reports `complete` as derived rather than claimed.
- Upstream qualitative confidence (`'high'`/`'needs_review'`) is preserved as `extractionConfidenceLabel`, never numericized.
- `rawValues` retains the sentinel description (`'Raw row needs review'`) so the fact that the assembler saw unreadable content is not lost.
- `mapValidationFindingToCanonicalFacts` copies from the finding and mutates nothing; both tests prove deep equality of the finding before/after.

**Provenance losses found (all in `invoiceAdapter.ts`):**

| # | Finding | Location |
|---|---|---|
| P1 | `sourceRow` and `sourceSheet` are hardcoded `null` on every canonical invoice line, even when the current row carries `source_row_number` / `source_sheet_name`. | `invoiceAdapter.ts:165-166` |
| P2 | `matchingKeys.siteMaterialKey` and `matchingKeys.invoiceRateKey` are hardcoded `null`, discarding two of the four existing billing keys the row may carry. This is exactly the "preserve existing match inputs, do not re-derive" contract the type comment claims. | `invoiceAdapter.ts:172-177` |
| P3 | `sourcePage` on every line comes from a single caller-supplied `context.sourcePage`, so a multi-page invoice collapses all lines to one page. Caller-supplied, not fabricated, but it silently defeats per-line page evidence. | `invoiceAdapter.ts:167` |

P1 and P2 are corrected in §15. P3 is recorded as a boundary limitation because the fix requires a per-line page from upstream, which the `Record<string, unknown>` row does not guarantee.

## 5. Identity review

The identity model is sound in intent — source id first, deterministic `fallback:` prefix with `identityKind` and an explicit `identityWarning` otherwise, and array ordinal is never a primary id.

**One real defect: invoice-line identity can collide silently.**

- Source-backed path: `lineId = ${invoiceId}:line:${stablePart(evidence_refs[0])}` (`invoiceAdapter.ts:136-137`). When several lines share a first evidence anchor — routine when the anchor is table-level rather than row-level — every one of those lines receives the **same** `lineId` while still being labelled `identityKind: 'source'`.
- Fallback path: `fallback:invoice-line:${invoiceId}:${description}:${line_total}` (`invoiceAdapter.ts:138`). Two genuinely distinct billed lines with the same description and amount collide by construction.

The registry itself does not dedupe, so both rows survive in `invoiceLines`. But every downstream key — `CanonicalPricingMatch.invoiceLineId`, `CanonicalInvoiceTransactionReconciliation.invoiceLineIds`, `CanonicalFactReference.objectId` — becomes ambiguous, and any `Map` keyed by `lineId` collapses two billed lines into one. Under the EightForge grain rules this is the precise hazard the codebase forbids: duplicate physical rows must never silently merge, and conflicting repeated rows must fail loudly or emit a deterministic diagnostic. Corrected in §15.

Two lower-severity identity notes, recorded not changed:

- `projectTruthBuilder.ts` and the shadow harness sort with `localeCompare(..., 'en-US')`. ICU collation is not guaranteed stable across Node builds; codepoint ordering would be the deterministic choice for opaque ids. Not changed because it would shift asserted orderings across the existing suite and belongs in a dedicated determinism pass.
- `buildCanonicalPricingSchedule` takes the schedule's governing document from `rows[0]` — array-ordinal governance. Corrected in §15.

## 6. Sparse-envelope review

The decision — required core always enveloped, conditional fields omitted entirely when absent and named in `absentFields` — is the right one and is honestly implemented.

- Optional keys are conditionally spread (`...(x ? { k: x } : {})`), so `JSON.stringify` genuinely omits them. Proven by `canonicalProjectTruth.test.ts:105-114`, which asserts `'rateCode' in serialized === false` on real adapter output rather than on a hand-built object.
- Absence is not silent: `absentFields` names every omitted key, computed from the same `optionals` record that drives the spread, so the two cannot drift.
- Required core fields degrade to `absentFromSource` with a machine-readable `stateReason`, never to a fabricated value. `buildEnvelope` hard-throws if a `resolved`/`derived` state is handed a null, and throws if a non-value-bearing state is handed a value. The invariant is enforced at construction, not by convention.

Cosmetic only: `optionalEnvelope(...)` is evaluated twice per optional field in `invoiceAdapter.ts` (once for the ternary test, once for the value). Harmless and not changed — the transaction adapter already uses the cleaner precomputed-record form.

## 7. Approval-safety review

No false approval eligibility was found.

- `classifyApprovalEligibility` is a conjunction of explicit confirmations with `eligible: blockers.length === 0`. Default is ineligible; eligibility is earned.
- `authoredCorrection` is an unconditional blocker (`pricingResolution.ts:134`) and independently forces `requires_review` in `resolveRowState:437`. Successful extraction by an authored adapter confers nothing. Both properties are asserted on real adapter output in two separate tests.
- `unitSettled`/`rateSettled` mean *resolved or provably not applicable*. A merely-missing field is not settled and blocks. This is the correct reading of "where applicable".
- `requiresReview` and the conflict states may carry a provisional value, and `isValueBearingState` deliberately excludes them, so a provisional value can never be mistaken for canonical truth.
- Reconciliation conclusions are not stored as facts. `CanonicalInvoiceTransactionReconciliation`, `CanonicalContractInvoiceReconciliation`, and `CanonicalProjectReconciliation` all separate `facts` from `conclusion { state, reasons }`, and every one of them is nested under `CanonicalProjectTruth.derived`, never alongside the source-backed collections.
- `translateTransactionEligibility` returns `'unknown'` for anything unrecognised. Unknown never silently becomes `ineligible`. `eligibilityRaw` retains the source string.

One modelling conflation, flagged not changed: `CanonicalPricingResolution.unresolvedReasons` is assigned `approval.blockers` verbatim (`pricingResolution.ts:362`). These are not the same concept — a `non_pricing` row is not "unresolved", it is settled and excluded, yet it reports `no_pricing_content` as an unresolved reason. Changing this alters reported review semantics and the needs-review/excluded narrative in the counts, so it belongs in its own reviewed step, not here.

## 8. Golden-specific assumption scan

Clean. Verified by reading and by the executable guard (`canonicalProjectTruth.test.ts:241-249`), which greps every non-test file under `lib/canonical/**` for:

- `Aftermath Disaster Recovery` — absent;
- `TDOT` / `MDOT` / `Goodlettsville` — absent;
- a second `TruthState` definition — absent;
- imports of `invoiceCanonicalNames` or `@/lib/projectFacts` — absent.

I additionally confirmed by hand that no canonical file names a page number, a category list, a filename, a known rate, or a category count as a branch condition. The one string-literal predicate in the slice, `DEFAULT_UNRESOLVED_DESCRIPTION_SENTINELS = ['Raw row needs review']`, is a contract with the adapter's own immediate source, is overridable via context, and names no document family. That is acceptable.

Contrast worth recording: the *upstream* `lib/contracts/contractPricingAssembly.ts` is saturated with exactly the branching the canonical layer forbids — `categoryAllowsRouteDistance` gates on three literal category names (line 411-415); `recoverKnownExhibitADisplayCorrection` branches on `page === 8 && rate === 6.9`, `page === 11 && rate === 115 && anchor matches pdf:table:p11:t37:r5`, and roughly a dozen similar (category, page, rate) triples. The canonical boundary correctly refuses to inherit any of it. Any future interpreter must hold that same line.

## 9. Route / distance-band source trace — the exact Golden $6.90 row

This is the crux of the report's decision, so it was resolved by execution, not by reading.

### 9.1 Raw source row (production pipeline output)

```
row_id:            exhibit_a_table:pdf:table:p8:t26:r2:v1
page:              8
category:          Vegetative Collect, Remove & Haul
description:       "Vegetative Collect; Remove, & Haul -16 Miles from R OW a rors DMS uble Yard"
rate_raw:          "Vegetative Collect; Remove, & Haul -16 Miles from R OW a rors DMS uble Yard | $6.90"
raw_cells:         [ "Vegetative Collect; Remove, & Haul from Unincorporated Neighborhoods |",
                     "-16 Miles from R OW a rors BMS",
                     "uble Yard | $6.90" ]
source_anchor_ids: [ "pdf:table:p8:t26:r2", "pdf:table:p8:t26" ]
unit:              Cubic Yard
confidence:        needs_review
```

### 9.2 Assembled row (`ContractPricingAssemblyRow`)

```
id:                      exhibit_a_table:pdf:table:p8:t26:r2:v1
description:             "from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles"
route:                   null
distanceBand:            null
unit:                    Cubic Yard
rate:                    6.9
confidence:              low
sourceKind:              exhibit_a_table
sourceQuality:           clean
authoredValueCorrection: true
sourceAnchor:            pdf:table:p8:t26:r2
```

### 9.3 Diagnosis

The report's *factual* claim is confirmed: the real candidate carries `route = null` and `distanceBand = null`, and the canonical layer faithfully preserves that as `absent_from_source`. The canonical code is not at fault.

But the report's *conclusion* — that the source model is insufficient — is wrong, and the trace shows exactly why:

1. `assembleContractPricingRows` computes `route`/`distanceBand` **before** the authored correction, from the damaged OCR text: `contractPricingAssembly.ts:2021-2031` runs `detectRoute(routeSourceText)` and `detectDistance(routeSourceText)`.
2. On this row `detectRoute` fails because the OCR reads `"R OW a rors DMS"`, which does not satisfy `/\brow\s*(?:to|-|->)\s*dms\b/`. `detectDistance` fails because `"-16 Miles"` does not satisfy `/\b(0|16|31|60)\s*(?:-|to)\s*(15|16|30|60)\b/`.
3. `recoverKnownExhibitADisplayCorrection` then fires (`contractPricingAssembly.ts:1096-1104`) and restores the description to `"from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles"` — which **states both dimensions explicitly and verbatim**.
4. That correction returns `{ description, rate, unit }` and **no `route`**. Only `route` supplied by a correction is honoured (`if (correction?.route) route = correction.route;` at line 2048), and nothing re-runs `detectRoute`/`detectDistance` against the corrected description.

So the dimensions are lost not because the source lacks them, but because the correction path repairs the description and does not re-derive from it.

### 9.4 This is not a one-row artefact

The same signature appears on other rows in the same real run:

| Row | authoredValueCorrection | Corrected description | route | distanceBand |
|---|---|---|---|---|
| `pdf:table:p8:t26:r2` ($6.90) | true | `from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles` | null | null |
| `pdf:table:p8:t31:r1` ($3.25) | true | `DMS to Final Disposal 0 to 15 Miles` | null | null |
| `pdf:table:p8:t32:r1` ($5.40) | true | `DMS to Final Disposal 60+ Miles` | null | null |

Every authored-correction row on page 8 loses its dimensions; every non-corrected transport row keeps them (`p8:t26:r3` → `ROW to DMS` / `16 to 30 Miles`, `p8:t27:r1` → `ROW to DMS` / `31 to 60 Miles`, and so on). The correlation is exact and structural, not Golden-specific.

The converse also occurs and is instructive: `pdf:table:p8:t27:r2` has `description = 'Raw row needs review'` but `route = 'ROW to DMS'`, `distanceBand = '60+ Miles'`. Dimensions and description fail independently, so neither can substitute for the other and neither is the sole carrier.

### 9.5 Where the dimensions belong

Not (1) observed extraction facts — nothing in the document exposes route or band as typed cells; both are prose inside one description cell. Asserting them as observed would be false provenance.

Not (3) adapter-derived — the pure adapter is correct to refuse. It reads what it is handed and adds nothing.

Not (4) validation-only matching keys — `billingKeys.ts` already does this (§10) and it is precisely why the dimensions are invisible everywhere else. A dimension that exists only inside a scorer cannot be shown to an operator, cannot be reviewed, and cannot carry evidence.

Not (5) unresolved until user review — the authored text is unambiguous. Escalating an unambiguous parse to a human is a false blocker.

**(2) canonical derived facts is correct**, with one non-negotiable condition: the interpreter must be the *only* implementation, built by extracting the primitives that already exist (§10), and it must run against the **corrected** authored description, not the pre-correction raw text.

## 10. Existing parser inventory

Route and distance-band logic is already implemented **three times, in three incompatible vocabularies**.

| # | Location | Route output | Distance output | Notes |
|---|---|---|---|---|
| 1 | `lib/contracts/contractPricingAssembly.ts:457-484` — `detectRoute` / `detectDistance` | `'ROW to DMS'`, `'DMS to FDS'`, `'DMS to Final Disposal'`, `'ROW to Final Disposal'`, `'Any Distance'` | `'0 to 15 Miles'`, `'16 to 30 Miles'`, `'31 to 60 Miles'`, `'60+ Miles'`, `'Any Distance'` | The richest. Uniquely returns `ocrAmbiguous: true` for the `0–16` OCR corruption of `0–15`. Gated by `categoryAllowsRouteDistance` (three literal category names). |
| 2 | `lib/contracts/exhibitARateTableRows.ts:274-278` — `normalizeDistance`, plus inline route reconstruction at 291-308 and OCR repairs at 59-62 (`ROWtoDMS`, `ROW t6 DMS`, `ROW 10 DMS`, `Milas`) | reconstructed inline into description strings | same five labels, **different regexes** — e.g. accepts `81 to 60` as `31 to 60 Miles`, accepts `0 to 16` with no ambiguity flag | Emits prose, not fields. Its OCR-variant repairs are strictly better than #1's and exist nowhere else. |
| 3 | `lib/validator/billingKeys.ts:552-575` — `detectRoute` / `detectDistanceBand` / `distanceBandsOverlap` | `'row_to_dms'` — **a third vocabulary**, snake_case, single value only | `{ start: number, end: number }` — a numeric interval, not a label | Consumed only inside `operationalDescriptionScore` as a `+0.05` scoring nudge. Never surfaced, never persisted, never evidenced. |

Additional related duplication: `contractRateScheduleRows.ts` carries hardcoded `originDestination: 'ROW to DMS'` seed rows (lines 71, 76) and literal recovered descriptions containing `from Rural Areas ROW to DMS 0 to 15 Miles` (lines 196, 211, 226) — a fourth, static encoding of the same dimensions.

**Recommendation (do not implement in this review):** extract one generic primitive from #1, since it is the only implementation that models OCR ambiguity, and give it the OCR-variant repair table from #2. It should be source-neutral — no category gate, no page, no rate, no document family — and expose:

```
parseTransportDimensions(text: string): {
  route: { value: string | null; ambiguous: boolean; span: string | null };
  distanceBand: { value: string | null; ambiguous: boolean; span: string | null };
}
```

`categoryAllowsRouteDistance` becomes the *caller's* applicability gate, not part of the primitive. #2 and #3 then become callers, and the three vocabularies collapse to one. This is a prerequisite for the interpreter, not a follow-on.

## 11. Canonical interpretation-layer recommendation

The proposed pipeline —

```
ContractPricingAssemblyRow
  → CanonicalPricingCandidate
  → CanonicalPricingDimensionInterpreter
  → CanonicalContractPricingRow
```

— is a **valid canonical interpretation layer, not a second extraction path**, provided all of the following hold. Each is a hard condition, and the trace in §9 shows why.

1. **Input is authored canonical text only.** It reads `candidate.description` and `candidate.rawValues.description`. It must **not** read `rawValues.rawText` or `rawCells` — those are the damaged OCR strings that already defeated `detectRoute` upstream, and parsing them would be a genuine second extraction path. This is the single most important boundary.
2. **It never overwrites an observed value.** If `candidate.route != null`, the interpreter yields and the envelope stays `resolved`. It fills only `absent_from_source` slots.
3. **State is `derived`, never `resolved`.** `derivedValue()` already requires a `CanonicalDerivationRef { ruleId, ruleVersion, inputs }` at construction, so the rule and version cannot be omitted. The `inputs` array must cite the description fact as a `deterministic_derivation` dependency.
4. **Evidence is the exact span, on the description's own evidence ref.** `CanonicalEvidenceRef.rawSpan` must carry the matched substring (`"ROW to DMS"`, `"0 to 15 Miles"`), not the whole description. `derived` values must remain locatable, or `classifyEvidenceCompleteness` will silently mark the row backed on evidence that does not point at the parsed text.
5. **Ambiguity returns unresolved, not a guess.** The `ocrAmbiguous` flag from primitive #1 must map to `requiresReview` with a provisional value, never to `derived`.
6. **Zero document-family logic.** No filename, page, known rate, category count, or fixture literal. The category applicability gate is the caller's, supplied as context.
7. **It reuses the §10 primitive.** Writing a fourth regex set is an automatic reject.

Two consequences that must be decided explicitly, not discovered:

- **Approval eligibility is unaffected.** `derived` is a value-bearing state, so a derived route would make `route` settled — but `route` is not in `CANONICAL_PRICING_CORE_FIELDS` and is not an approval input. The $6.90 row stays ineligible on `authored_value_correction` regardless. That is correct and must stay correct: deriving a dimension from an authored correction must never soften the authored-correction blocker.
- **The interpreter's output is a canonical fact, not a matching key.** It belongs in the row and in evidence. It must not be quietly wired into `billingKeys.ts` scoring in the same slice, or the candidate/selected conflict in §12 will silently shift and the current finding will move.

## 12. Candidate versus selected governing truth

The report's claim of a conflicting truth path is confirmed and can now be cited exactly.

`lib/validator/billingKeys.ts:811-867` — `matchRateScheduleItemForInvoiceLine` returns a well-formed five-field result: `{ candidates, match, candidate_count, ambiguous, match_reason }`. The distinction exists **at the source**. It is the consumers that collapse it, in opposite directions:

| Consumer | Reads | Effective semantics |
|---|---|---|
| `rulePacks/contractInvoiceReconciliation.ts:1049-1056` | `candidates` only | `matchedInvoiceLines += 1` when `candidates.length > 0`. `match` is destructured and then **never used** for the matched/unmatched tally. **Candidate presence = matched.** |
| `rulePacks/contractInvoiceReconciliation.ts:1060-1063` | `candidates` only | `FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT` fires only when `candidates.length === 0`. |
| `rulePacks/crossDocumentRateVerification.ts:857-870` | `.match` only | `contract_rate_found: contractItem != null`. `candidates`, `candidate_count`, and `ambiguous` are discarded entirely. **Selected match required.** |
| Exposure | consumes cross-document units | inherits the selected-match semantics |
| Project Facts | independent projection | derives its own summaries; not aligned with either |
| `lib/canonical/reconciliation/pricingMatch.ts` | both, separately | `candidatePricingRowIds` and `selectedPricingRowId` are distinct fields — **the only place in the codebase that models both** |

For the Golden $6.90 line this produces two opposite conclusions from one matcher call: contract→invoice reconciliation counts the line **matched** (candidates exist), while cross-document rate verification reports **no governing rate** (no selected match, or a selected row that is approval-ineligible). Neither path consults approval eligibility or `authoredValueCorrection` on the selected row at all.

The new canonical representation is therefore the *correct* model and is the right place to define universal semantics.

### Proposed universal semantics

| Field | Type | Meaning | Rule |
|---|---|---|---|
| `candidate_present` | `boolean` | at least one schedule row survived key/scoring lookup | `candidate_count > 0`. **Never means "matched".** |
| `candidate_count` | `number` | size of the surviving candidate set | verbatim from the matcher |
| `selected_governing_row_id` | `string \| null` | the one row selected to govern | null whenever selection did not converge |
| `selection_status` | `'selected' \| 'ambiguous' \| 'rejected_on_fit' \| 'no_candidates'` | why selection did or did not converge | `rejected_on_fit` covers `matchRateScheduleItemForInvoiceLine`'s early return where candidates exist but fail `exactDescriptionCandidateStillFitsInvoiceLine` — today indistinguishable from `no_candidates` downstream |
| `approval_eligible` | `boolean` | the selected row may govern an approval | `selection_status === 'selected' && selectedRow.resolution.approval.eligible`. **Independent of `selection_status` alone.** |
| `unresolved_reason` | `string \| null` | machine code, null iff `approval_eligible` | e.g. `authored_value_correction`, `multiple_equally_plausible_candidates`, `selected_row_not_approval_eligible` |
| `expected_rate_available` | `boolean` | a comparable expected rate exists | `selectedRow.rate` is value-bearing. **Distinct from `approval_eligible`** — a rate can be readable and still not approvable |

The load-bearing rule: **`candidate_present`, `selection_status === 'selected'`, `approval_eligible`, and `expected_rate_available` are four independent booleans.** Every current bug in this area comes from a consumer treating two of them as one.

### The Golden $6.90 case, unchanged

```
candidate_present:         true
candidate_count:           1          (exhibit_a_table:pdf:table:p8:t26:r2:v1)
selected_governing_row_id: null
selection_status:          rejected_on_fit
approval_eligible:         false
unresolved_reason:         authored_value_correction
expected_rate_available:   true       (rate 6.90 is readable and correct)
```

Existing finding `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` remains **open / blocked**, `affected_amount` remains exactly `302,868.60`, `approval_gate_effect` remains `blocks_approval`. Nothing moves. What changes is only that the finding becomes *explainable*: the rate was found and is correct, but the row that carries it was authored rather than source-verified. That is a strictly better operator message with an identical outcome.

This is exactly how the slice already represents it — `CanonicalPricingMatch.status = 'governing_rate_requires_review'`, `selectedPricingRowId = null`, `candidatePricingRowIds = [row]`, `sourceMatchStatus = 'unmatched'` preserved verbatim.

## 13. Model-duplication findings

| Canonical object | Verdict | Basis |
|---|---|---|
| `TruthEnvelope<T>` + `CanonicalTruthState` | **necessary boundary** | Sole truth-state vocabulary. The deliberate exclusion of a broad `missing` state, with the three-way `absent_from_source` / `not_applicable` / `unresolved_mapping` split, is the single most valuable thing in the slice. Keep as is. |
| `CanonicalEvidenceRef` / `CanonicalBoundingBox` | **necessary boundary** | Deliberately not `lib/extraction/domain/types.ts#BoundingBox`, because that type demands `coordinate_space` and rotation the legacy geometry cannot prove. Duplication here prevents a provenance lie. |
| `CanonicalContractPricingCandidate` / `...Row` | **necessary boundary** | The candidate/row split is what guarantees no silent row loss. No existing type provides it. |
| `CanonicalInvoice` | **should wrap an existing type later** | Two `InvoiceExtraction` definitions already exist (`lib/types/extractionSchemas.ts:77`, `lib/types/documentIntelligence.ts:304`). The canonical model is a third *shape* but the first *with field-level truth*. Justified now; must be declared the wrapper, not a peer, before integration. |
| `CanonicalInvoiceLine` | **needs revision before integration** | Justified as a boundary, but the identity collision (§5) makes it unsafe as a keying target today. Corrected in §15. |
| `CanonicalTransaction` | **necessary boundary** | Deliberately structural rather than importing the Project Facts projection, which injects synthetic defaults. Correct call. |
| `PersistedCanonicalTransactionRowInput` | **necessary boundary** | Thin structural input that keeps `lib/canonical` free of `lib/projectFacts`. |
| `CanonicalPricingMatch` | **should replace existing private projections later** | The only model in the repo carrying candidate *and* selected separately (§12). This is the intended consolidation target for the three private `CanonicalInvoiceLine` shapes in the rule packs. |
| `CanonicalPricingMatchingKeys` | **needs revision** | Declares `originDestinationMatch` and `distanceBandMatch` as first-class comparison outputs while nothing in the slice can populate them — the interpreter of §11 is their only possible producer. They are currently write-only placeholders. Acceptable as forward declaration only if §11 lands; otherwise remove. |
| `CanonicalInvoiceTransactionReconciliation`, `CanonicalContractInvoiceReconciliation`, `CanonicalProjectReconciliation` | **necessary boundary** | The facts/conclusion split is the correction to the current system's habit of storing conclusions as facts. |
| `CanonicalValidationFactImpact` | **necessary boundary** | Maps unchanged findings onto canonical object/field paths. Adds no vocabulary. |
| `CanonicalProjectTruth` + builder | **necessary boundary** | The `derived` nesting is the structural guarantee that reconciliation output never becomes an independent record of truth. |
| `CanonicalShadowParityClassification` (harness) | **duplicates nothing, but proves nothing** | See §14. |

No consolidation performed, per instruction.

## 14. Test-quality findings

95 tests pass across `lib/canonical/**` plus the two evaluation harness suites (the report's "87" appears to be a narrower selection; the discrepancy is in the counting, not the outcome).

**Genuinely good — these test production behaviour:**

- Sparse serialization (`canonicalProjectTruth.test.ts:105-114`) round-trips **real adapter output** through `JSON.stringify` and asserts key absence. Not a hand-built object.
- Missing-value discipline (`:90-103`, `:136-149`) drives real adapters with null inputs and asserts `absent_from_source` / `requires_review` / `undefined`, and asserts `translateTransactionEligibility('unrecognized status') === 'unknown'`.
- Authored-correction blocking (`:178-183`) runs the real `adaptAssembledPricingRow → resolveCanonicalPricingRow` chain.
- Finding immutability (`:185-198`, `goldenShadowChain.test.ts:241`) uses `structuredClone` + `deepEqual` before/after. This is the right shape for the "findings remain unchanged" invariant.
- Deterministic registry ordering (`:200-230`) feeds out-of-order real adapter output and asserts sorted ids.
- The architecture guard (`:241-249`) reads production files from disk and greps them. An executable invariant rather than a comment. Excellent.
- `canonicalPricingRealFixtureParity.test.ts` is the strongest test in the slice: it runs the genuine `extractDocument → runDocumentPipeline` path, asserts `canonicalCandidates === assemblerOutputs`, asserts coverage reconciliation, and asserts the rejection ledger accounts for every input row exactly once. It also skips loudly with an explicit message when the corpus is absent, so a missing fixture can never read as green.

**Flagged — tests that prove fixtures rather than production behaviour:**

| # | Test | Problem |
|---|---|---|
| T1 | `goldenShadowChain.test.ts` — the entire "Golden" chain | The contract row is a **hand-authored `ContractPricingAssemblyRow` literal** (`:35-52`) with `route: null, distanceBand: null` written in by hand, and the transactions, invoice row, match, reconciliation, and exposure are all hand-built objects. The test asserts `pricing.route.state === 'absent_from_source'` — which is guaranteed by the fixture, not discovered from the document. The file is named for the Golden project and its constants claim its values are Golden's, but **no Golden artefact is read**. This is the test that most needs its name and its docblock corrected: it is an adapter-composition test, not a Golden trace. |
| T2 | `goldenShadowChain.test.ts:26-27` — `GOLDEN.route` / `GOLDEN.distanceBand` | Declared and **never asserted**. Dead fixture literals that encode an expected interpretation the test does not test. |
| T3 | `canonicalPricingRealFixtureParity.test.ts:186-187` | `route` and `distanceBand` are **logged but never asserted**. The report's central factual claim ("the real candidate has route=null") rests entirely on reading console output. Under §9 that claim is true, but it is not defended by any assertion and will not fail if it changes. |
| T4 | `canonicalProjectTruthShadowHarness.test.ts` (all three tests) | The harness is a pure classifier over caller-asserted booleans (`requiresReview`, `conflictingCurrentTruthPath`, `currentSourceAvailable`). Its tests exercise the if/else ladder in `compareCanonicalShadowBoundary` with hand-supplied flags. **The parity matrix in report §15 is therefore authored, not measured** — the harness contains no capability to observe either system. It is a labelling calculator presented as a comparison. |
| T5 | Candidate-vs-selected coverage | `canonicalProjectTruth.test.ts:170-175` asserts `ambiguous.selectedPricingRowId === null`, but nothing asserts the four-way independence of §12 (candidate present + no selection + rate available + not approval-eligible). The exact Golden semantics are represented in `goldenShadowChain.test.ts` but only against hand-built input. |
| T6 | Identity-collision coverage | No test drives two invoice lines sharing an evidence anchor, or two identical description/amount lines. The defect in §5 is entirely uncovered. Addressed in §15. |

Nothing in the slice asserts a hand-built object *while claiming* to prove a production source path except T1, which is the significant one because it carries the "Golden" name and underwrites the report's §14 trace table.

## 15. Required surgical corrections

Applied in this review. Contained, no new capability, no interpreter, no production wiring.

**C1 — invoice-line identity collision (`lib/canonical/invoice/invoiceAdapter.ts`)**
Batch-level collision detection added. When two lines in the same invoice derive the same `lineId`, the id is deterministically disambiguated by input ordinal, `identityKind` is downgraded to `deterministic_fallback`, and an explicit `identityWarning` (`line_id_collision_disambiguated_by_ordinal`) is set. Colliding lines can no longer be silently merged by any downstream `Map`, and the disambiguation announces itself rather than hiding. Applies to both `adaptInvoiceExtraction` and `adaptCurrentInvoiceRows`.

**C2 — invoice-line source coordinate preservation (`invoiceAdapter.ts`)**
`adaptCurrentInvoiceRows` now reads `source_row_number`, `source_sheet_name`, and `source_page` from the current row when present, instead of hardcoding `null`. Absent keys still yield `null`. No value is invented.

**C3 — invoice-line matching-key preservation (`invoiceAdapter.ts`)**
`siteMaterialKey` and `invoiceRateKey` are now read from the source (`site_material_key`, `invoice_rate_key`) instead of hardcoded `null`. They are read, never derived — `lib/validator/billingKeys.ts` remains the sole producer.

**C4 — schedule governing document is no longer array-ordinal (`lib/canonical/contract/pricingResolution.ts`)**
`buildCanonicalPricingSchedule` previously took `rows[0]?.governingDocument`, silently letting input order decide schedule governance. It now requires unanimity across rows: a single distinct governing document id wins; disagreement (or none) yields `null`. Governance is a truth decision and must not be decided by array position.

**C5 — test coverage for C1–C3**
Added to `lib/canonical/project/canonicalProjectTruth.test.ts`: two lines sharing an evidence anchor produce distinct ids with an explicit warning; two identical description/amount lines do not collide; source coordinates and all four matching keys survive `adaptCurrentInvoiceRows`.

**Gates run after applying C1–C5:**

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx eslint lib/canonical --max-warnings=0` | passed |
| `npx vitest run lib/canonical lib/evaluation/canonicalProjectTruthShadowHarness.test.ts lib/evaluation/canonicalPricingBoundaryHarness.test.ts` | 8 files / **99 passed** (95 before, +4 new) |
| `npx vitest run lib/validator lib/contracts` | 46 files / **596 passed** — no production regression |
| `npm run build` | passed |

`lib/canonical/**` remains unreachable from production, so the Validator/contracts run confirms the corrections moved nothing outside the shadow slice. Nothing was committed or pushed.

**Not applied — recorded for a later reviewed step:**

- `resolution.unresolvedReasons` aliasing `approval.blockers` (§7). Changing it alters reported review semantics.
- `localeCompare('en-US')` ordering of opaque ids (§5). Belongs in a determinism pass.
- `translateTransactionEligibility` mapping `'approved'`/`'supported'` → `'eligible'` (§7). A semantic assertion about upstream vocabularies that should be evidenced, not guessed at, before change.
- Renaming/redocumenting `goldenShadowChain.test.ts` and asserting route/band in the real-fixture test (T1, T3). Test-narrative corrections that belong with the interpreter slice, where the assertions become meaningful.

## 16. Final decision

# READY FOR A CONTAINED INTERPRETATION SLICE

**Not `BLOCKED BY CURRENT SOURCE MODEL`.** The report reached that verdict from a true observation and a false inference. The observation — the real candidate carries `route = null`, `distanceBand = null` — is confirmed by execution. The inference — that the authored source is insufficient to determine the dimensions without guessing — is refuted by the same execution:

- The authored corrected description is `"from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles"`. Both dimensions are stated verbatim. No guessing is required.
- The repository already contains a route/distance parser that handles exactly this text, plus two more (§10).
- The nulls are a **correction-ordering defect** in `contractPricingAssembly.ts`, not a source deficiency: dimensions are derived from the damaged pre-correction text and are never re-derived after the description is repaired. Three page-8 rows in the real run show the same signature, and every non-corrected transport row keeps its dimensions.

**Not `REVISE CANONICAL IMPLEMENTATION`** as a gate. The canonical implementation is architecturally sound: one truth-state vocabulary, envelope invariants enforced at construction, no fabricated confidence, no synthetic provenance, no source-family authority, no Golden branching, reconciliation conclusions structurally separated from facts, authored corrections as unconditional approval blockers, honest sparse serialization, and an executable architecture guard. The defects found — one identity collision, two provenance losses, one array-ordinal governance leak — are contained, and all four are corrected in §15 rather than deferred.

**Not `REJECT`.** No competing truth system is created, no provenance is lost that was not corrected, and no finding changes. `CanonicalPricingMatch` is the first model in the repository that represents candidate and selected governing truth as distinct facts, which makes it the fix for the §12 conflict rather than another instance of it.

The gate is therefore open, with one hard precondition: **the interpretation slice must begin by consolidating the three existing route/distance parsers into one source-neutral primitive.** Building a fourth implementation — even a well-behaved canonical one — would convert the correct decision into the wrong one.

## 17. Exact next Codex implementation boundary

Three steps, in order, each its own commit, each reviewed before the next.

### Step 1 — extract the shared transport-dimension primitive (no behaviour change)

**Touch:** new `lib/contracts/transportDimensions.ts`; `lib/contracts/contractPricingAssembly.ts`; `lib/contracts/exhibitARateTableRows.ts`.

Move `detectRoute` / `detectDistance` out of `contractPricingAssembly.ts` into a source-neutral primitive, folding in the OCR-variant repairs from `exhibitARateTableRows.ts:59-62` (`ROWtoDMS`, `ROW t6 DMS`, `ROW 10 DMS`, `Milas`). Return value and matched span per dimension, plus the existing `ocrAmbiguous` flag. **No category gate inside the primitive** — `categoryAllowsRouteDistance` stays at the call site.

Make both existing callers use it. `lib/validator/billingKeys.ts` is **out of scope for this step** — changing its scorer moves matcher output and therefore findings.

**Gate:** the full `lib/contracts` suite unchanged, and the real-fixture run reproduces the exact current counts (105 rate schedule rows, 90 assembler rows, 56 resolved, 34 needs review, 0 excluded, 15 merged, 0 lost) with byte-identical `route`/`distanceBand` on every row. This step must be provably inert.

### Step 2 — the canonical dimension interpreter (shadow only)

**Touch:** new `lib/canonical/contract/pricingDimensionInterpreter.ts`; wired only into `resolveCanonicalPricingRow` behind an explicit opt-in context flag; tests.

Implement §11 conditions 1–7 exactly. Reads `candidate.description` and `rawValues.description` **only** — never `rawText`, never `rawCells`. Emits `derivedValue()` with `ruleId: 'canonical_transport_dimension_interpreter'`, an explicit `ruleVersion`, and an `inputs` dependency citing the description. Evidence carries the **matched span**, not the whole description. Never overwrites a non-null observed dimension. `ocrAmbiguous` maps to `requiresReview` with a provisional value, never `derived`.

**Gate — all must hold:**
- The $6.90 row (`exhibit_a_table:pdf:table:p8:t26:r2:v1`) yields `route.state === 'derived'`, `route.value === 'ROW to DMS'`, `distanceBand.value === '0 to 15 Miles'`, each with a `rawSpan` equal to the matched substring and a populated `derivation`.
- The same row's `resolution.approval.eligible` stays `false` with `authored_value_correction` still in `blockers`. Deriving a dimension must not soften an authored-correction block.
- Rows with observed dimensions (`p8:t26:r3` → `ROW to DMS` / `16 to 30 Miles`) stay `resolved`, not `derived`.
- Schedule coverage counts and display-group counts are unchanged.
- No production consumer reads the interpreter. Validator, Project Facts, exposure, and UI untouched. Findings byte-identical.

### Step 3 — candidate-versus-selected semantics (representation only)

**Touch:** `lib/canonical/reconciliation/pricingMatch.ts`; tests. **No rule pack, no exposure, no Validator.**

Add the seven fields of §12 to `CanonicalPricingMatch` and represent the current matcher's output through them, including the `rejected_on_fit` case that `matchRateScheduleItemForInvoiceLine`'s early return currently makes indistinguishable from `no_candidates`. Assert the four-way independence explicitly, and assert the Golden $6.90 representation of §12 with the finding unchanged.

Reconciling `contractInvoiceReconciliation.ts` and `crossDocumentRateVerification.ts` onto these semantics is a **separate, separately-reviewed change** — it moves production findings and must not ride along with a representation step.

### Explicitly out of scope for all three steps

UI, Validator rules or generation, Project Facts, extraction, persistence, migrations, `billingKeys.ts` scoring, production reader cutover, and any commit or push.

---

# Addendum — Verification of the Pricing-Dimension Interpretation Slice

**Date:** 2026-08-01
**Reviews:** `docs/audits/canonical-pricing-dimension-interpretation-2026-08-01.md`
**Question asked:** is the parser consolidation genuinely source-neutral, and did any production reconciliation result change accidentally?

## A. Source-neutrality of `lib/contracts/pricingDimensions.ts` — verified

Verified by reading all 277 lines and re-running the canonical architecture guard.

Clean: no filename, page number, rate value, category name, fixture id, document family, or `sourceKind` appears in the parser. Route kinds are a typed enum, display labels are a separate function from semantics, `confidence` is `null`, and ambiguity is modelled rather than guessed. `categoryAllowsRouteDistance` correctly stayed at the *call site* in the assembler instead of migrating into the primitive.

Caveats:

1. **Domain vocabulary is hardcoded** (`ROW`, `DMS`, `FDS`, `final disposal`). This is domain-specific, not source-specific — it is uniform across Golden/TDOT/MDOT/Goodlettsville — so source-neutrality holds. It should still be named a *debris-domain* primitive rather than a universal one.
2. **The parser sits outside the guard.** `canonicalProjectTruth.test.ts` scans only `lib/canonical/**`. `lib/contracts/pricingDimensions.ts` is now a load-bearing interpretation primitive with no equivalent executable no-fixture-branching guard.
3. **Scope expansion beyond consolidation.** In `contractPricingAssembly.ts`, `explicitOriginDestination` now takes precedence for **every** source kind and bypasses `categoryAllowsRouteDistance`; previously it was read only for `tdot_appendix_b_stitched_table`. TDOT route values are also now normalized through `pricingRouteDisplayLabel` rather than passed through verbatim.

## B. Production reconciliation results — two undeclared changes

### B1. The Golden canonical ledger moved

Measured by executing the real production path (`extractDocument → runDocumentPipeline → assembleContractPricingRows`) on the Golden contract, sha256 `922161a5…`, and diffing against the trace captured **before** these changes during the primary review.

| Metric | Before | After | Δ |
|---|---|---|---|
| rate-schedule rows (pipeline input) | 105 | 104 | −1 |
| assembler outputs / candidates | 90 | 90 | — |
| merged or deduped | 15 | 14 | −1 |
| **resolved / approval-eligible** | **56** | **58** | **+2** |
| **needs review / ineligible** | **34** | **32** | **−2** |
| excluded | 0 | 0 | — |
| silently lost | 0 | 0 | — |

Goodlettsville (5/5/0), TDOT (32/25/7), and MDOT (5/3/2) all reconcile with zero silent loss.

### B2. Two rows silently became approval-eligible

The row-level diff of the executed Golden assembly showed **five** changed rows. Three are the intended fix (`$6.90`, `$3.25`, `$5.40` gain route/distance and correctly remain approval-ineligible on `authored_value_correction`). **Two are undeclared:**

| Row | Field | Before | After |
|---|---|---|---|
| `pdf:table:p8:t27:r2` (Vegetative, $10.90) | description | `Raw row needs review` | `from Unincorporated Neighborhood ROW to DMS 60+ Miles` |
| | sourceQuality | `partial` | `clean` |
| `pdf:table:p8:t30:r6` (C&D, $10.90) | description | `Raw row needs review` | `from ROW to DMS 60+ Miles` |
| | sourceQuality | `partial` | `clean` |

Canonical resolution of both rows is now:

```
group: resolved_pricing   state: resolved   eligible: true   blockers: []
```

`Raw row needs review` is `DEFAULT_UNRESOLVED_DESCRIPTION_SENTINELS`, which the canonical adapter maps to `description = null → absent_from_source → not settled → requires_review → approval ineligible`. Replacing it with real text moves both rows into the authoritative `resolved_pricing` group with **zero blockers**. Neither row carries `authoredValueCorrection`, so nothing else gates them.

**Mechanism.** The old distance regexes ended in `\b` after `+` (`/\b60\s*\+\b/` in `exhibitARateTableRows.normalizeDistance`). Because `+` and the following space are both non-word characters, that `\b` could never match, so `60+ Miles` and `60+ Milgs` returned `null` and both rows fell through to the damaged-description sentinel. The consolidated parser uses `(?!\w)` instead, which matches. Fixing that latent boundary bug is correct in isolation; its side effect is that two rows the system previously routed to human review are now approval-eligible without review.

This contradicts the slice report: line 108 states "approval outcomes … are unchanged", while line 73 records the new `58 resolved, 32 needs review` ledger without identifying it as a delta from the prior slice's documented `56 / 34`.

### B3. `billingKeys` scorer trigger conditions changed in both directions

`lib/validator/billingKeys.ts` was explicitly out of scope for the consolidation step, because `detectRoute`/`detectDistanceBand` feed `operationalDescriptionScore`'s ±0.05 bonuses, which feed `findOperationalRateScheduleCandidatesForInvoiceLine` → `matchRateScheduleItemForInvoiceLine` → cross-document rate verification → **findings**. It was changed anyway.

A differential over 39 real strings — Golden assembled descriptions, real pre-correction OCR from the executed pipeline, and blobs shaped like `candidateSearchText()` output — found **3 route disagreements and 7 distance disagreements**.

Signal newly lost (old produced a bonus, new returns `null`):

- `ROW to DMS 31 to 60 Miles DMS to FDS 16 to 30 Miles` → route **and** distance both lost (multiple kinds ⇒ ambiguous ⇒ null; old took the first/last match)
- `from ROW to DMS 0 to 15 Miles from ROW to DMS 16 to 30 Miles` → distance lost
- the real Golden text-recovery blob (`…31-60 Miles frorh ROW to DMS … 60+ Miles from ROW to DMS … from Rural Areas`) → distance lost
- `C&D haul DMS to ROW 0 to 15 Miles` and `Debris hauled from ROW, staged, then delivered to DMS` → route lost

Signal newly gained:

- **`Vegetative Collect; Remove, & Haul -16 Miles from R OW a rors DMS uble Yard | $6.90`** — the exact real OCR of the Golden `$6.90` row — old: `null`; new: `{start: 16, end: 16}` from the exact-miles fallback. `-16 Miles` is a truncated `0-16 Miles`, so this is a fabricated exact band, and `distanceBandsOverlap` will now award `+0.05` against any contract row whose band touches 16 (including `16 to 30 Miles`) — a new false-positive matching signal on the very row under review.

Genuine improvements (old was garbage): `invoice 2026-002…` → `{2, 2026}` now `null`; OCR junk `176-30` → `{30, 176}` now `null`.

Because the bonuses are ±0.05 against `MIN_OPERATIONAL_DESCRIPTION_SCORE = 0.45`, `MIN_NEEDS_REVIEW_DESCRIPTION_SCORE = 0.75`, and `AMBIGUOUS_SCORE_TOLERANCE = 0.0001`, any of these can cross a threshold or flip an ambiguity tie. `npx vitest run lib/validator lib/contracts` passing 620/620 establishes that **no existing test covers these trigger conditions** — not that behaviour is preserved.

## C. Gates re-run independently

| Gate | Result |
|---|---|
| `npx vitest run lib/validator lib/contracts` | 47 files / 620 passed |
| `npx vitest run lib/evaluation/canonicalPricingRealFixtureParity` | 4 passed; all four fixtures reconcile, zero silent loss |
| Golden real-pipeline row diff vs pre-change baseline | 5 rows changed (3 intended, 2 undeclared) |
| `billingKeys` old-vs-new differential, 39 real strings | 3 route + 7 distance disagreements |

## D. Verdict

**Source-neutrality: verified.** The primitive is genuinely free of fixture and document-family identity, and the category gate stayed at the call site.

**"No production reconciliation result changed": refuted.** The consolidation is not inert. Two Golden rows moved from human review into approval-eligible resolved pricing, the ledger moved `56/34 → 58/32`, and the `billingKeys` matcher's bonus trigger set changed in both directions — including one fabricated band on the row under review.

### Required before this slice is accepted

1. **Decide the two `$10.90` rows explicitly.** Either accept the recovery and document the `56 → 58` approval-eligibility delta as intended, with the evidence for both descriptions, or gate the `(?!\w)` boundary fix so a previously-sentinel row cannot reach `eligible: true` without review. A row leaving human review must be a decision, not a side effect.
2. **Revert `billingKeys.ts` to its pre-change implementation**, or land it as its own separately-audited change with the differential harness pinned as a regression test. It is the only edited file that can move production findings.
3. **Correct report line 108.** "Approval outcomes unchanged" is false as written, and the ledger on line 73 must be labelled as a delta against the prior slice's `105 / 15 / 56 / 34`.
4. **Add a no-fixture-branching guard over `lib/contracts/pricingDimensions.ts`**, mirroring the existing `lib/canonical/**` guard.
5. **Justify or revert the `explicitOriginDestination` precedence expansion** to all source kinds, which bypasses `categoryAllowsRouteDistance`.

No code was changed in this addendum. Nothing was committed or pushed.

---

# Addendum 2 — Differential-only acceptance review

**Date:** 2026-08-01
**Acceptance question, narrowly:** did only the three approved rows change, while matching, findings, and approval eligibility remained stable everywhere else?

## Answer: yes. ACCEPT.

### 1. Blast radius is now one production file

`git diff` against HEAD for the interpretation slice touches exactly one production interpretation file, `lib/contracts/contractPricingAssembly.ts`.

- `lib/contracts/exhibitARateTableRows.ts` — **fully reverted**, no diff.
- `lib/contracts/types.ts` — **fully reverted**, the speculative `distance_band?` field is gone.
- `lib/validator/billingKeys.ts` — `detectRoute` and `detectDistanceBand` are **byte-identical to HEAD** (verified by reading lines 555–569). The only change is an additive exported seam, `diagnoseOperationalDimensionCompatibility`, which calls the unmodified private functions. The 39-string differential is therefore tautologically clean: the matcher's bonus trigger set cannot have moved because the code producing it is unchanged.
- The `explicitOriginDestination` precedence expansion is **reverted** — `structuredRouteDimensions` is again gated on `sourceKind === 'tdot_appendix_b_stitched_table'`, so the `categoryAllowsRouteDistance` gate is no longer bypassed for other source kinds.

### 2. Exactly three rows changed, in exactly two fields

Re-executed the real production path (`extractDocument → runDocumentPipeline → assembleContractPricingRows`) on the Golden contract, sha256 `922161a5…`, and diffed row-for-row against the **pre-slice** trace captured during the primary review.

```
transport rows  before=20 after=20     added=[]  removed=[]

CHANGED rate=6.9    exhibit_a_table:pdf:table:p8:t26:r2:v1
    route          None -> 'ROW to DMS'
    distanceBand   None -> '0 to 15 Miles'
CHANGED rate=3.25   exhibit_a_table:pdf:table:p8:t31:r1
    route          None -> 'DMS to Final Disposal'
    distanceBand   None -> '0 to 15 Miles'
CHANGED rate=5.4    exhibit_a_table:pdf:table:p8:t32:r1
    route          None -> 'DMS to Final Disposal'
    distanceBand   None -> '60+ Miles'

total changed rows: 3
```

`description`, `unit`, `rate`, `category`, `confidence`, `sourceKind`, `sourceQuality`, `authoredValueCorrection`, and `sourceAnchor` are identical on all 20 transport rows, including the three. The two `$10.90` rows that regressed in the previous revision do not appear in the diff at all — they are restored to baseline.

### 3. The changed fields cannot reach the matcher

`lib/validator/projectValidator.ts:1538` projects assembled rows into `rateScheduleItems` using exactly these fields:

```
row_id, source_kind, category, source_category, material_type, description,
unit, unit_type, rate, rate_amount, page, source_anchor_ids, confidence,
source_quality, authoredValueCorrection, rate_raw, raw_text
```

`route`, `distanceBand`, `pricingDimensions`, and `pricingDimensionSources` are **not projected**. The three changed fields are structurally unreachable from `matchRateScheduleItemForInvoiceLine`, cross-document rate verification, exposure, and findings. Combined with §2 — no projected field changed on any row — matching input is provably identical.

Description stability across all 90 rows, not just the 20 transport rows: `cleanContractRateDescriptionForDisplay` is the only path by which a route/distance change could alter a description, and it passes `null` for both whenever `categoryAllowsRouteDistance(category)` is false. That gate is unchanged, so non-transport descriptions cannot move; transport descriptions are verified unchanged empirically above.

### 4. Golden ledger restored exactly

| Metric | Pre-slice | Bad revision | Now |
|---|---|---|---|
| rate-schedule rows | 105 | 104 | **105** |
| assembler outputs / candidates | 90 | 90 | **90** |
| merged or deduped | 15 | 14 | **15** |
| resolved / approval-eligible | 56 | 58 | **56** |
| needs review | 34 | 32 | **34** |
| excluded | 0 | 0 | **0** |
| silently lost | 0 | 0 | **0** |
| suppression reasons | 7/4/4 | 6/4/4 | **7/4/4** |

`mergedOrDeduped = 15` is the meaningful control here: the assembler's dedupe key (`contractPricingAssembly.ts:1529-1536`) *does* incorporate `route` and `distanceBand`, so populating them on three rows could have changed merge outcomes. It did not.

Goodlettsville `5/5/0`, TDOT `32/25/7`, MDOT `5/3/2` — unchanged; all four fixtures reconcile with zero silent loss.

### 5. Approval eligibility stable, including the two contested rows

| Anchor | Group | Eligible | Blockers |
|---|---|---|---|
| `pdf:table:p8:t26:r2` ($6.90) | needs_review | false | `authored_value_correction` |
| `pdf:table:p8:t31:r1` ($3.25) | needs_review | false | `authored_value_correction` |
| `pdf:table:p8:t32:r1` ($5.40) | needs_review | false | `authored_value_correction` |
| `pdf:table:p8:t27:r2` ($10.90) | needs_review | false | `description_unresolved` |
| `pdf:table:p8:t30:r6` ($10.90) | needs_review | false | `description_unresolved` |

The three approved rows gain evidence-backed dimensions **without** gaining approval — the authored-correction blocker holds, which was the load-bearing safety property. The two `$10.90` rows are back to review-only with an empty description, exactly as before the slice. Project-wide `approvalEligible` is 56, matching pre-slice.

### 6. Gates re-run independently

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | passed |
| `npx vitest run lib/validator lib/contracts lib/canonical` | 53 files / 711 passed |
| `npx vitest run lib/evaluation/canonicalPricingRealFixtureParity` | 4 passed, all fixtures reconcile |
| Golden real-pipeline row diff vs pre-slice baseline | **3 rows, 2 fields, 0 added, 0 removed** |
| `billingKeys` interpretation functions vs HEAD | byte-identical |

## Verdict

**ACCEPT.** All three prior blocking findings are resolved: `billingKeys` and Exhibit A are back to exact pre-slice behavior, the Golden ledger is restored to `105 / 90 / 56 / 34 / 0 / 15 / 0`, and the two `$10.90` rows are review-only again. The change set is now precisely the three approved rows, in precisely the two fields intended, and those fields are structurally unreachable from the matcher.

Two non-blocking items carried forward from Addendum §A, unchanged in scope: `lib/contracts/pricingDimensions.ts` still has no executable no-fixture-branching guard of the kind `lib/canonical/**` has, and the primitive should be documented as debris-domain rather than universal.

No code was changed in this review. Nothing was committed or pushed.
