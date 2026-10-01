# E3 R13 — resolve-only ruling-line ownership

Evaluation baseline: `e2ff203581f3ae4b6a6b9f970dbaf87553310af2`, branch `codex/e3-contract-prep-four-page-benchmark`.
Local source-backed implementation and measurement; no push, merge, OCR setting change, or benchmark truth mutation.

## Audit and predeclared recovery

R12's 22 class-A *geometric* opportunities split into **7 RESOLVE / 15 OVERRIDE**.
The resolve bucket is Golden `c-0013,c-0018,c-0034,c-0042,c-0066,c-0089` and Hillsdale `c-0103`.
Golden `c-0089` needs a role-less `oo` transfer that intersects a detected rule. It is NOT an existing-resolved-ownership override, but is deferred by the incoming-token intersection guard.
The **predeclared implemented target was 6 cells** (5 Golden + 1 Hillsdale), with zero prior matches lost. Actual recovery equals that target cell by cell.

The override bucket is Golden `c-0024,c-0033,c-0038,c-0040,c-0044,c-0051,c-0050,c-0062,c-0063,c-0064,c-0069,c-0079,c-0078,c-0082,c-0088`.
These need resolved contaminants removed or existing row/column ownership contradicted for the complete R12 union. Some partial additions can gain IoU, but whole-cell conflict checks deliberately abstain.
An initial audit-only broad augmentation model lost three existing Golden matches. It was rejected before production edits. Conservative rule-disjoint source ownership predicts and produces zero losses.

## Implementation boundaries

- `ruling_line_evidence_v1` is an additive non-authoritative layer, detector `axis_ink_runs_v2`. Detector parameters/geometry are the R12 v2 source-raster method, not tuned to labels.
- Evidence binds source SHA-256, exact render SHA-256, page, dimensions, detector version, rule geometry/digest, raster-ink digest, and current OCR token-geometry digest. This is separate from existing representation/observation/recovery identities.
- Only one existing detected table/grid may qualify. Every physical column must agree with the current header structure; a resolved header plus role-less phantom labels can share one physical column, but competing resolved roles cannot.
- Only closed grid cells with exactly one existing admitted rate-row anchor qualify. No admission, no numeric/unit assignment, no new semantic role.
- New ownership requires whole-token containment, positive uniquely owned source ink, and no detected-rule-band intersection. Sloped intersections use both interval endpoints, not a box midpoint.
- A global transfer plan only moves unresolved ownership. Existing resolved refs and their raw boxes survive unchanged; crossing/rule-like glyphs are retained, never deleted/cropped/normalized.
- Native-only/mixed pages remain unsupported by this OCR-render adapter and unchanged. Non-ruled, broken, decorative, disagreeing, stale, or ambiguous evidence abstains.
- The entire evidence/resolution path is bypassed under frozen `spacing_only`.
- Benchmark projection still projects only reconstruction output. Scorer, 0.5 threshold, labels, approvals, confirmations and existing identity pins are unchanged.

## Measured results

| Page | Matched cells | Predicted cells | Cell F1 | Exact rows | Remaining |
|---|---:|---:|---:|---:|---:|
| golden-p8 | 37 → 42 | 83 → 80 | 0.4044 → 0.4667 | 1 → 2 | 58 |
| hillsdale-p3 | 119 → 120 | 120 → 120 | 0.9794 → 0.9877 | 39 → 40 | 3 |
| dn-p106 | 178 → 178 | 179 → 179 | 0.9916 → 0.9916 | 23 → 23 | 2 |
| dn-p107 | 171 → 171 | 171 → 171 | 0.9744 → 0.9744 | 23 → 23 | 9 |
| Aggregate | 505 → 511 / 583 | 553 → 550 | .8891 → .9020 | 86 → 88 / 116 | 78 → 72 |

All four pages were run twice through the real source-PDF/production OCR/production reconstruction path. Predictions were identical between runs. All prior 505 cell matches survived. OCR word predictions and coverage were unchanged.
Golden recovered `c-0013,c-0018,c-0034,c-0042,c-0066`; Hillsdale recovered `c-0103`.
Golden loses three empty phantom body cells after their source refs transfer; the authored/unresolved `SE` header remains preserved.

