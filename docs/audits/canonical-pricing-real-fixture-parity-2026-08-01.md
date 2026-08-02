# Canonical Pricing — Real-Fixture Parity and Recovery Audit

**Date:** 2026-08-01
**Depends on:** `canonical-interpretation-pivot-review-2026-08-01.md`, `canonical-pricing-domain-slice-2026-08-01.md`
**Status:** Measurement only. No production wiring, no Project Facts change, no Validator change, no extraction change, no migration, no commit, no push.

---

## 1. Git state

| Property | Value |
|---|---|
| Branch | `main` |
| HEAD | `732139e` |
| Commits / pushes | **none** |
| Modified tracked files | **11** — all pre-existing Cycle 9–21 extraction work, none touched here |
| New untracked (this slice) | `lib/evaluation/canonicalPricingBoundaryHarness.ts` + `.test.ts`, `lib/evaluation/canonicalPricingRealFixtureParity.test.ts`, this report |

`git diff --check` clean. Nothing under `lib/extraction/domain/`, `lib/projectFacts.ts`, `lib/validator/**`, `components/**`, or `supabase/migrations/**` was modified. The Cycle 16/21 freeze is intact.

---

## 2. Canonical-slice complexity audit (Workstream A)

Audited before fixture execution, against the eight named defect classes.

| Check | Finding | Severity |
|---|---|---|
| Duplication with `lib/interpretation/canonical/` | `CanonicalTruthDependency` is a structural mirror of `TruthDependency`. Deliberate — it keeps `lib/canonical` from importing the interpretation layer before the layering is settled — and documented in-file. Not accidental duplication. | note |
| Duplication with `ContractFieldAnalysis` | Real conceptual overlap: `{value, state, confidence, evidence_anchors, source_fact_ids, notes}` vs `TruthEnvelope`. `ContractFieldAnalysis` is contract-field-specific and anchor-string-based; `TruthEnvelope` is generic and evidence-typed. Convergence belongs in the integration slice, not here. | note |
| **Duplicate truth-state concepts** | **Three vocabularies now coexist:** `ContractFieldState` (`explicit\|derived\|conditional\|conflicted\|missing_critical`), `CanonicalProjectTruthState` (`resolved\|missing\|conflicted\|derived\|unresolved\|requires_review`), `CanonicalTruthState` (8 states, no `missing`). Canonical is the intended convergence target, but until integration this is a genuine third vocabulary. | **finding** |
| Presentation concerns in domain types | `displayGroup` and `CANONICAL_PRICING_CORE_FIELDS` ("display order") are presentation-adjacent, but both were explicitly specified as product requirements (three user-facing groups). Mandated, not drift. | accepted |
| **Fields no adapter can populate** | `CanonicalContractPricingRow` carries **27 enveloped fields**; the current adapter can populate **9** (`rateSchedule`, `category`, `description`, `unit`, `rate`, `route`, `distanceBand`, `quantity`, `totalAmount`). **18 envelopes are permanently `absent_from_source`** from this adapter. Real fixtures confirm: no fixture populated `rateCode`, `currency`, `pricingMethod`, `materialType`, `origin`, `destination`, `equipmentType`, `personnelClassification`, `sizeOrDiameterBand`, `passThrough`, `markup`, `minimumCharge`, `maximumOrNteAmount`, `effectivePeriod`, `applicabilityConditions`, or `exclusions`. | **finding** |
| Persistence-hostile structures | 27 envelopes × 90 Golden rows = **2,430 envelopes for one document**, 18/27 of them empty. Under the fact-per-field persistence option that is ~2,430 rows where ~810 carry values. A sparse representation (omit `absent_from_source` envelopes, reconstruct on read) would cut that by two thirds. | **finding** |
| Unnecessary constructors / helpers | Two exports are genuinely unreferenced anywhere (1 ref = own definition): `rowsInDisplayGroup`, `CanonicalPricingCoreField`. Everything else is used internally or by tests. | minor |
| Circular dependencies | None. Strict one-way: `envelope.ts` ← `pricing.ts` ← {`pricingResolution.ts`, `pricingAdapter.ts`}. | clean |
| **Unstable identity generation** | `rowId = candidateId = ContractPricingAssemblyRow.id`, which falls back to `contract_pricing_row:${index + 1}` (`contractPricingAssembly.ts:2009`) when `row_id` is absent — an **ordinal-derived id**. Measured: all 132 real rows across all four fixtures carried a real `row_id`, so the fallback was never exercised. It remains a latent instability if canonical ids are ever persisted. | **finding** |

### Verdict: **PROPORTIONATE, with contained debt — no REVISE required**

