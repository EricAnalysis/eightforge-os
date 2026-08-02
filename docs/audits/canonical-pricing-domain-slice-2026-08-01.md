# Canonical Pricing Domain Slice — Additive, Unreachable

**Date:** 2026-08-01
**Depends on:** `docs/audits/canonical-interpretation-pivot-review-2026-08-01.md` (accepted)
**Status:** Additive domain contract only. Not connected to production. No extraction change, no Project Facts UI change, no migration, no commit, no push.
**Primary fixture:** Golden Project (Williamson County / Aftermath Disaster Recovery).

---

## 1. Git state

| Property | Value |
|---|---|
| Branch | `main` |
| HEAD | `732139e` — *feat(evaluation): add synthetic generalization harness and expand mutations* |
| Commits made | **none** |
| Pushes | **none** |
| Modified tracked files | **11 — all pre-existing Cycle 9–21 extraction work, none touched by this slice** |
| New untracked | `lib/canonical/`, `docs/audits/canonical-interpretation-pivot-review-2026-08-01.md`, this report |

The 11 modified tracked files are unchanged from the state recorded in Cycle 16 §1 and Cycle 21 §1:
`syntheticGeneralizationHarness.ts`, `genericTableArtifacts.ts/.test.ts`,
`legacyLocatedObservationAdapter.ts/.test.ts`, `opaqueIds.ts`, `regionArbitration.ts/.test.ts`,
`extraction/domain/types.ts`, `step1Shadow.test.ts`, `generateSyntheticGeneralizationSources.py`.

**Nothing under `lib/extraction/domain/` was read-modified-written by this slice.** The Cycle 16/21
freeze is intact. Phase 2 remains `not_ready`. No header-classification work was resumed.

---

## 2. Files created

### Production (4)

| File | Lines | Role |
|---|---|---|
| `lib/canonical/truth/envelope.ts` | 481 | Generic field-level truth envelope, typed evidence, states, constructors, predicates |
| `lib/canonical/contract/pricing.ts` | 322 | `CanonicalContractPricingCandidate`, `CanonicalContractPricingRow`, `…Schedule` |
| `lib/canonical/contract/pricingAdapter.ts` | 315 | Pure `ContractPricingAssemblyRow[] → candidate[]` |
| `lib/canonical/contract/pricingResolution.ts` | 479 | Resolution state machine, display groups, approval gate |

### Tests (5)

| File | Tests | Role |
|---|---|---|
| `lib/canonical/truth/envelope.test.ts` | 20 | Envelope invariants, confidence nullability, evidence semantics |
| `lib/canonical/contract/pricingResolution.test.ts` | 14 | Display-group totality, reason normalization, approval conjunction |
| `lib/canonical/contract/pricingAdapter.test.ts` | 29 | The 16 required proofs, Golden-driven |
| `lib/canonical/contract/goldenBusinessChain.test.ts` | 15 | Golden end-to-end representation across the 8 business links |
| `lib/canonical/contract/pricingAdapter.parity.test.ts` | 10 | Current-assembler parity and upstream row-loss measurement |

3169 lines total (1597 production, 1572 test).

**Reachability:** no file outside `lib/canonical/**` imports anything from `lib/canonical/**`. Verified:

```
$ grep -rn "lib/canonical/" lib app components --include=*.ts --include=*.tsx | grep -v "^lib/canonical/"
  (no output)
```

(A looser `lib/canonical` pattern also matches the unrelated pre-existing
`lib/canonicalIntelligenceFamilies.ts`; the path-anchored form above is the correct check.)

The slice is inert. It cannot alter any existing truth path.

---

## 3. Truth-envelope design

```ts
type TruthEnvelope<T> = {
  value: T | null;
  state: CanonicalTruthState;
  stateReason: string | null;          // machine-readable reason CODE, not prose
  confidence: number | null;           // never defaulted to a number
  governingSource: CanonicalEvidenceRef | null;
  supportingEvidence: readonly CanonicalEvidenceRef[];
  conflictingEvidence: readonly CanonicalEvidenceRef[];
  derivation: CanonicalDerivationRef | null;
  precedence: CanonicalPrecedenceRef | null;
  effectivePeriod: CanonicalEffectivePeriod | null;
  operatorReview: CanonicalOperatorReview;
  overrideHistory: readonly CanonicalOverrideEvent[];
  observedRaw: string | null;          // authored evidence, never destroyed
};
```

### Decision: `missing` is excluded, with no alias

The review asked whether `missing` should remain a broad alias. **It is excluded.** The three precise
states it would collapse are the only operator-actionable distinction in an absent value:

| State | What the operator should do |
|---|---|
| `absent_from_source` | Nothing — the source was read and does not contain it |
| `not_applicable` | Nothing — and it must not block approval |
| `unresolved_mapping` | Go to the document; something was observed but could not be mapped |

A caller that cannot distinguish them must use `requires_review`, which is honest about the ambiguity
rather than hiding it behind a shared label. The shipping `CanonicalProjectTruthState` keeps `missing`;
the canonical layer deliberately does not, and no conversion helper is provided in either direction.

### Value invariants, enforced at construction

| States | Invariant | Enforcement |
|---|---|---|
| `resolved`, `derived` | value **required** | runtime throw on null |
| `absent_from_source`, `not_applicable`, `unresolved_mapping` | value **forbidden** | constructors accept no value parameter — unrepresentable, stronger than a throw |
| `extraction_conflict`, `precedence_conflict`, `requires_review` | value **optional** (provisional) | `hasCanonicalValue()` returns false regardless, so a provisional reading can never be mistaken for truth |

