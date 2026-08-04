# Canonical Pricing-Dimension Interpretation — Revised 2026-08-01

## Decision

**READY FOR CODE REVIEW**

The revision contains the shared parser to contract pricing assembly and authored-correction post-processing. Exhibit A recovery and `billingKeys` retain their exact pre-slice detector behavior because neither consumer was byte-compatible with the shared parser.

No UI, Project Facts, persistence, migration, extraction-arbitration, table-header, Validator-rule, finding-generation, exposure, or reader behavior was changed. Nothing was committed or pushed.

## Accepted interpretation changes

- `pricingDimensions.ts` remains source-neutral: no fixture, filename, document family, page, row, rate, or expected-count branches.
- Contract assembly parses source-backed pricing descriptions, applies an authored correction, then reparses the corrected description when it changes.
- Canonical adaptation preserves typed route/distance values, raw spans, derivation source, and evidence. Authored corrections remain approval blockers.
- Candidate presence remains distinct from selected governing-row identity in the shadow semantic model. No Validator reader consumes that model.
- The earlier invoice identity, source-coordinate, billing-key adaptation, and unanimous-governing-document corrections remain intact.

## Reverted or contained behavior

### Exhibit A

Shared-parser delegation was removed from Exhibit A recovery because its `60+` recognition was not exactly compatible with the pre-slice recovery boundary. The existing Exhibit detector is retained unchanged. This restores both `$10.90` rows to `Raw row needs review`; contract assembly may still expose source-backed route/distance, but canonical description resolution remains unsettled and approval remains false with `description_unresolved`.

### Billing matcher

`billingKeys.ts` route and numeric-range detection was restored verbatim to its pre-slice implementation. It does not import or call the shared parser. Billing-rate keys, description keys, candidate-score bonuses, selection, cross-document verification, findings, exposure, and approval outcomes are unchanged.

A 39-string diagnostic corpus calls the production compatibility seam and pins unordered/non-adjacent route tokens, arbitrary and reversed ranges, first-of-multiple-range behavior, malformed OCR, date/invoice-like ranges, `60+`, exact/up-to expressions, and ordinary bands. The corpus confirms the legacy trigger set, including the intentionally unsafe-but-preserved historical parsing of arbitrary numeric ranges; this slice does not silently revise matcher semantics.

## Golden five-row differential

Real production path:

`extractDocument → runDocumentPipeline → assembleContractPricingRows → canonical adaptation/resolution`

Source PDF SHA-256: `922161a533bb6b8c1afb52cb9536044c8a6836bed62401634f4f505025631e8f`.

| Row | Intended status | Post-revision result |
|---|---|---|
| `$6.90`, `p8:t26:r2` | intended | Corrected description, `ROW to DMS`, `0 to 15 Miles`; authored correction true; needs review; approval false |
| `$3.25`, `p8:t31:r1` | intended | Corrected description, `DMS to Final Disposal`, `0 to 15 Miles`; authored correction true; needs review; approval false |
| `$5.40`, `p8:t32:r1` | intended | Corrected description, `DMS to Final Disposal`, `60+ Miles`; authored correction true; needs review; approval false |
| `$10.90` Vegetative, `p8:t27:r2` | promotion reverted | `Raw row needs review`; route/distance remain source-backed; needs review; approval false; `description_unresolved` |
| `$10.90` C&D, `p8:t30:r6` | promotion reverted | `Raw row needs review`; route/distance remain source-backed; needs review; approval false; `description_unresolved` |

The checked artifact `lib/evaluation/fixtures/goldenPricingFiveRowDifferential.json` records reviewed before-state, expected post-revision state, and aggregate parity. Production code contains none of these row identities, pages, rates, or aggregate counts.

## Golden aggregate parity

| Metric | Pre-slice baseline | Rejected intermediate | Post-revision |
|---|---:|---:|---:|
| rate-schedule rows | 105 | 104 | 105 |
| assembler outputs / candidates | 90 | 90 | 90 |
| resolved / approval-eligible | 56 | 58 | 56 |
| needs review / ineligible | 34 | 32 | 34 |
| excluded | 0 | 0 | 0 |
| merged or deduped | 15 | 14 | 15 |
| silently lost | 0 | 0 | 0 |

The strict real-fixture test passed all counts and all five row projections. The two `$10.90` rows did not leave review. No approved outcome changed.

## Verification

- Focused contract/canonical/billing regression: 5 files, 214 tests passed.
- Full `lib/validator lib/contracts` gate: 47 files, 621 tests passed.
- Full `lib/canonical` gate: 6 files, 90 tests passed.
- Final billing differential rerun: 39 tests passed, including the real malformed `-16 Miles from R OW...` OCR string remaining null.
- Golden real production differential: 1 passed, 3 unrelated fixtures skipped by filter; exact 105/90/56/34/0/15/0 ledger passed.
- `npx tsc --noEmit`: passed after the final containment edits.
- ESLint over all slice TypeScript files with `--max-warnings=0`: passed.
- `npm run build`: passed; Turbopack emitted the existing `pdfjs-dist` external-package warning.
- `git diff --check`: passed; only working-copy line-ending notices were emitted.

Known non-fatal real-extraction diagnostics: local OCR emitted PDF decoder warnings and optional vision supplementation reported missing credentials; deterministic local extraction completed and the strict assertions passed.

## Exact next boundary

Review this contained interpretation slice only. A future consolidation of Exhibit recovery or `billingKeys` requires its own explicit compatibility corpus, scoring/finding impact measurement, and approval. Do not cut over readers or Validator behavior in this slice.