3,169 lines for a domain contract plus 88 tests is defensible: no correctness defect was found, there are no cycles, and the two dead exports are trivial. The 18-empty-envelopes-per-row ratio is the only weight concern, and it stems from the field list the product owner specified, not from speculative modelling. It is a **sparse-representation** question for the integration slice, not a reason to revise the model now.

Fixture integration therefore proceeded.

---

## 3. Fixture inventory (Workstream B)

Corpus root: `C:\Users\ADMS Thompson\Desktop\EightForgeDocTrainning\Training Projects`

| Fixture | Artifact | SHA-256 | Role | Executed |
|---|---|---|---|---|
| **Golden** | `Williamson Co TN Fern 0126_…_Contract and Price Sheet_1.pdf` (2.48 MB) | `922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f` | governing contract **and** rate schedule (single combined PDF) | ✅ |
| Golden | `Aftermath-Williamson Co invoice - ROW and LH .xlsx - 2026-002_01INV_InvoiceCover.pdf` | `af399fea21ba2bca5c0381de2289a564e924e252553403c311c0486fa0723282` | invoice 2026-002 cover | ❌ not run (pricing audit) |
| Golden | `Aftermath-Williamson Co invoice - thru 3.4.26.xlsx - 2026-003_01INV_InvoiceCover.pdf` | `a530233b65956a5d267320bea2b43c248442e4ab98d762fba8b725549ab255c0` | invoice 2026-003 cover | ❌ not run |
| Golden | `ticket_query_20260404_191302.xlsx` (1.53 MB) | `241b1c4d9712d40eee844db2ccf5b4c9e436c293bf094d1f5ca72a1c6690d2df` | transaction/ticket workbook | ❌ not run |
| **Goodlettsville** | `lib/contracts/__fixtures__/goodlettsville_price_sheet.pdf` | `a9a0e6538426d3f34f0521aeb70f511ce0e5941479b29adb05114e21b641c920` | price sheet — **byte-identical to the corpus copy**, so the in-repo file was used | ✅ |
| Goodlettsville | `…_Contract_1 (1).pdf` | `84b37ff3d83fe6637cd19a16b848462a11ef1018720803ae06490d25f01f193f` | contract | ❌ not run |
| Goodlettsville | 5 × `GOD-*_01INV_InvoiceCover.pdf`, `Goodlettsville ticket_query_20260616_150734.xlsx` | — | invoices, tickets | ❌ not run |
| **TDOT** | `SWC 820 - Fern - Contract #89633 PHILLIPS HEAVY INC- PJ.pdf` | `7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a` — **exact match to Cycle 21 §4** | authoritative contract | ✅ |
| TDOT | `phase3-step4-artifacts/` (Phase-0 package, v1.14.0 parity baseline, Cycle 15/16/21 outputs) | per Cycle 21 | artifact root | present, not re-run |
| TDOT | 4 × MOU PDFs, 5 × invoice covers (`CHE/CLA/DAV/DIC/HIC-H01`) | — | amendments, invoices | ❌ not run |
| **MDOT** | `310225302000_Executed_Contractor.pdf` (12.4 MB) | `ab8cf60665a42368ee29f0119456daaf7b29862e75df5ccbc4b365a7142a34ca` | executed contract | ✅ |

### Corrections to earlier statements

- **The previous slice report understated TDOT.** It has invoice covers and four MOU amendment PDFs, not just the contract. The prior claim that only Golden had a full chain was wrong.
- **Goodlettsville needs no external file.** The in-repo fixture hashes identically to the corpus price sheet.
- **MDOT remains contract-only.** No invoice, ticket, or price-sheet artifact exists. Confirmed by directory listing — the folder holds exactly one file.

### Explicitly absent

- Accepted intelligence traces, current `validation_summary_json`, current Project Facts output, and current cross-document rate-verification output for Golden **are not available on this machine**. They live in Supabase, which this audit does not touch. Workstreams F and K are therefore reasoned from code paths and existing test fixtures, **not** from a live Golden project record. This is stated again where it matters.

---

## 4. Evaluation harness design (Workstream C)

`lib/evaluation/canonicalPricingBoundaryHarness.ts` — imported by no production module (verified: `grep -rn "canonicalPricingBoundaryHarness" lib app components` matches only the harness and its two tests).

Boundaries captured:

| # | Boundary | Source |
|---|---|---|
| 1 | source extraction pricing observations | `extractDocument` → `content_layers_v1.pdf.tables` (table + row counts) |
| 2 | contract intelligence `rate_schedule_rows` | **`runDocumentPipeline(...).contractAnalysis.rate_schedule_rows`** — the genuine production call, not a hand-assembled approximation |
| 3 | rows entering `assembleContractPricingRows` | same as 2 |
| 4 | rows rejected before assembly | ledger, §5 |
| 5 | rows merged / deduplicated | `mergeDiagnostics` on survivors + solo-probe |
| 6 | final `ContractPricingAssemblyRow[]` | assembler output |
| 7 | `CanonicalContractPricingCandidate[]` | `adaptAssembledPricingRows` |
| 8 | canonical resolution | `resolveCanonicalPricingRow` + `buildCanonicalPricingSchedule` |