`not_applicable` additionally requires an explicit reason code; a blank reason throws. A field can
never drift into "not applicable" merely by being missing.

### Confidence

`confidence` defaults to `null` in every constructor (`input.confidence ?? null` — never `?? 0`,
never `?? 1`). A genuine measured `0` is preserved as `0`. This directly answers the synthetic-confidence
defect recorded in `ocr-extraction-hardcoding-phase-1-2026-07-23.md`.

### Evidence is typed, not display strings

```ts
type CanonicalEvidenceRef = {
  documentId, page, boundingBox, rawSpan, extractionArtifactId,
  sourceAnchor, tableKey, rowIndex, cellIndex, extractor, recognitionConfidence
};
```

Two deliberate choices:

- **`CanonicalBoundingBox` is not `lib/extraction/domain/types.ts#BoundingBox`.** That type mandates
  `coordinate_space: 'page_normalized'` and a rotation, neither of which legacy table geometry proves.
  Asserting them would be synthetic provenance. The canonical box allows partial edges, defaults
  `coordinateSpace` to `'unspecified'`, and reports `complete` as a derived boolean.
- **`extractor` is read only from observed geometry metadata.** It is never inferred from `sourceKind` —
  a source-family name is not evidence of an observing engine. `asCanonicalExtractor('tdot_appendix_b_stitched_table')`
  returns `null`, and there is a test for it.

The envelope wraps **fields, not rows**, so one unreadable unit cannot poison a confident rate on the
same row.

---

## 4. Candidate pricing model

`CanonicalContractPricingCandidate` — evidence-preserving intermediate. One per input row, always.

Every field required by the brief is present. Populated from the current assembler:

| Field | Source |
|---|---|
| `candidateId`, `ordinal` | `row.id`, input position |
| `category` | `row.category` |
| `description` | `row.description` (sentinel-filtered, see §7) |
| `normalizedDescription` | local pure normalization — **explicitly not a billing match key** |
| `unit`, `rate` | `row.unit`, `row.rate` |
| `route`, `distanceBand` | `row.route`, `row.distanceBand` |
| `quantity`, `totalAmount` | `row.quantity`, `row.totalAmount` |
| `sourceFamily` | `{ adapterId, sourceKind, sourceQuality }` — opaque |
| `rawValues` | `description`, `rawText`, `rawCells`, `quantityText` |
| `evidence` | anchor/page ref + one ref per `geometryRefs` entry |
| `mergeDiagnostics` | structural mirror of the assembler's diagnostics |
| `authoredCorrection` | `row.authoredValueCorrection` |
| `extractionConfidenceLabel` | `row.confidence`, preserved as a **label** |
| `observedConfidence` | `null` — nothing upstream measures a calibrated number |
| `pricingContent` | structural predicate (§7) |

Present in the model, **null because the current source does not carry them** — not invented:

`rateCode`, `subcategory`, `currency`, `pricingMethod`, `materialType`, `serviceType`, `origin`,
`destination`, `equipmentType`, `personnelClassification`, `sizeOrDiameterBand`, `passThrough`,
`markup`, `minimumCharge`, `maximumOrNteAmount`, `effectivePeriod`, `applicabilityConditions`,
`exclusions`.

Two of these are Golden-relevant and worth naming:

- **`rateCode` is null for the Golden contract rate row.** The Golden invoice line carries `1A`; the
  contract row carries no code. That asymmetry is the origin of the unmatched-rate scenario (§11).
- **`materialType` is null**, even though "Vegetative" is plainly inferable from the category text.
  Inferring it would be a guess. Absence is recorded honestly. There is a test for this.

`currency` stays null rather than defaulting to USD — defaulting would fill an absent field.

---

## 5. Resolved pricing model

`CanonicalContractPricingRow`.

**Enveloped** — fields with a genuine truth decision: the five operator-facing core fields
(`rateSchedule`, `category`, `description`, `unit`, `rate`) plus all 23 conditional dimensions.

**Not enveloped** — mechanical identifiers and preserved provenance: `rowId`, `candidateId`,
`ordinal`, `sourceFamily`, `mergeDiagnostics`, `authoredCorrection`, `rawValues`. There is no truth
decision in a row id.

The row exposes exactly what the brief required:

```ts
resolution: {
  state: CanonicalPricingRowState;
  displayGroup: 'resolved_pricing' | 'needs_review' | 'excluded';
  unresolvedReasons: readonly CanonicalPricingUnresolvedReason[];
  approval: { eligible: boolean; blockers: readonly CanonicalPricingUnresolvedReason[] };
  evidenceCompleteness: {
    hasLocatableEvidence, coreFieldsBacked, evidenceRefCount, unbackedFieldKeys
  };
};
governingDocument: CanonicalGoverningDocumentRef | null;
precedence: CanonicalPrecedenceRef | null;
```

`CanonicalContractPricingSchedule` carries the anti-silent-loss contract:

```
candidateCount === resolvedCount + needsReviewCount + excludedCount
```

asserted on every fixture. An unresolved row is never dropped, and never mixed into
`resolved_pricing`.

---

## 6. Resolution state model

All eight required row states exist: `resolved`, `derived`, `unresolved_mapping`,
`extraction_conflict`, `precedence_conflict`, `not_applicable`, `non_pricing`, `requires_review`.

Rule order — declarative, evaluated top to bottom, no source-specific logic:

| # | Condition | State |
|---|---|---|
| 1 | zero pricing-bearing dimensions | `non_pricing` |
| 2 | readings disagree on a value | `extraction_conflict` |
| 3 | governing documents disagree | `precedence_conflict` |
| 4 | observed text could not be mapped to a category | `unresolved_mapping` |
| 5 | a core field is unsettled, **or** the value was authored | `requires_review` |
| 6 | everything above passed | `resolved` |

