# Reconstruction v2 compatibility hardening

Accepted starting point: `4f0b26fe35d4fbd4f21b901c5a5e66842f5e508d` (R13.1).
Branch: `codex/e3-contract-prep-four-page-benchmark`. Local implementation only;
no provider calls, database migration, push, merge, or historical rewrite.

## Compatibility contract

New production output identifies itself as `priced_schedule_reconstruction_v2`.
This versions the current role-less structure, row-start admission, structured
rates, column assignment, table-edge structure, additive ruling ownership, and
R13.1 pricing-authority isolation. Explicit `continuationEvidence: 'spacing_only'`
continues to emit v1 and bypass ruling ownership; its historical identity pins
were not regenerated.

The persisted envelope remains
`content_layers_v1.pdf.priced_schedule_reconstruction_v1`. The storage key and the
inner parser identifier are independent contracts. Extraction already persists
the supplied reconstruction, so no storage migration is needed. Pricing,
observation binding, diagnostic reading, persistence projections, and corpus
evaluation now accept both reviewed versions and preserve their original tags.
Unknown versions cannot bind modern observation evidence. Existing unversioned
synthetic compatibility behavior is not promoted into modern evidence binding.

Raw OCR/native observations, representation keys, recovery candidate identities,
confirmations, and render/OCR cache identities are unchanged. New ruled v2 pages
add `ruling_line_resolution_digest`, binding the ruling evidence digest and exact
resolution list. This is a separate completeness checksum, not a replacement or
regeneration of any old identity. Serialized new reconstructions consequently
differ in version metadata, as intended; benchmark prediction bytes do not.

Future evaluation preparation manifests that include the parser version obtain
new preparation digests legitimately. Existing manifests, approvals, labels, and
confirmations are not rewritten or rebound. Historical v1 ruled records remain
readable without the new checksum. An absent legacy checksum cannot prove that a
plausible resolution list was not truncated; v2 closes this prospectively, not
retroactively by rewriting history.

## Fail-closed diagnostic

Whole-page ruling authority validation precedes row scoping. Missing, malformed,
duplicate, inconsistent, or checksum-incomplete metadata withholds page-derived
pricing and observation acceptance. It never deletes structural source words or
introduces a promotion path. The existing authoritative projection still supplies
all pricing fields and canonical classification; pricing logic is not duplicated.

`ruling_line_pricing_authority_withheld` carries:

- parser version, physical page, page index, and reconstruction envelope path;
- issue code and optional offending resolution index;
- affected row indexes and `pricing_withheld: true`;
- known source document/artifact IDs, source/render hashes, and ruling digest.

Issue codes distinguish missing/malformed ruling evidence, evidence digest
mismatch, missing/malformed/duplicate resolutions, inconsistent ownership,
missing/mismatched resolution digest, and an insufficient authoritative row.
Malformed cell-ref containers, duplicate row identities, and malformed nested
structured-rate refs produce diagnostics instead of throwing.

Production pricing preparation retains the structured reasons through analysis,
pipeline, and validator context. The document diagnostic read model also derives
them from the immutable extraction snapshot. Registry classification is blocking,
reconstruction-stage, engineering diagnostic, with no recovery/promotion type.
If an OCR page-representation digest is unavailable, the diagnostic uses document
scope and records the affected page in structured detail. It does not substitute
a render hash for an observation digest or weaken the existing page-identity guard.
Only the new diagnostic class additionally binds this context into its identity,
keeping separate page failures distinguishable without changing historical IDs.

## Measured proof

Four pages were replayed twice against unchanged labels/scorer. All eight
prediction files are byte-identical to the accepted R13.1 output. Results:

| Page | Matched/reference cells | Predicted cells | Cell F1 | Exact rows | Pricing rows |
| --- | ---: | ---: | ---: | ---: | ---: |
| Golden p8 | 41/100 | 80 | .4556 | 1 | 17 |
| Hillsdale p3 | 120/123 | 120 | .9877 | 40 | 0 |
| DN p106 | 178/180 | 179 | .9916 | 23 | 21 |
| DN p107 | 171/180 | 171 | .9744 | 23 | 20 |
| Aggregate | 510/583 | 550 | .9003 | 87/116 | 58 |

Full pricing objects and accepted source refs equal the R8 authority snapshots:
category, rate/key/row identity, quantity/unit, descriptions, geometry, and pricing
evidence are unchanged. Hillsdale's unresolved semantic roles still yield no
pricing rows. R13 structural enrichment remains intact. Remaining unmatched cells
are unchanged: Golden 59, Hillsdale 3, p106 2, p107 9 (73 total).

773 historical files under the local benchmark-review directory were hashed
before and after: all byte-identical. Fresh evaluation artifacts were written
only to `.benchmark-review/_extraction-v2-compatibility/`.

## Verification commands and results

The local ignored source harnesses reuse existing reconstruction and scorer code:

```powershell
npx vite-node --config vitest.config.ts .benchmark-workspace/_v2_history.ts before
npx vite-node --config vitest.config.ts .benchmark-workspace/_e3_baseline_replay.ts C:/Dev/eightforge-os/.benchmark-review/_extraction-v2-compatibility/replay
npx vite-node --config vitest.config.ts .benchmark-workspace/_v2_verify.ts
npx vite-node --config vitest.config.ts .benchmark-workspace/_v2_history.ts after
npx tsc --noEmit
npm run build
git diff --check
```

Replay's legacy pre-R1 `PREDICTION DRIFT` sentinel is expected; acceptance compares
against `4f0b26f`, including direct SHA-256 checks of both prediction runs. Final
authority/scoring proof is in `verification-final/report.json` in the fresh task
directory. Typecheck, build, and diff check passed. Build retains two non-failing
PDF.js worker externalization warnings.

33 targeted Vitest suites passed, 643 tests, with `--maxWorkers=1
--testTimeout=120000` and the real DN source PDF supplied through
`DN_PRICED_SCHEDULE_SOURCE_PDF`. The slice covers authority/version, ruling
ownership/raster, reconstruction/native-OCR parity, recovery re-entry,
observation evidence/identity/canonical geometry, pricing eligibility/anchors,
frozen identity pins and real DN identity stability, benchmark scorer/projection,
recovery candidate/provider/persistence guards, pricing assembly/grain/authored
corrections, canonical adapters, taxonomy, pricing persistence, diagnostics,
cache keys, evaluation preparation, and PDF fallback gates.

One narrow test compatibility reconciliation was needed: pre-R13 PDF fallback
canvas mocks lacked `loadImage`, `drawImage`, and `getImageData`. Their blank
synthetic raster APIs now model those operations. No production raster behavior,
OCR coverage guard, or existing assertion was weakened. The complete targeted
slice passed after that correction; no timeout or skipped gate is counted as a
pass. Independent read-only review found no remaining scoped blocker.

Implementation outcome: versioned current semantics, explicit withheld-authority
reasons, preserved structural evidence and operator promotion boundary, unchanged
historical evidence and benchmark/pricing behavior.