**Comparison identity** never uses a canonical id alone:

```
key = documentId | page | sourceAnchor | normalizedDescription | unit | rate | rateCode
```

with the upstream `row_id` retained separately for traceability. Survivorship prefers the exact upstream `row_id` (the assembler carries `row_id` → `ContractPricingAssemblyRow.id`) and falls back to content identity only when no `row_id` exists.

### Two harness defects found and fixed during development

Both are recorded because they would otherwise have produced a wrong audit.

1. **Wrong pipeline input shape.** The first wiring passed `payload.extraction` as `extractionData`. `extractNode` reads `extractionData.extraction.content_layers_v1`, so `content_layers` resolved to `null` and **every fixture reported 0 rate rows**. Corrected to pass the whole payload. A "0 everywhere" result was correctly treated as a wiring failure, not a finding.
2. **Content-identity masking.** Survivorship keyed on content identity first, so two content-identical rows shared a key and a survivor masked a dropped duplicate — under-reporting merges. Corrected to prefer the exact `row_id`. Real-fixture numbers were unchanged by the fix (all real rows carry `row_id`), but the synthetic unit test now covers it.

An earlier hand-assembled route (bypassing `runDocumentPipeline`) produced materially different and **wrong** numbers — see §16.

---

## 5. Rejection-ledger design (Workstream D)

Every input row that does not appear in the assembler output is recorded with source identity, raw values, boundary, rejecting function, reason, and three recoverability flags.

Attribution method, stated precisely:

- **`observed_merge_diagnostic`** — the reason is read from a real `mergeDiagnostic` emitted by the assembler. Authoritative.
- **`derived_from_documented_predicate`** — the row is **solo-probed** (`assembleContractPricingRows([row])`). If it survives alone but not in the set, it was suppressed by merge/dedupe. If it does not survive alone, the documented predicate conditions from the slice report §13 are evaluated read-only against the row's own values, in documented order, to name a reason.

The second class is an **attribution model, not instrumentation**. No production function was patched, wrapped, or re-implemented, and rejection behaviour is unchanged.

---

## 6. Golden boundary counts (Workstream E)

Production pipeline path. Extraction 74 s (full OCR).

| Boundary | Count |
|---|---|
| Source tables | **57** |
| Source table rows | **212** |
| `rate_schedule_rows` (contract intelligence) | **105** |
| Assembler inputs | **105** |
| Assembler outputs | **90** |
| Rows merged / deduplicated | **15** |
| **Rows silently lost** | **0** |
| Canonical candidates | **90** |
| Resolved pricing | **56** |
| Needs review | **34** |
| Excluded | **0** |
| Approval eligible | **56** |
| Approval ineligible | **34** |

Merge/dedupe breakdown — all 15 carry an observed diagnostic on the surviving row:

| Reason | Count |
|---|---|
| `duplicate_content_key` | 7 |
| `trusted_coverage_suppression` | 4 |
| `trusted_description_slot_suppression` | 4 |

**Rejection ledger: empty.** Zero rows were dropped by a filter. The 105 → 90 reduction is entirely explained, auditable merge activity.

---

## 7. Golden canonical pricing results (Workstream E, representation)

Across the first 60 canonical rows (logged window):

| Truth state | Count |
|---|---|
| `resolved` | 40 |
| `requires_review` | 18 |
| `extraction_conflict` | 2 |

| Approval blocker | Count |
|---|---|
| `authored_value_correction` | 11 |
| `rate_unresolved` | 5 |
| `description_unresolved` | 4 |
| `extraction_conflict` | 2 |

Categories resolved: Vegetative Collect Remove & Haul 8 · C&D 4 · Management & Reduction 6 · Final Disposal 8 · Tree Operations 7 · Equipment 27. **No row had an unresolved category.**

| Required representation | Result |
|---|---|
| Rate schedule | ✅ from adapter context |
| Category | ✅ 60/60 resolved |
| Rate code | ⬜ `absent_from_source` — Golden contract rows carry no rate code (this is the real asymmetry behind the unmatched-invoice case) |
| Description / scope | ✅ 56/60 (4 `description_unresolved`) |
| Unit | ✅ |
| Rate | ✅ 55/60 (5 `rate_unresolved`) |
| Origin / destination | ⬜ not populated as discrete fields; carried inside `route` |
| Route | ✅ 13/60 |
| Distance band | ✅ 11/60 |
| Material type | ⬜ `absent_from_source` — inferable from category text, deliberately not inferred |
| Governing document | ✅ all rows |
| Source evidence | ✅ **60/60 carry ≥1 evidence ref**; 55/60 carry a governing page + anchor for the rate field (the 5 without are exactly the 5 `rate_unresolved` rows, whose rate envelope has no governing source by construction) |
| Truth state | ✅ all rows |