Extraction conflict precedes precedence conflict because a disputed reading has no settled value for
precedence to arbitrate.

**`derived` and `not_applicable` are reachable in the model but no rule in this slice produces them.**
Nothing here derives a value, and no adapter input carries evidence of inapplicability. Stated
explicitly rather than left as an implied gap.

### Display groups

| State | Group |
|---|---|
| `resolved`, `derived` | `resolved_pricing` |
| `unresolved_mapping`, `extraction_conflict`, `precedence_conflict`, `requires_review` | `needs_review` |
| `not_applicable`, `non_pricing` | `excluded` |

Tested as total over the union, and tested that **only** `resolved`/`derived` reach `resolved_pricing`.

### Approval eligibility

A conjunction of explicit confirmations — ineligible by default, eligible only by evidence:

governing source present · evidence completeness · description settled · unit settled *(where applicable)* ·
rate settled *(where applicable)* · no extraction conflict · no unresolved precedence conflict ·
**no authored value correction** · state is `resolved` or `derived`.

"Where applicable" is implemented as *settled* = resolved **or** provably `not_applicable`. A merely
missing field is not settled and blocks approval.

The authored-correction blocker is the generic form of the product's approval-safety decision: *a value
authored by a rule rather than observed at source is not approval-driving, whichever adapter produced it.*
It keys on the generic `authoredValueCorrection` flag, never on which document family the row came from.

Blockers **accumulate** rather than short-circuiting, so an operator sees every reason at once. Tested.

---

## 7. Adapter behavior

`adaptAssembledPricingRows(rows, context)` — pure, total, order-preserving.

| Requirement | Implementation |
|---|---|
| Does not call the assembler | Accepts already-assembled rows. The only file in the slice that calls `assembleContractPricingRows` is the parity **test**. |
| Never drops a row | `rows.map(...)`. Output length === input length. Tested, including the missing-category case. |
| Preserves `sourceKind` without authority | Stored in `sourceFamily.sourceKind`; no resolution or approval rule reads it. Tested across all 9 values. |
| Preserves `sourceQuality` | Same. Tested across all 4 values. |
| Preserves page, anchor, geometry, rawText | Into typed `CanonicalEvidenceRef[]` and `rawValues`. |
| Preserves `mergeDiagnostics` | Structural mirror, verbatim. |
| Preserves `authoredValueCorrection` | → `authoredCorrection`, which blocks approval. |
| Preserves confidence honestly | Label kept as a string; `observedConfidence` stays `null`. |
| Never guesses | Unavailable fields stay `null`. |
| Never assigns synthetic provenance | `extractor` only from geometry `source_type`; `recognitionConfidence` null. |
| Never turns missing into `not_applicable` | `observedEnvelope` emits `absent_from_source`; `not_applicable` is unreachable from the adapter. |

### Two adapter-boundary decisions worth flagging

**1. The `'Raw row needs review'` sentinel.** The assembler substitutes this placeholder when it cannot
recover readable text. Treating it as a description would publish a placeholder as canonical truth;
ignoring it entirely would lose the fact that the assembler saw something unreadable. The adapter maps
it to `description: null` and retains the sentinel in `rawValues.description`. This is a contract with
the adapter's *own source* — it names no category, page, table, rate, or filename, and it is overridable
via `context.unresolvedDescriptionSentinels`. It is not Golden-specific debt.

**2. `authoredRateRowQuarantine()` is deliberately NOT called.** That helper classifies F-01/F-02/F-03
by branching on `sourceKind` values naming TDOT, MDOT, and Exhibit A. Calling it would import
document-family branching into the canonical path. The adapter instead preserves the generic
`authoredValueCorrection` flag, and the approval gate blocks on that. Quarantine *classification*
belongs in the future document-family adapter layer, above canonical.

### The one structural predicate

`pricingContent` is `non_pricing` when a candidate has **no** rate, unit, quantity, total, rate code,
pass-through state, **and** no category — zero pricing-bearing dimensions. That is a statement about the
record's shape, not a business rule about any document. A row retaining even one dimension stays
`pricing`. Tested both ways.

---

## 8. Evidence preservation

Row-level evidence is deterministic: the row's own anchor/page reference first, then one reference per
`geometryRefs` entry in input order, deduplicated keeping first-seen order.

Verified on a Golden row carrying geometry:

| Preserved | Value |
|---|---|
| `sourceAnchor` | `golden:anchor:rate-row-1` |
| `page` | 8 |
| `tableKey` / `rowIndex` / `cellIndex` | preserved from geometry |
| `boundingBox` | all four edges, `complete: true`, `coordinateSpace: 'unspecified'` |
| `extractor` | `ocr_fallback` (from geometry `source_type`) |
| `rawSpan` | `$6.90` |
| `recognitionConfidence` | `null` — not fabricated |

`evidenceCompleteness.coreFieldsBacked` is false when any core field carries a value with no locatable
reference, and that blocks approval. A row stripped of page and anchor is correctly reported as
unbacked and ineligible. Tested.

`observedRaw` retains the authored span on every envelope, including non-value states — canonical
interpretation does not destroy authored evidence.

---

## 9. Source-specific assumptions excluded

None of the following entered `lib/canonical/**`:

`ALLOWED_CATEGORIES` · `EXPECTED_CATEGORY_COUNTS` · `PAGE_CATEGORY_EXPECTATIONS` · Williamson table IDs
(`pdf:table:p10:t36`, `p11:t37/38/39`) · the pickup-truck rate≠25 rule · the `cat 623` equipment rule ·
TDOT Appendix B page assumptions · MDOT Section 905 page 193 · filename/title routing · known rate
values · the Williamson display-correction map.