DN p106 and p107 prediction/pricing output remains byte-equivalent to R8. Body row counts are unchanged. Every reconstruction primitive-ref multiset is unchanged, with no added/dropped/duplicated refs. Existing rate/unit cells are byte-equivalent.

## Pricing and Golden descriptions

Pricing row counts before/after: golden-p8 17/17; hillsdale-p3 0/0; dn-p106 21/21; dn-p107 20/20.
Numeric rates, raw rates, units and quantities are unchanged. The Hillsdale truck only gains role-less structural membership; no Dozer row is admitted/priced and no damaged rate is repaired.
Golden's **9** changed description cells gain existing source refs only. Existing OCR defects and resolved contaminants are intentionally retained.
Indices below are the existing `row_index`, not array positions. Added refs are exact `text@[x_min,y_min,x_max,y_max]` in the original scale-2 OCR render. Full confidence/source fields are in the verification JSON. This baseline replay does not mint observation IDs; production refs keep their already-captured IDs.

| Row | Before | After | Exact added source refs |
|---:|---|---|---|
| 1 | 31-60 Miles frorh | 31-60 Miles frorh ROW DMS | `ROW@[654,383,719,399]`; `DMS@[725,383,765,398]` |
| 2 | 60+ Miles from | 60+ Miles from ROW to DMS | `ROW@[632,434,678,451]`; `to@[683,437,699,451]`; `DMS@[705,434,744,451]` |
| 3 | & Haul 0-15 Miles from \| | & Haul 0-15 Miles from ROW to DMS. \| | `ROW@[643,488,708,504]`; `to@[692,484,709,512]`; `DMS.@[715,488,754,507]` |
| 5 | [i 60 from | [i 60 from ROW to DMS | `ROW@[634,645,679,662]`; `to@[683,648,699,662]`; `DMS@[705,647,746,663]` |
| 7 | Grinding and Debris | Grinding and Chipping Vegetative Debris | `Chipping@[612,751,689,772]`; `Vegetative@[693,752,781,771]` |
| 12 | 16-30 Miles from | 16-30 Miles from to, DMS | `to,@[706,1045,722,1061]`; `DMS@[729,1043,767,1059]` |
| 14 | 60+ Milgs from | 60+ Milgs from ROW to | `ROW@[636,1097,681,1112]`; `to@[685,1098,701,1112]` |
| 17 | _— - 176-30 osal, Miles from | _— - 176-30 osal, Miles from DMS to | `DMS@[658,1229,697,1245]`; `to@[703,1231,719,1245]` |
| 18 | 31-60 Miles from Dis posal | 31-60 Miles from DMS to Final Dis posal | `DMS@[658,1282,698,1298]`; `to@[703,1284,719,1297]`; `Final@[726,1280,764,1300]` |

## Remaining mismatch inventory

These are scorer-unmatched reference cells, not claims of missing authored text. Matched boxes can still contain damaged OCR text. No new OCR evidence, rate repair or existing-ownership override is claimed.

### golden-p8 — 58

| Label | Reference text | Existing first-boundary inventory |
|---|---|---|
| c-0003 | Unit | box_only_header_mismatch |
| c-0008 | $6.90 | ruling_line_or_noise_glyph_geometry |
| c-0006 | 0–15 Miles from ROW to DMS | phantom_ocr_header_column |
| c-0009 | Vegetative Collect, Remove & Haul from Unincorporated Neighborhoods | row_not_admitted |
| c-0012 | $7.90 | row_not_admitted |
| c-0010 | 16–30 Miles from ROW to DMS | row_not_admitted |
| c-0011 | Cubic Yard | row_not_admitted |
| c-0023 | Cubic Yard | ruling_line_or_noise_glyph_geometry |
| c-0024 | $13.50 | ruling_line_or_noise_glyph_geometry |
| c-0021 | Vegetative Collect, Remove & Haul from Rural Areas | wrong_column_membership |
| c-0022 | 0–15 Miles from ROW to DMS | phantom_ocr_header_column |
| c-0028 | $14.50 | row_not_admitted |
| c-0025 | Vegetative Collect, Remove & Haul from Rural Areas | row_not_admitted |
| c-0027 | Cubic Yard | row_not_admitted |
| c-0026 | 16–30 Miles from ROW to DMS | row_not_admitted |
| c-0029 | Vegetative Collect, Remove & Haul from Rural Areas | row_not_admitted |
| c-0030 | 31–60 Miles from ROW to DMS | row_not_admitted |
| c-0031 | Cubic Yard | row_not_admitted |
| c-0032 | $15.50 | row_not_admitted |
| c-0033 | Vegetative Collect, Remove & Haul from Rural Areas | wrapped_or_roleless_attachment |
| c-0038 | Single Cost from ROW to DMS -Any Distance | phantom_ocr_header_column |
| c-0040 | $10.90 | ruling_line_or_noise_glyph_geometry |
| c-0037 | Vegetative Collect, Remove & Haul | wrapped_or_roleless_attachment |
| c-0039 | Cubic Yard | wrong_column_membership |
| c-0044 | $2.25 | ruling_line_or_noise_glyph_geometry |
| c-0045 | Management & Reduction | wrapped_or_roleless_attachment |
| c-0046 | Air Curtain Burning of Vegetative Debris (if applicable/allowed) | phantom_ocr_header_column |
| c-0051 | Cubic Yard | wrong_column_membership |
| c-0050 | Open Burning of Vegetative Debris (if applicable/allowed) | phantom_ocr_header_column |
| c-0055 | Cubic Yard | row_not_admitted |
| c-0056 | $1.00 | row_not_admitted |
| c-0053 | Management & Reduction | row_not_admitted |
| c-0054 | Compacting Vegetative Debris | row_not_admitted |
| c-0060 | $1.50 | row_not_admitted |
| c-0059 | Cubic Yard | row_not_admitted |
| c-0058 | Preparation, Management, and segregating materials from recovery at DMS | row_not_admitted |
| c-0057 | Management & Reduction | row_not_admitted |
| c-0062 | 0–15 Miles from ROW to DMS | phantom_ocr_header_column |
| c-0063 | Cubic Yard | ruling_line_or_noise_glyph_geometry |
| c-0064 | $6.90 | ruling_line_or_noise_glyph_geometry |
| c-0061 | C&D Collect, Remove & Haul | wrapped_or_roleless_attachment |
| c-0065 | C&D Collect, Remove & Haul | wrapped_or_roleless_attachment |
| c-0070 | 31–60 Miles from ROW to DMS | phantom_ocr_header_column |
| c-0069 | C&D Collect, Remove & Haul | wrong_column_membership |
| c-0079 | Cubic Yard | wrong_column_membership |
| c-0078 | Single Cost from ROW to DMS -Any Distance | phantom_ocr_header_column |
| c-0082 | 0–15 Miles from DMS to Final Disposal | phantom_ocr_header_column |
| c-0088 | $3.75 | ruling_line_or_noise_glyph_geometry |
| c-0086 | 16–30 Miles from DMS to Final Disposal | phantom_ocr_header_column |
| c-0089 | Final Disposal | ruling_line_or_noise_glyph_geometry |
| c-0095 | Cubic Yard | row_not_admitted |
| c-0096 | $5.40 | row_not_admitted |
| c-0094 | 60+ Miles from DMS to Final Disposal | row_not_admitted |
| c-0093 | Final Disposal | row_not_admitted |
| c-0097 | Final Disposal | missing_or_damaged_ocr_rate |
| c-0099 | Cubic Yard | missing_or_damaged_ocr_rate |
| c-0100 | $5.40 | missing_or_damaged_ocr_rate |
| c-0098 | Single Cost – Any Distance | missing_or_damaged_ocr_rate |

### hillsdale-p3 — 3

| Label | Reference text | Existing first-boundary inventory |
|---|---|---|
| c-0039 | $320.00 | See R12 classification; unchanged except truck recovery |
| c-0038 | Hour | See R12 classification; unchanged except truck recovery |
| c-0037 | CAT D6 Dozer | See R12 classification; unchanged except truck recovery |

### dn-p106 — 2

| Label | Reference text | Existing first-boundary inventory |
|---|---|---|
| c-0001 | ITEMIZED PROPOSAL FOR CONTRACT NO. DN12189513 | See R12 classification; unchanged except truck recovery |
| c-0039 | 5 | See R12 classification; unchanged except truck recovery |

### dn-p107 — 9

| Label | Reference text | Existing first-boundary inventory |
|---|---|---|
| c-0001 | ITEMIZED PROPOSAL FOR CONTRACT NO. DN12189513 | See R12 classification; unchanged except truck recovery |
| c-0115 | 0014 | See R12 classification; unchanged except truck recovery |
| c-0116 | 6132000000-N | See R12 classification; unchanged except truck recovery |
| c-0117 | SP | See R12 classification; unchanged except truck recovery |
| c-0118 | Hazardous Tree Stump Removal =>24"- <48" | See R12 classification; unchanged except truck recovery |
| c-0120 | EA | See R12 classification; unchanged except truck recovery |
| c-0119 | 75 | See R12 classification; unchanged except truck recovery |
| c-0122 | 60,000.00 | See R12 classification; unchanged except truck recovery |
| c-0121 | 800.00 | See R12 classification; unchanged except truck recovery |

## Verification and artifacts

- Focused ownership tests: 24, including a discriminating slanted-rule negative that fails the old midpoint predicate.
- Raster binding tests: 5, covering exact PNG/config/frame binding and no primitive mutation.
- Final combined extraction/reconstruction/pricing/identity/render/recovery verification: **18 files, 370 tests passed**, including all 29 new focused tests. Real DN identity test ran with the source configured, not skipped. This is the scoped relevant slice, not a claim of full-repository verification.
- Historical guard: **1,991 pre-existing files unchanged**, excluding only the four explicitly edited existing production files. All four detector rule/grid outputs equal R12 v2 geometry exactly; new evidence-layer digests are separate identities, not regenerated pins.
- `npx tsc --noEmit` and `git diff --check` passed.
- Final approved four-page two-run replay: `C:/Dev/eightforge-os/.benchmark-review/_e3-r13-ownership/replay-approved`.
- Existing scorer, exact full remaining boxes, pricing snapshots, raw-ref/frozen checks, descriptions and source refs: `C:/Dev/eightforge-os/.benchmark-review/_e3-r13-ownership/verification-final/report.json` and sibling per-page files.
- Legacy replay script's “PREDICTION DRIFT” vs pre-R1 baseline is expected; acceptance compares R8/e2ff203 output and checks both current runs. No legacy pins were regenerated.
- Existing PDF.js font/WASM/CCITT fallback warnings remained non-failing. The unrelated Golden transaction-manifest CRLF test was not changed.

Focused verification commands (PowerShell, repository root):

```powershell
$env:DN_PRICED_SCHEDULE_SOURCE_PDF='C:/Users/ADMS Thompson/Desktop/EightForgeDocTrainning/Contract and Rates/DN12189513 CONTRACT.pdf'
$r13Tests = @(
  'lib/extraction/pdf/rulingLineOwnership.test.ts',
  'lib/server/rulingLineRaster.test.ts',
  'lib/extraction/pdf/pagePricedScheduleReconstruction.test.ts',
  'lib/extraction/pdf/ocrReconstructionParity.test.ts',
  'lib/extraction/pdf/pagePricedScheduleRecoveryReentry.test.ts',
  'lib/extraction/pdf/layoutObservationEvidence.test.ts',
  'lib/extraction/pdf/layoutObservationIdentity.test.ts',
  'lib/contracts/contractRateScheduleRows.pricingEligibility.test.ts',
  'lib/extraction/geometry/canonicalGeometryIdentityStability.test.ts',
  'lib/evaluation/canonicalGeometryDnIdentityStability.test.ts',
  'lib/evaluation/benchmark/benchmarkScoring.test.ts',
  'lib/evaluation/benchmark/benchmarkMachineRun.test.ts',
  'lib/evaluation/benchmark/benchmarkSuggestionRun.test.ts',
  'lib/extraction/pdf/ocrGeometryLayout.test.ts',
  'lib/extraction/pdf/renderDecodeInspection.test.ts',
  'lib/extraction/recovery/recoveryCandidateV2.test.ts',
  'lib/forgewing/tasks/recoveryCandidateV2.test.ts',
  'lib/server/forgewingRecoveryProposalPersistence.test.ts'
)
npx vitest run @r13Tests --maxWorkers=1 --testTimeout=120000
npx tsc --noEmit
git diff --check
```

Local ignored measurement harnesses: `_e3_baseline_replay.ts`, `_r13_verify.ts`, `_r13_history_guard.ts` under `.benchmark-workspace`; run with `npx vite-node --config vitest.config.ts`. Historical-output write guards require fresh output locations for a new measurement. The approved run paths above preserve this run's evidence.