**2 rows entered `extraction_conflict`** — genuine rate disagreements detected from merge diagnostics where the discarded reading carried a different rate. This is the conflict signal working on real data.

---

## 8. Golden business-chain mapping (Workstream F)

### The unmatched Vegetative ROW-to-DMS 0–15 case, measured

The row **is present** in canonical output:

```
category      Vegetative Collect, Remove & Haul   (resolved)
description   from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles
unit          Cubic Yard
rate          6.9
page          8
anchor        pdf:table:p8:t26:r2
evidence      4 refs
route         null        ← sibling rows at 16-30 and 31-60 DO carry route + band
distanceBand  null
state         requires_review
displayGroup  needs_review
eligible      false
blockers      ["authored_value_correction"]
```

Its siblings resolve cleanly and are approval-eligible: `16 to 30 Miles @ $7.90` and `31 to 60 Miles @ $8.90`, both with `route: "ROW to DMS"` and a populated `distanceBand`.

| Chain link | Current state | Canonical effect |
|---|---|---|
| Governing canonical pricing candidate | **present**, rate $6.90, page 8, 4 evidence refs | preserved |
| Invoice representation | invoice `2026-002` line `1A`, 43 894 CY @ $6.90 = $302 868.60 (from `crossDocumentRateVerification.test.ts` fixtures — **not re-executed here**) | not built in this slice |
| Transaction representation | ticket `mobile:2026-002-1A`, 43 894 CY, material Vegetative (same source) | not built |
| Current matching key | `deriveBillingRateKey` → contract row has no rate code, so it falls to `desc:<normalized>` — tier-3 heuristic | canonical would mark such a match `requires_review`, never `resolved` |
| Current validation finding | `CROSS_DOCUMENT_CONTRACT_RATE_EXISTS` when no contract row matches | **unchanged** |
| Affected amount | $302 868.60 | unchanged |
| Proposed canonical fact refs | `pricing.line.<id>.rate` ← page 8 / `pdf:table:p8:t26:r2`; invoice-line `billedRate`; ticket `quantity` | — |

**Does canonical improve, preserve, or change the finding?**

It **preserves** the finding and **adds an independent reason the current product cannot express**: the governing $6.90 rate is not approval-eligible because it carries an authored value correction (the F-04 Williamson display-correction family). Today that row would display as ordinary pricing. Under canonical it is visibly `needs_review` with a named blocker, while remaining fully visible and evidence-linked.

No finding was changed, and no Golden value was added to canonical production code.

**Honest limitation:** the invoice, ticket, reconciliation and exposure links were **not executed** in this audit — no invoice or workbook was run, and no live Golden validation summary was read. Those rows come from existing repository test fixtures. The pricing side is measured; the rest of the chain is mapped, not proved.

---

## 9. Missing-page investigation (Workstream G)

| # | Question | Answer |
|---|---|---|
| 1 | Which function rejects it? | `shouldKeepOperatorRow`, `contractPricingAssembly.ts:1656` — `if (!row.unit \|\| row.page == null) return false;` |
| 2 | Explicit or incidental? | **Incidental.** Page-nullity shares a line with unit-nullity; there is no comment, no diagnostic, and no distinct reason code. The row simply vanishes. |
| 3 | Why was page required? | It is a proxy for locatable provenance, and it gates `pageAllowsCategory` (`:1658`) which needs a page to consult `PAGE_CATEGORY_EXPECTATIONS`. Both uses are about *placing* the row, not validating its price. |
| 4 | Which source families can legitimately lack a page? | Spreadsheet/workbook-derived rows (sheet+row, no page), typed-field rows, canonical operational rows sourced from non-paginated input, and vision rows lacking page attribution. |
| 5 | Does Golden contain a real missing-page pricing row? | **No.** 0 missing-page rejections in 105 rows. |
| 6 | Goodlettsville? | **No.** 0 in 5 rows. |
| 7 | TDOT? | **No.** 0 in 32 rows. |
| 8 | Legitimate, duplicate, or junk? | **Unobserved.** The rule was not exercised once across 147 real rate rows from four documents. No population exists to characterise. |
| 9 | Could `source_document + source_anchor + raw span` suffice without a page? | **Yes, structurally.** `CanonicalEvidenceRef.evidenceRefIsLocatable` already treats a source anchor or a complete bounding box as locatable independent of page, and the canonical approval gate keys on evidence completeness, not on page presence. |
| 10 | Would retaining them create duplicate or unsafe pricing? | **Risk is real but bounded.** `dedupeKey` and `coverageKey` incorporate page; page-less rows would collide differently and could bypass `trusted_coverage_suppression`. Retention would need dedupe keys that degrade gracefully when page is absent. |