Enforced by an executable guard, not by inspection — `pricingAdapter.test.ts` §16 scans all four
canonical sources for forbidden tokens (`williamson`, `aftermath`, `goodlettsville`, `tdot`, `mdot`,
`appendix b`, `exhibit a`, `section 905`, `allowed_categories`, `expected_category_counts`,
`page_category_expectations`, `vegetative`, `cubic yard`, `pickup truck`, `pdf:table:p`, `.pdf`,
`stitched`, `bid_schedule`) **and** for hardcoded page/rate literal comparisons
(`/\bpage\w*\s*===?\s*\d+/`, `/\brate\w*\s*[!=]==?\s*\d+/`). 8 assertions, all passing.

Source-family identity is *preserved* (`sourceFamily.sourceKind`) but never *branched on*. Proof 14
runs the identical Golden row through all nine `sourceKind` values and all four `sourceQuality` values
and asserts identical state, display group, and approval eligibility.

---

## 10. Focused test results

```
$ npx vitest run lib/canonical
 ✓ lib/canonical/truth/envelope.test.ts                    (20 tests)
 ✓ lib/canonical/contract/pricingResolution.test.ts        (14 tests)
 ✓ lib/canonical/contract/goldenBusinessChain.test.ts      (15 tests)
 ✓ lib/canonical/contract/pricingAdapter.test.ts           (29 tests)
 ✓ lib/canonical/contract/pricingAdapter.parity.test.ts    (10 tests)

 Test Files  5 passed (5)
      Tests  88 passed (88)
```

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **clean** |
| `npx eslint lib/canonical --max-warnings=0` | **clean** |
| `npx vitest run lib/canonical` | **88 passed** |
| `npx vitest run` (full) | 1787 passed · 2 skipped · **3 failed** |

The 3 full-suite failures are `Test timed out in 5000ms` in
`lib/evaluation/syntheticGeneralizationHarness.test.ts` and `lib/evaluation/pdfSourceMutations.test.ts` —
both pre-existing timeout-heavy Cycle 9–21 harness files. Per `CLAUDE.md`, rerun individually:

```
$ npx vitest run lib/evaluation/syntheticGeneralizationHarness.test.ts \
                 lib/evaluation/pdfSourceMutations.test.ts --testTimeout=120000
 Test Files  2 passed (2)
      Tests  11 passed (11)
```

**Not a regression.** This slice modified no existing file.

### The 16 required proofs

| # | Proof | Result |
|---|---|---|
| 1 | Clean resolved row preserves category, description, unit, rate, evidence | ✓ |
| 2 | Incomplete row retained as a candidate | ✓ |
| 3 | Missing category does not make the candidate disappear | ✓ |
| 4 | Missing unit stays `absent_from_source`, not guessed, not `not_applicable` | ✓ |
| 5 | Missing rate is not approval eligible | ✓ |
| 6 | Extraction conflict → `needs_review` (+ agreeing merge stays benign) | ✓ |
| 7 | Precedence conflict → `needs_review` | ✓ |
| 8 | Non-pricing row → `excluded` (+ one dimension keeps it pricing) | ✓ |
| 9 | Unresolved mapping → `needs_review`, observed text retained | ✓ |
| 10 | Geometry and source anchors survive; unbacked rows blocked | ✓ |
| 11 | Merge diagnostics survive verbatim | ✓ |
| 12 | `authoredValueCorrection` survives and blocks approval | ✓ |
| 13 | `confidence` null remains null; label preserved uncoverted | ✓ |
| 14 | Source kind does not control approval eligibility (9 kinds × 4 qualities) | ✓ |
| 15 | Candidate and evidence ordering deterministic (byte-identical JSON) | ✓ |
| 16 | No filename/page/document-specific rule in canonical code | ✓ |

---

## 11. Golden end-to-end mapping matrix

The eight business links, from Golden source objects to the proposed canonical model.
**Link 1 is implemented in this slice. Links 2–8 are representation-proved in
`goldenBusinessChain.test.ts` using the shared envelope, but their canonical domain objects are not
built yet.**

