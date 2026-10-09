# R13.1 — ruling-evidence canonical authority guard

Baseline: `12bcab1` (R13 `0540818` plus adversarial fix). R8 authority reference:
`e2ff203`, preserved R13 verification `*.pricing-before.json`, and ordinary
reconstruction without ruling inputs. No labels, source observations, OCR settings,
representation identities, pins, confirmations, or historical outputs changed.

## Audit and correction

R13 enriches resolved description cells and rebuilds structural row text including
role-less cells. Two consumers incorrectly treated that structural enrichment as
pricing authority: `buildPagePricedScheduleRows` and layout evidence `acceptedRefs`.

| Channel | Effect before guard | Guarded boundary |
| --- | --- | --- |
| Category/confidence/status | Added description words reclassify pricing | Project source-owned text before existing classifier |
| Rate matching/dedupe/grain | Description/category/route affect semantic keys | Restore every authoritative input, not just category |
| Quantity/unit/rate | Numeric roles are unchanged by R13, but inferred dimensions consume row text | Preserve original role cells and resolved-only row text |
| Physical pricing row ID | Already stable | Keep page and `row_index` unchanged |
| Accepted anchors/evidence | Rule-only refs enter accepted pricing observations | Same authoritative projection in `acceptedRefs` |
| Canonical facts/validators | Assembly, canonical adapter, billing keys and persisted evidence consume enriched pricing text | Existing downstream logic receives R8-equivalent pricing rows |

The shared `pricingAuthoritativeRow` view filters refs explicitly recorded by
`ruling_line_resolutions`, preserving the remaining ref order and exact source boxes.
It rebuilds affected cell text/unions and authoritative row text/unions from resolved
cells only, matching ordinary reconstruction. Untouched rows retain their objects.
Missing/malformed/duplicate ruling provenance abstains. Observation identity takes
precedence over restated coordinates. Structured rates cannot retain an excluded
amount/marker source. This is an input-authority guard, not a second pricing classifier.

Structural reconstruction is never edited. Rule refs remain durably materialized as
non-authoritative structural observations. Materialization or identity/geometry proof
is not reviewed promotion; no new confirmation or promotion route was introduced.

The confirmed category leak reproduces at Golden **pricing array index 6**, physical
reconstructed row `page_priced_schedule:p8:r7`:

- Before R13 / after guard: `Grinding and Debris`, `construction_demolition`.
- Structural evidence remains: `Grinding and Chipping Vegetative Debris`.
- Without the guard that enriched input yields `management_reduction`.

Eight Golden description cells remain enriched (row indices 2, 3, 5, 7, 12, 14,
17, 18). Their pricing descriptions, raw cells/text, source refs and geometry revert
to the independent ordinary reconstruction view. All 58 pricing rows compare equal
as complete objects to R8: Golden 17, Hillsdale 0 (semantics unresolved), DN p106 21,
DN p107 20. Accepted resolved-cell source-ref arrays also compare exactly on all four
pages. Hillsdale's recovered truck structure remains non-authoritative.

## Structural proof

Both fresh source/OCR replay runs per page are deterministic and byte-equivalent to
the preserved `12bcab1` adversarial replay. The existing scorer and 0.5 match threshold
are unchanged.

| Page | Matched/reference cells | Predicted cells | Cell F1 | Exact rows |
| --- | ---: | ---: | ---: | ---: |
| Golden p8 | 41/100 | 80 | .4556 | 1 |
| Hillsdale p3 | 120/123 | 120 | .9877 | 40 |
| DN p106 | 178/180 | 179 | .9916 | 23 |
| DN p107 | 171/180 | 171 | .9744 | 23 |
| Aggregate | **510/583** | **550** | **.9003** | **87/116** |

Remaining inventory unchanged: Golden 59, Hillsdale 3, p106 2, p107 9 (73 total).
No structural matches/recoveries lost. Frozen `spacing_only` output remains identical
with and without ruling inputs. No numeric pricing or pricing-row-count change.

## Verification and reproducibility

Fresh evidence, never replacing prior runs:
`C:/Dev/eightforge-os/.benchmark-review/_e3-r13-1-authority-guard/`.
The verification report compares complete pricing objects, accepted refs, historic R8
authority snapshots and `12bcab1` structural predictions. Identity-bearing integration
tests additionally prove rule refs remain materialized but excluded from accepted
anchors and pricing-cell evidence.

Evaluation-only local harness commands (ignored `.benchmark-workspace`):

```powershell
npx vite-node --config vitest.config.ts .benchmark-workspace/_e3_baseline_replay.ts C:/Dev/eightforge-os/.benchmark-review/_e3-r13-1-authority-guard/replay
npx vite-node --config vitest.config.ts .benchmark-workspace/_r131_verify.ts
npx vite-node --config vitest.config.ts .benchmark-workspace/_r131_leak_control.ts
```

The legacy replay returns nonzero for expected drift against pre-R1 predictions;
acceptance is the independently checked byte equality against `12bcab1`, not that
obsolete baseline. No pins were regenerated. Source PDF font/WASM/CCITT warnings
did not prevent successful replay/scoring or tests.

Targeted extraction/reconstruction/recovery/identity suites use
`npx vitest run <files> --maxWorkers=1 --testTimeout=120000` with
`DN_PRICED_SCHEDULE_SOURCE_PDF` set to the pinned local DN PDF. Downstream suites
cover pricing assembly/grain/authored corrections, canonical adapter/parity,
taxonomy and pricing-observation persistence. `npx tsc --noEmit` and
`git diff --check` are required before the one local commit.

Final results: 18 extraction/recovery/identity test files, **369 passing tests**;
10 focused/downstream pricing test files, **212 passing tests** (overlapping files
between the two slices). The seven new authority tests include a discriminating
untagged control that reproduces reclassification, complete pricing/anchor equality,
structural observation retention, all-role filtering, stable ordinary rows,
restated-ID protection, structured-amount abstention and malformed provenance.
`tsc --noEmit` and `git diff --check` both pass.

Independent extraction/truth review agreed on the shared projection rather than a
category-only guard; its two narrow findings (malformed structural metadata and
excluded structured amounts) were reconciled with focused negative coverage.
No broad authority/schema redesign or changes to downstream classifiers were needed.