### Recommendation: **continue rejecting, but with a diagnostic**

Retention cannot be justified on evidence — no real fixture produced a single missing-page row, so there is no measured recovery to gain. But silent rejection is the wrong failure mode: it is the one drop class that leaves no trace anywhere. The contained change is to emit a rejection diagnostic (the row is still dropped, behaviour unchanged) so that if a spreadsheet-derived pricing family ever hits this path, it is visible rather than invisible.

Not "retain as needs_review" — that would be acting without evidence. Not "insufficient evidence" — the measurement was conclusive at zero incidence across four documents.

**No rule was changed.**

---

## 10. Goodlettsville results (Workstream H)

| Boundary | Count |
|---|---|
| Source tables | 6 |
| Source table rows | 13 |
| `rate_schedule_rows` | 5 |
| Assembler outputs | 5 |
| Merged / deduplicated | 0 |
| **Silently lost** | **0** |
| Canonical candidates | 5 |
| Resolved / review / excluded | **5 / 0 / 0** |
| Approval eligible | **5** |

All five rows resolve with full representation and **zero blockers**:

| Category | Description | Unit | Rate | Route | Page | Anchor | Evidence |
|---|---|---|---|---|---|---|---|
| Vegetative Collect, Remove & Haul | Loading and Hauling Vegetative Debris | Cubic Yard | 27 | ROW to DMS | 2 | `pdf:table:p2:t3:r1` | 5 |
| Management & Reduction | Debris Mgmt. Site Management | Cubic Yard | 5 | — | 2 | `…r2` | 5 |
| Management & Reduction | Reduction of Vegetative Debris | Cubic Yard | 9.24 | — | 2 | `…r3` | 5 |
| Final Disposal | Loading & Hauling to Final Disposal… | Cubic Yard | 1 | DMS to Final Disposal | 2 | `…r4` | 5 |
| Tree Operations | Hazardous Limb (Hangers) Cutting… | Unit | 135 | — | 2 | `…r5` | 5 |

This matches `goodlettsvillePriceSheet.test.ts` expectations exactly (rates 27 / 5 / 9.24 / 1 / 135, same categories, same units).

- **Unresolved category behaviour:** not exercised — all five categories resolved.
- **Rate schedule identification:** supplied via adapter context; the source names no schedule, so `scheduleName` would be `absent_from_source` without context.
- **Evidence completeness:** 5 refs per row, `coreFieldsBacked: true` on all.
- **Silent row loss:** zero.
- **Fields Goodlettsville needs that canonical lacks:** **none.** Its layout carries an explicit `origin_destination` column, which canonical currently maps into `route`. Splitting `origin` / `destination` into discrete fields would be a fidelity improvement, but nothing is lost — the model already has all three fields.

**No Goodlettsville-specific canonical logic exists or was needed.**

---

## 11. TDOT results (Workstream I)

Pricing parity only. No header-classification research was run, and the Phase-0/Phase-1 artifact root was not re-executed.

| Boundary | Count |
|---|---|
| Source tables | 13 |
| Source table rows | 115 |
| `rate_schedule_rows` | 32 |
| Assembler outputs | **32** |
| Merged / deduplicated | 0 |
| **Silently lost** | **0** |
| Canonical candidates | 32 |
| Resolved / review / excluded | **25 / 7 / 0** |
| Approval eligible | 25 |

| Blocker | Count |
|---|---|
| `authored_value_correction` | 6 |
| `rate_unresolved` | 1 |

Categories: Specialty Removal 14 · Vegetative 5 · Tree Operations 5 · Management & Reduction 3 · C&D 3 · Final Disposal 2. 22 rows carry a `route`; 0 carry a distance band (TDOT prices by origin/destination, not mileage tiers). 31/32 carry a governing page + anchor for the rate field — the one exception is the `rate_unresolved` row, whose rate envelope has no governing source by construction.

| Question | Answer |
|---|---|
| Any currently accepted rate row lost? | **No.** 32 in, 32 out, 0 rejected, 0 merged. |
| Any TDOT-specific field unrepresentable? | **No.** Origin/destination maps to `route`; the authored stitched provenance maps to `sourceFamily.sourceKind` + `authoredCorrection`. |
| Does authored adapter identity affect approval? | **Only through the generic flag.** 6 rows carry `authoredValueCorrection` and are correctly blocked. Canonical never reads `sourceKind` — verified by the slice's 9-sourceKind × 4-sourceQuality invariance test and by the forbidden-token scan. |
| Evidence preservation | 32/32 rows carry ≥1 evidence ref. |
| Missing-page behaviour | Not exercised — zero missing-page rejections. |