| # | Current source object | Current field | Proposed canonical object | Canonical field | Truth state | Evidence reference | Downstream consumer | Gap / ambiguity |
|---|---|---|---|---|---|---|---|---|
| 1 | `documents` + `documentPrecedence` | `document_role`, `precedence_rank` | `CanonicalGoverningDocumentRef` | `documentId`, `family` | `resolved` | document id | pricing rows, validator | precedence is **document-level only**; a partial amendment cannot be represented |
| 1 | `ContractRateScheduleRow` | `category` | `…PricingRow` | `category: TruthEnvelope<string>` | `resolved` \| `unresolved_mapping` | page + anchor | Project Facts, validator | taxonomy is a hardcoded 8-item list upstream |
| 1 | " | `description` | " | `description` | `resolved` | page + anchor + `rawSpan` | UI, description matching | assembler may substitute a sentinel |
| 1 | " | `unit`/`unit_type` | " | `unit` | `resolved` \| `absent_from_source` | page + anchor | validator, invoice match | unit is re-parsed from `rate_raw`, so absence upstream ≠ absence at source |
| 1 | " | `rate_amount`/`rate` | " | `rate` | `resolved` \| `extraction_conflict` | page + anchor + geometry box | cross-doc rate verification | no per-cell OCR confidence survives |
| 1 | " | `origin_destination` | " | `origin`, `destination`, `route` | `absent_from_source` (Golden: route only) | page + anchor | eligibility, mileage bands | origin/destination not split upstream |
| 1 | `ContractPricingAssemblyRow` | `distanceBand` | " | `distanceBand` | `resolved` | page + anchor | mileage-tier matching | derived by regex, not modeled as a tier object |
| 1 | — | *(none)* | " | `rateCode` | `absent_from_source` | — | **contract→invoice match** | **Golden contract rows carry no rate code — root cause of link 4** |
| 1 | — | *(none)* | " | `materialType` | `absent_from_source` | — | transaction match | inferable from category text; deliberately not inferred |
| 2 | invoice line row (`StructuredRow`) | `invoice_number` | `CanonicalInvoiceLine` *(not built)* | `invoiceNumber` | `resolved` | invoice doc + page | exposure, reconciliation | normalization lives in `billingKeys` |
| 2 | " | `rate_code` (`1A`) | " | `rateCode` | `resolved` | invoice doc + page | contract match | present on invoice, absent on contract |
| 2 | " | `quantity` (43894) | " | `billedQuantity` | `resolved` | invoice doc + page | transaction reconciliation | — |
| 2 | " | `unit_price` (6.90) | " | `billedRate` | `resolved` | invoice doc + page | rate verification | — |
| 2 | " | `line_total` (302 868.60) | " | `extendedAmount` | `resolved` | invoice doc + page | exposure | row-grain vs ticket-grain must stay distinct |
| 3 | `transaction_data_rows` | `transaction_quantity`, `material` | `CanonicalTransactionRow` *(not built)* | `quantity`, `material` | `resolved` | xlsx sheet + row | invoice support | ticket-grain dedupe already in `normalizeTransactionData` |
| 4 | `billingKeys` match | `billing_rate_key` | `TruthEnvelope<Match>` | match + method | `resolved` (code identity) \| `requires_review` (description heuristic) \| `unresolved_mapping` (none) | both documents | validator, findings | **currently a heuristic match is reported as resolved** |
| 5 | `evaluateInvoiceTransactionReconciliation` | variance | `DerivedFact` | `variance` | `derived` | invoice + ticket refs | exposure | cites inputs; today it does not |
| 6 | `evaluateCrossDocumentRateVerification` | `comparison_status` | `DerivedFact` | `status` | `derived` \| `absent_from_source` | contract + invoice refs | findings | missing-rate vs mismatch conflated in places |
| 7 | `ValidationFinding` | `fact_keys: string[]` | finding → field refs | `{objectId, field}[]` | n/a | both documents | Project Facts, drawer | **findings name fact keys, not fact identities** |
| 8 | `InvoiceExposureSummary` | `at_risk_amount` | `DerivedFact` | `atRiskAmount` | `derived` | invoice refs | Project Facts | derivation inputs not currently recorded |

### The required unmatched-rate representation test

The Golden scenario — invoice line `1A`, `Vegetative … ROW to DMS 0 to 15`, 43 894 CYD @ $6.90 =
$302 868.60 — where no contract row can be tied to the line, is represented as:

```ts
unresolvedMapping<{ contractRowId: string }>({
  supportingEvidence: [invoiceEvidence()],     // the invoice line
  conflictingEvidence: [contractEvidence()],   // the contract row that failed to match
  stateReason: 'no_contract_rate_matched_for_invoice_line',
  observedRaw: '1A Vegetative … ROW to DMS 0 to 15',
});
```

The match value is `null` — an unmatched line cannot carry a match — while **both sides of the evidence
are retained** and the observed text is preserved. The three matching tiers are separately proved:
rate-code identity → `resolved`; description similarity → `requires_review`, never `resolved`; no match
→ `unresolved_mapping`.

No Golden value appears in canonical production code. All Golden constants live in the two test files.

---

## 12. Current-assembler parity results

### Golden Project fixture (6 representative rows)

```
[parity:golden] {
  inputCount: 6, assembledCount: 3, candidateCount: 3, droppedUpstream: 3,
  emittedRowIds: ["golden:rate-row:1","golden:rate-row:2","golden:rate-row:no-category"],
  coverage: { candidateCount: 3, resolvedCount: 3, needsReviewCount: 0, excludedCount: 0 }
}
```

| Metric | Value |
|---|---|
| Rows emitted by the current assembler | **3** |
| Rows adapted into canonical candidates | **3** |
| Rows lost by the adapter | **0** |
| Would be `resolved_pricing` | **3** |
| Would be `needs_review` | **0** |
| Would be `excluded` | **0** |
| Input rows discarded before the adapter could see them | **3** |

**A correction to an assumption in the accepted review.** The review predicted the recovery delta would
be dominated by rows the assembler drops for missing fields. Measured behaviour is different, and more
favourable to the assembler:

| Input | Predicted | **Measured** |
|---|---|---|
| `no-unit` | dropped | **unit RECOVERED** by re-parsing `rate_raw`; survives alone. In the set it collides with row 1 on the dedupe key and is suppressed **with a merge diagnostic** |
| `no-rate` | dropped | **rate RECOVERED** from `rate_raw`; same dedupe suppression |
| `no-category` | dropped | **category RECOVERED** from classification context; emitted, with its unreadable description intact |
| `no-page` | dropped | **dropped SILENTLY** — no diagnostic, no trace |

So of the 3 rows that never reach the adapter, **2 remain auditable** as `mergeDiagnostics` on the
surviving row (asserted: `['golden:rate-row:no-rate', 'golden:rate-row:no-unit']`), and **exactly 1 —
the missing-page row — is unrecoverable**. A test asserts its id appears nowhere in the serialized
canonical schedule, documenting the limit rather than working around it.