The canonical layer did not branch on TDOT identity, and the six authored rows are surfaced as `needs_review` rather than silently accepted as priced truth.

---

## 12. MDOT results and limitations (Workstream J)

| Boundary | Count |
|---|---|
| Source tables | **366** |
| Source table rows | **1 664** |
| `rate_schedule_rows` | **5** |
| Assembler outputs | 5 |
| Merged / silently lost | 0 / **0** |
| Canonical candidates | 5 |
| Resolved / review / excluded | **3 / 2 / 0** |
| Approval eligible | 3 |

| Category | Description | Unit | Rate | Page | Anchor | State |
|---|---|---|---|---|---|---|
| Tree Operations | Removal of Debris Hangers | Each | 94 | 193 | `pdf:text:p193:b2` | resolved |
| Tree Operations | Removal of Debris Leaners | Each | 70 | 193 | `pdf:text:p193:b3` | resolved |
| Vegetative Collect, Remove & Haul | Removal of Debris, LVM | Cubic Yard | 14.45 | 193 | `pdf:text:p193:b3` | resolved |
| Equipment | *(empty)* | LS | 1 | 193 | `pdf:text:p193:b1` | requires_review — `description_unresolved` |
| Equipment | *(empty)* | LS | 1 | 193 | `pdf:text:p193:b1` | requires_review — `description_unresolved` |

- **Canonical representability:** full for the 3 resolved rows. The 2 lump-sum rows resolve every field except description, and canonical correctly blocks them rather than publishing a blank scope.
- **Unresolved fields:** description on 2 rows; `rateCode`, `materialType`, `origin`/`destination`, `effectivePeriod` absent on all (as everywhere).
- **Evidence completeness:** 1 ref per row — the weakest of the four fixtures. These come from the **text-recovery** path (`pdf:text:pN:bN`), not table geometry, so no bounding box is available.
- **Adapter-specific assumptions:** page 193 matches `MDOT_SECTION_905_PAGE`, so the MDOT-specific upstream path is implicated in producing these rows. Canonical does not branch on it.

### Coverage limitations, stated plainly

**1 664 source table rows produced 5 pricing rows.** That ratio is not a canonical-layer loss — the rejection ledger is empty and every row the pipeline produced was represented. It is an **upstream recovery** question at boundary 1→2, and this audit cannot say whether MDOT's contract contains 5 priced items or 500, because **no MDOT annotation ledger or ground truth exists**. No invoice or transaction artifact exists either, so no chain validation is possible. MDOT supports contract-pricing representability only.

---

## 13. Current-product parity (Workstream K)

Derived from code paths, **not** from a live Golden project record (none is reachable from this machine — see §3).

| Consumer | Reads | Fields canonical has that it discards | Fields it shows that canonical lacks |
|---|---|---|---|
| Contract detail pricing display (`FactLedger`) | `ContractPricingAssemblyRow` | truth state, approval eligibility, blockers, evidence refs with geometry, conflicting evidence, precedence | none |
| `documentIntelligenceViewModel` → `DocumentContractRateRow` | same rows, re-projected | `geometryRefs`, `mergeDiagnostics`, `sourceQuality`, per-field state | none |
| Project Facts (`CanonicalProjectTruthRow`) | `validation_summary_json` | **everything** — value is a formatted string with a `source_label` and no document id, page, or evidence handle | none |
| Validator (`RateScheduleItem`) | `rate_schedule_rows` | page, geometry, raw text, merge diagnostics, per-field truth state | `authored_quarantine` finding code (F-01…F-04); canonical carries only the generic `authoredCorrection` boolean |

| Concern | Finding |
|---|---|
| Conflicting values | None observed. Canonical rates matched assembler rates on all 132 rows across four fixtures. |
| Duplicated normalization | **Yes** — `canonicalTaxonomyKeyForAllowedCategory` exists in both `contractPricingAssembly.ts` and `rateTaxonomy.ts`; canonical adds a third, deliberately non-billing `normalizeCanonicalDescription`. |
| Display strings replacing typed truth | **Yes** — `CanonicalProjectTruthRow.value: string` is the terminus; `ProjectFactsForge` renders `missing`/`unresolved`/`requires_review` with overlapping labels. |
| Provenance guessed rather than linked | **Yes** — `ProjectFactsForge` synthesises candidate documents by filtering project documents on domain (`ProjectFactsForge.tsx:368-420`) rather than reading evidence refs. Canonical supplies real refs for all 132 rows. |

**No UI was changed.**

---

## 14. Per-fixture recovery delta (Workstream L)

**Definition:** `recovery_delta` = legitimate source pricing rows not represented by the current canonical candidate output. Legitimate deduplicated duplicates are not counted as lost; prose and non-pricing rows are not counted as recovery opportunities.

| Fixture | Upstream source rows (boundary 2) | Assembler rows | Canonical candidates | Resolved | Needs review | Excluded | Irreversibly lost upstream | Retained only via diagnostics | Recoverable by contained upstream change | Genuine non-pricing noise |
|---|---|---|---|---|---|---|---|---|---|---|
| Golden | 105 | 90 | 90 | 56 | 34 | 0 | **0** | 15 | 0 | 0 |
| Goodlettsville | 5 | 5 | 5 | 5 | 0 | 0 | **0** | 0 | 0 | 0 |
| TDOT | 32 | 32 | 32 | 25 | 7 | 0 | **0** | 0 | 0 | 0 |
| MDOT | 5 | 5 | 5 | 3 | 2 | 0 | **0** | 0 | 0 | 0 |

| Fixture | Conservative recovery delta | Maximum plausible recovery delta |
|---|---|---|
| **Golden** | **0** | **15** |
| **Goodlettsville** | **0** | **0** |
| **TDOT** | **0** | **0** |
| **MDOT** | **0** | **0** (at boundaries 3–8) |

**Conservative = 0 everywhere.** No fixture lost a single row to a filter. Every boundary-2 row reached canonical output except merge-suppressed rows, all 15 of which carry an observed diagnostic on their surviving row.

**Maximum plausible = 15, Golden only**, and only under the pessimistic assumption that every merge decision was wrong. Of those 15, 8 are `trusted_coverage_suppression` / `trusted_description_slot_suppression`, which by construction have a higher-confidence survivor covering the same slot; the remaining 7 are content-key collisions. Treating all 15 as recoverable is a deliberate upper bound, not an estimate.

**MDOT's 1 664 → 5 is excluded from the delta** because the delta measures boundaries 3–8. Whether MDOT's contract holds more than 5 priced items is a boundary 1→2 recovery question with no ground truth available.

---

## 15. Model gaps

| Gap | Severity | Evidence |
|---|---|---|
| `origin` / `destination` not populated as discrete fields | low | Goodlettsville and TDOT both carry explicit origin/destination columns; canonical folds them into `route`. No data lost, fidelity reduced. |
| `rateCode` never populated from contract rows | **medium** | The Golden invoice line carries `1A`; no Golden contract row carries a code. This asymmetry is the root of the unmatched-rate case and cannot be closed by canonical alone. |
| `materialType` absent though inferable | low | Deliberate. Inference would be a guess. |
| Authored quarantine finding code not carried | **medium** | Validator has F-01…F-04; canonical carries only a boolean. 17 authored rows across Golden (11) and TDOT (6) were blocked correctly but without a reason code. |
| 18 of 27 envelopes permanently empty | **medium** | Persistence weight, §2. |
| Third truth-state vocabulary | **medium** | §2. |
| Ordinal-derived id fallback | low | Never exercised on real data (132/132 rows had `row_id`). |

**No model-breaking gap was found.** Every field any of the four fixtures produced was representable.

---

## 16. Upstream-loss points

The slice report's §13 inventory of drop points stands unchanged and **none was modified**. What this audit adds is incidence:

| Drop point | Golden | Goodlettsville | TDOT | MDOT |
|---|---|---|---|---|
| Map-phase returns (`:2076`, `:2097-2104`, `:2173-2175`) | 0 | 0 | 0 | 0 |
| `shouldKeepOperatorRow` (`:1644-1660`) | 0 | 0 | 0 | 0 |
| Uncategorized drop (`:1758-1768`) | 0 | 0 | 0 | 0 |
| Merge/dedupe (`:1710-1746`) — diagnosed, not silent | 15 | 0 | 0 | 0 |

**Every documented silent-loss path had zero incidence on real data.**

### Configuration sensitivity — a material finding about existing tests

`buildContractRateScheduleRows` behaves very differently depending on how it is called:

| Fixture | Production pipeline rate rows | Reference route (no `pdfTables`) rate rows | Reference assembled |
|---|---|---|---|
| Golden | **105** | 39 | 38 |
| Goodlettsville | **5** | 0 | 0 |
| TDOT | **32** | 0 | 0 |
| MDOT | **5** | 0 | 0 |

An intermediate hand-assembled configuration (canonical operational assembly **plus** `pdfTables`, `source_family: 'price_sheet'`) produced Goodlettsville rows via the `structural_table:` id path with null categories, of which the uncategorized-drop rule then discarded 4 of 5 — i.e. it fabricated a 4-row loss that **does not occur in production**.

Two consequences:

1. **This audit's earlier hand-assembled numbers were wrong** and are superseded by the `runDocumentPipeline` figures throughout.
2. **`goodlettsvillePriceSheet.test.ts` asserts against a non-production configuration** — it omits `pdfTables`, which production supplies at `analyzeContractIntelligence:1074`. It happens to reach the same 5-row answer as production, so it is not currently masking a defect, but it is not exercising the production path either. Worth aligning; **not changed here**.

---

## 17. Static, test and build results

| Gate | Result |
|---|---|
| `npx tsc --noEmit` | **clean** |
| `npx eslint lib/canonical lib/evaluation/canonicalPricing* --max-warnings=0` | **clean** |
| `git diff --check` | **clean** |
| `npx vitest run lib/canonical` | **88 passed** (5 files) |
| `npx vitest run lib/evaluation/canonicalPricingBoundaryHarness` | **8 passed** |
| `npx vitest run lib/evaluation/canonicalPricingRealFixtureParity` | **4 passed** (~126 s, real OCR) |
| `npm run build` | **succeeded** |
| Full suite (excluding the long fixture test) | 201 files passed, **1 failed** |

The single full-suite failure is `lib/evaluation/pdfSourceMutations.test.ts` under default 5 s timeouts. Rerun individually: **9/9 passed in 5.7 s**. Deterministic failure ruled out; this is harness timeout pressure, consistent with the same file's behaviour in the previous slice. **Not a regression** — this audit modified no production file.

---

## 18. Decision

# READY FOR CANONICAL INTEGRATION DESIGN

Every gate for this verdict is met on real data:

| Criterion | Result |
|---|---|
| Real Golden pricing maps without loss of accepted rows | ✅ 105 → 90 → 90, **0 rejected**, 15 merges all diagnosed |
| Canonical representation supports the pricing side of the business chain | ✅ category, description, unit, rate, route, band, governing document, evidence and truth state on all 90 rows; the unmatched ROW-to-DMS 0–15 case is represented with its blocker |
| Goodlettsville and TDOT reveal no model-breaking field gaps | ✅ 5/5 and 32/32 represented; no fixture-specific canonical logic |
| Silent loss measured and bounded | ✅ **zero** across 147 rate rows from four real documents |
| Canonical slice not materially duplicative or over-modeled | ✅ proportionate, with three contained debts recorded in §2 |

Not *FIX UPSTREAM CANDIDATE LOSS FIRST*: the conservative recovery delta is **0** on every fixture. The loss this was meant to catch does not exist at the measured boundaries.

Not *REVISE CANONICAL DOMAIN*: no missing concept, no correctness defect, no coupling that blocks integration.

Not *INSUFFICIENT FIXTURE EVIDENCE*: four real documents executed through the genuine production pipeline, with hashes recorded and one wiring error found and corrected.

**Two caveats that do not block the decision but must travel with it:**

- Only the **pricing** side was executed. Invoice, ticket, reconciliation, exposure and Project Facts links were mapped from code and existing fixtures, not run. No live Golden project record was read.
- **MDOT's 1 664 source rows → 5 pricing rows** is unexplained and unmeasurable without ground truth. It is an upstream recovery question, not a canonical one.

---

## 19. Exact next implementation slice

**Slice 3 — Canonical Project Truth registry + invoice/transaction canonical objects. Still additive, still unwired.**

Goal: extend the proven envelope to the two links that §8 could only map, so the full chain is measured rather than reasoned.

Scope:
1. `lib/canonical/project/index.ts` — `CanonicalProjectTruth` with the pricing section populated from the existing adapter.
2. `lib/canonical/invoice/invoiceLine.ts` + adapter from the existing invoice-line row shape.
3. `lib/canonical/transaction/transactionRow.ts` + adapter from `transaction_data_rows`.
4. A three-tier match model (`identity` / `deterministic key` / `heuristic → requires_review`) over `billingKeys`, wired only inside canonical.
5. Extend the real-fixture harness to run Golden invoice `2026-002` and `ticket_query_20260404_191302.xlsx`, and measure the full chain end to end against the unmatched ROW-to-DMS 0–15 case.

Contained fixes to fold in (all found in §2/§15, none behavioural):
- delete the two dead exports (`rowsInDisplayGroup`, `CanonicalPricingCoreField`);
- carry the authored-quarantine finding code alongside the boolean;
- decide sparse vs dense envelope representation before any persistence work.

Explicitly out of scope: production wiring, Project Facts changes, Validator changes, migrations, assembler changes, extraction changes, header-classification work.

---

## Repository state

HEAD `732139e`. No commit, no push. No migration. No production file modified. No extraction, Project Facts, or Validator change. Phase 2 `not_ready`. No cutover. No header-classification experimentation. `lib/canonical/**` and the boundary harness are imported by no production module.