### Alternate pricing layout fixture (uncategorized price-sheet rows)

```
[parity:alternate-layout] {
  assembledCount: 2,
  coverage: { candidateCount: 2, resolvedCount: 0, needsReviewCount: 2, excludedCount: 0 },
  categories: ["unresolved_mapping","unresolved_mapping"]
}
```

Both rows survive the assembler (canonical-source rows are preserved even without a category) and both
become `unresolved_mapping → needs_review`, never `resolved_pricing`, never approval-eligible. This is
the product requirement working end to end: **visible, addressable, and out of the authoritative
schedule.**

### Fixture availability — stated honestly

| Fixture | Artifacts on this machine | Used in this slice |
|---|---|---|
| **Golden (Williamson)** | `…\Training Projects\Golden Project-Williamson\` — contract + price sheet PDF, 2 invoice cover PDFs (2026-002, 2026-003), `ticket_query_20260404_191302.xlsx` | **Representative row objects only.** No PDF/xlsx was executed. |
| **Goodlettsville** | `…\Goodlettsville\` — contract PDF, price sheet PDF, 5 invoice cover PDFs, ticket xlsx. Plus `lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf` in-repo | **Not executed.** The "alternate pricing layout" fixture is a synthetic uncategorized-canonical-row set, not the Goodlettsville PDF. |
| **TDOT** | Full artifact root per Cycle 21 §4, v1.14.0 baseline reproducing 0/288 changed | **Not executed.** No extraction was run. |
| **MDOT** | `…\MDOT\310225302000_Executed_Contractor.pdf` — **contract only.** No invoice, ticket, or price-sheet artifacts | **Not executed.** |

**I am not claiming four-family coverage.** This slice ran zero real documents. It proves the domain
contract against representative row objects shaped from Golden data. Executing the four fixtures through
`assembleContractPricingRows` and measuring the real recovery delta is the next slice (§16). MDOT in
particular has only an executed contract PDF — it can support a contract-pricing non-regression check
but **cannot** support an end-to-end invoice/transaction chain.

---

## 13. Upstream row-loss points

Every place the current assembler removes a row before returning. **None was modified.**

### Stage 1 — map phase, `assembleContractPricingRows` (returns `null`, no diagnostic)

| Line | Condition | Class |
|---|---|---|
| `:2076` | `(!description \|\| descriptionStillLooksNoisy(description)) && rate == null && !rawText` | generic |
| `:2097-2104` | `category === 'Equipment' && rate === 623 && /\bcat\s*623\b/ && !/[$#§]/` | **hardcoded debt** |
| `:2173-2175` | `rawSourceQuality === 'junk' && sourceQuality === 'fallback' && confidence === 'needs_review'` | generic |

### Stage 2 — `selectOperatorFacingRows` → `shouldKeepOperatorRow` false → `continue` (no diagnostic)

| Line | Condition | Class |
|---|---|---|
| `:1644` | `sourceQuality === 'junk'` | generic |
| `:1645` | `!category && confidence !== 'needs_review'` | generic, but taxonomy-dependent |
| `:1647-1652` | pickup-truck + `rate !== 25` + crew/foreman regex | **hardcoded debt** |
| `:1653-1655` | `needs_review && !hasUsefulPricingClue && !isConfirmedWilliamsonTimeMaterialsRow` | **hardcoded debt** (table ids) |
| `:1656` | `!unit \|\| page == null` | **the measured silent loss** |
| `:1657` | `rate == null && !isPassThroughAssemblyRow` | generic |
| `:1658` | `!pageAllowsCategory(page, category)` | **hardcoded debt** (`PAGE_CATEGORY_EXPECTATIONS`) |
| `:1659` | `descriptionStillLooksNoisy(description)` | generic |
| `:1660` | `unit === 'Mile' && (route \|\| distanceBand)` → `hasUsefulPricingClue` | generic |

### Stage 3 — suppression (row removed, **but recorded** on the winner)

| Line | Reason |
|---|---|
| `:1726-1730` | `trusted_coverage_suppression` |
| `:1731-1735` | `trusted_description_slot_suppression` |
| `:1737-1746` | `dedupe_key_collision` |

These are the rows the canonical layer can still audit.

### Stage 4 — uncategorized drop (silent)

`:1758-1768` — `!row.category` and `sourceKind !== 'canonical'` → dropped. Canonical-source rows are
kept (which is why the alternate-layout fixture survives).

### Stage 5 — demotion, not loss

`:1782-1796` — rows beyond `EXPECTED_CATEGORY_COUNTS[category]` are retained but demoted to
`needs_review`. Correct behaviour; the count itself is a Williamson artifact.

**The adapter cannot recover any Stage 1, 2, or 4 row.** Only Stage 3 survives as diagnostics.

---

## 14. Golden-specific assumptions across the six modules

| # | Module | Assumption | Classification |
|---|---|---|---|
| 1 | `contractPricingAssembly` | `ALLOWED_CATEGORIES` (8 FEMA-debris categories) | **configurable taxonomy** |
| 2 | " | `EXPECTED_CATEGORY_COUNTS` (9/5/5/8/10/16/9/51) | **fixture expectation** — the code comment already admits it is not a business rule |
| 3 | " | `PAGE_CATEGORY_EXPECTATIONS` (pages 8–11) | **hardcoded debt** — gates row survival |
| 4 | " | `isConfirmedWilliamsonTimeMaterialsRow` (`pdf:table:p10:t36`, `p11:t37/38/39`) | **hardcoded debt** |
| 5 | " | pickup-truck + `rate !== 25` rule | **hardcoded debt** |
| 6 | " | `cat 623` equipment drop | **hardcoded debt** |
| 7 | " | `recoverKnownExhibitADisplayCorrection` value map (18.80→13.50 etc.) | **hardcoded debt** — F-04 authored correction |
| 8 | " | `sourceKind` union naming TDOT/MDOT literals | **document-family adapter rule** (belongs in an adapter, not a domain type) |
| 9 | " | `parseContractPricingRate`, description cleanup, dedupe/merge, geometry retention | **valid universal business rule** |
| 10 | " | `MANAGEMENT_PREPARATION_DESCRIPTION` literal | **fixture expectation** |
| 11 | contract intelligence | `TDOT_APPENDIX_B_SPECS`, `MDOT_SECTION_905_PAGE = 193`, `MDOT_SECTION_905_BID_SCHEDULE_SPECS` | **hardcoded debt** (authored substitution, production-reachable) |
| 12 | " | `document_type_profile` single value `fema_disaster_recovery_debris_contract` | **configurable taxonomy** |
| 13 | " | `ContractFieldId` set (FEMA-debris field vocabulary) | **configurable taxonomy** |
| 14 | " | `buildWilliamsonContractOutput` / TDEC permit / debris ticket / daily-ops / kickoff builders in `documentIntelligence.ts` | **hardcoded debt** (demo path in production) |
| 15 | " | routing on `document_type === 'williamson_contract'` or filename containing `aftermath`/`williamson` (`:6805`) | **hardcoded debt** |
| 16 | " | clause pattern library, coverage library | **valid universal business rule** (FEMA-domain, not Golden-specific) |
| 17 | " | `authoredRowQuarantine` F-01/F-02/F-03 `sourceKind` rules | **document-family adapter rule** — correct containment, wrong layer |
| 18 | invoice normalization | `normalizeInvoiceContractorDisplay` / `inferInvoiceContractorFromPlainText` return the literal `'Aftermath Disaster Recovery'` | **hardcoded debt** — a Golden vendor name in shared production code |
| 19 | " | `INVOICE_NUMBER_LABELS`, `VENDOR_LABELS`, `HEADER_*_ALIASES` | **valid universal business rule** (generic label vocabularies) |
| 20 | " | unit-column regex (`CYD / EA / ROW / LH`) commented as "Williamson spreadsheet + invoice lines" | **configurable taxonomy** (unit vocabulary) |
| 21 | transaction normalization | `RAW_*_HEADER_ALIASES` families | **configurable taxonomy** |
| 22 | " | ticket-grain dedupe, `ticketGrainKey`, quantity-conflict surfacing | **valid universal business rule** |
| 23 | " | DMS/FDS lifecycle vocabulary | **configurable taxonomy** |
| 24 | validator matching | `deriveBillingRateKey` priority chain | **valid universal business rule** |
| 25 | " | `rateDescriptionProbablyCode` (len ≤ 24, ≤ 2 segments) | **valid universal business rule**, but heuristic — see §11 link 4 |
| 26 | " | `rateTaxonomy` `CANONICAL_TAXONOMY_KEY_BY_ALLOWED_CATEGORY` — **duplicate of `contractPricingAssembly.canonicalTaxonomyKeyForAllowedCategory`** | **configurable taxonomy** + **duplicate truth path** |
| 27 | " | `MIN_CONFIDENT_CANONICAL_CATEGORY = 0.68` | **fixture expectation** (uncalibrated constant) |
| 28 | " | vegetative/C&D alias lists | **configurable taxonomy** |
| 29 | Project Facts | section keys fixed to `contract\|invoice\|transaction\|validation` | **valid universal business rule** (extend, don't replace) |
| 30 | " | `` `${count} CYD` `` unit literal (`:3786`) | **configurable taxonomy** (unit label) |
| 31 | " | `ProjectFactsForge` synthesizing candidate documents by domain filter | **hardcoded debt** — fabricated provenance |
| 32 | " | `CanonicalProjectTruthRow.value: string` flattening | **hardcoded debt** (architectural) |

**Summary:** 13 hardcoded debt · 10 configurable taxonomy · 4 fixture expectation · 2 document-family
adapter rule · 6 valid universal business rule. Item 26 is additionally a duplicate truth path that
should collapse to one taxonomy module regardless of the pivot.

---

## 15. Persistence future path (documented, not implemented)

**No migration was added.** No table was created, altered, or read.

The existing ledgers from `20260723163517_phase3_step0_compliance_foundation.sql` can carry these
structures without new tables:

| Canonical structure | Existing home | Mapping |
|---|---|---|
| `TruthEnvelope<T>` with `state ∈ {resolved}` | `canonical_document_facts` | `fact_key = 'pricing.line.<line_id>.<field>'`; `normalized_value` = the typed value; `confidence` jsonb carries `{state, stateReason, confidence}` |
| `governingSource` + `supportingEvidence` | `canonical_document_fact_sources` | one row per evidence ref, `is_primary` for the governing source, `sequence` for deterministic order |
| `state ∈ {derived}` + `derivation` | `derived_document_facts` + `derived_document_fact_dependencies` | `rule_id`/`rule_version` map directly; `CanonicalTruthDependency` is already isomorphic to the dependency table's three-way exclusive FK |
| `operatorReview` + `overrideHistory` | `human_fact_assertions` | `supersedes_assertion_id` gives the chain the current `document_fact_overrides.is_active` boolean cannot express |
| conflict/absence states | `document_interpretation_records` with `record_type = 'ambiguity'` or `'gap'` | the `ambiguity` variant already requires all four target FKs to be null — exactly a valueless state |
| schedule versioning | `document_interpretation_snapshots` | `interpreter_manifest_hash`, `effective_truth_set_hash`, `output_root_hash` already model it |

Two open persistence questions, deliberately unresolved here:

1. **Fact-per-field vs. a `canonical_pricing_lines` table.** Fact-per-field needs zero new tables and
   inherits all constraint/RLS work, but querying a schedule means pivoting facts. A dedicated table
   is cheaper to query and adds new RLS surface. **Decide after the next slice measures real row counts.**
2. **Business effective dating vs. snapshot versioning.** `document_interpretation_snapshots` versions
   the *interpretation*. A rate schedule's contractual effective period is a different axis and must
   not be conflated with it.

---

## 16. Project Facts integration path (documented, not implemented)

```
CanonicalContractPricingRow[]
  → Canonical Project Truth registry        (lib/canonical/project/index.ts — not built)
      → lib/projectFacts.ts                 (display projection only)
          → ProjectFactsForge               (renders rows; inspects envelopes)
          → Validator + evidence drawer     (consumes typed refs, not strings)
```

**Must remain typed all the way to the UI boundary:**

`TruthEnvelope.state` · `confidence` · `CanonicalEvidenceRef` (documentId, page, boundingBox, rawSpan,
extractionArtifactId, sourceAnchor, extractor) · `precedence` · `derivation.inputs` ·
`overrideHistory` · `approval.blockers` · `unresolvedReasons` · `displayGroup` · `rate` (number) ·
`quantity` · `totalAmount` · every id.

**May become display strings at the final render step only:**

formatted rate (`$6.90`), formatted quantity (`43,894 CYD`), the state chip label, the source label
(`"Golden governing contract, p.8"`), the group heading, relative timestamps.

The rule: **a display string may be produced from a canonical value, but never consumed as one.**
`CanonicalProjectTruthRow.value: string` stays exactly where it is — the last step — and never becomes
an input to resolution, matching, validation, or approval.

Integration order when the time comes: add a fifth `pricing` section to
`resolveCanonicalProjectTruthSections` sourced from the canonical registry, leaving the existing four
sections byte-identical. That is Phase C of the accepted review and is **not** part of this slice.

---

## 17. Remaining open decisions

1. **Recovery vs. precision, now measurable.** The alternate-layout fixture shows uncategorized rows
   becoming `needs_review` rather than vanishing. On a real Golden/Goodlettsville contract this could be
   a handful of rows or several dozen. The real number is unknown until the next slice runs actual
   documents. *Product call once measured.*
2. **The missing-page silent drop (`:1656`).** It is the only unrecoverable loss measured. Should the
   assembler retain page-less rows as `needs_review` instead? That is an assembler change, explicitly
   out of scope here.
3. **Should `authoredRateRowQuarantine` findings (F-01…F-04) reach the canonical row?** Today the
   canonical layer blocks approval on the generic `authoredValueCorrection` flag but does not carry the
   specific finding code. Surfacing the code would help operators and would require the family-adapter
   layer to exist first.
4. **Duplicate taxonomy (item 26).** `canonicalTaxonomyKeyForAllowedCategory` exists in both
   `contractPricingAssembly.ts` and `rateTaxonomy.ts`. Collapsing them is a small, independent cleanup
   that does not depend on the pivot.
5. **`'Aftermath Disaster Recovery'` in `invoiceCanonicalNames.ts`** (item 18) — a Golden vendor literal
   in shared production code. Removing it changes output for any document mentioning that vendor.
6. **MDOT scope.** Only an executed contract PDF exists. Confirm whether MDOT is a contract-pricing
   non-regression fixture only, or whether invoice/ticket artifacts exist elsewhere.
7. **Where does `pricingMethod` come from?** The model carries it; nothing populates it. The nearest
   existing signal is `OperationalTableRowRole` (`unit_rate_definition`, `hourly_tm_rate`,
   `mileage_tier_rate`, `lump_sum_rate`, `passthrough_rate`) in the operational-table assembler — a
   candidate second adapter source.
8. **Row-level precedence.** Designed for in `CanonicalPrecedenceRef`, but no fixture exercises a
   partial amendment. Do not build until one exists.

---

## 18. Recommendation for the next slice

**Slice 2 — Real-fixture parity measurement. Still additive, still unwired.**

Goal: replace the representative-row parity of §12 with measured parity over real documents, producing
the number that gates Phase C.

Scope:
1. A parity harness (test-only) that runs the **Golden** contract + price sheet PDF and the
   **Goodlettsville** contract + price sheet PDF through the existing extraction path into
   `assembleContractPricingRows`, then through the canonical adapter and resolver.
2. Report per fixture: input rows, emitted rows, candidates, resolved / needs_review / excluded,
   upstream-dropped, and dropped-by-stage using the §13 inventory.
3. Add **TDOT** as a contract-pricing non-regression check only — assert the canonical row count and
   display-group distribution are stable across runs. Do **not** run the extraction generalization
   harness and do **not** touch `lib/extraction/domain/`.
4. Add **MDOT** contract-only, and say so.

Explicitly out of scope for slice 2: any production wiring, any Project Facts change, any migration,
any assembler change, and any authored-table header work.

Slice 3 — only after slice 2's numbers are reviewed — would build `lib/canonical/project/index.ts` and
the invoice/transaction canonical objects that §11 links 2–3 currently prove only at envelope level.

---

## Repository state

HEAD `732139e`. No commit, no push. No migration. No production file modified. No extraction change.
No Project Facts UI change. Phase 2 `not_ready`. No cutover. No header-classification experimentation.
`lib/canonical/**` is imported by nothing outside itself.
