# canonical_frame_v1 — Extraction Evidence V2, E2

**Status:** implemented, additive only. **Date:** 2026-09-17.
**Module:** `lib/extraction/geometry/canonicalPageFrame.ts` (the only place transform math lives).

## The frame

| Property | Value |
|---|---|
| Page box | the viewer-visible crop box (pdf.js `page.view`) |
| Rotation | the page's `/Rotate`, applied |
| Origin | top-left |
| Axes | +X right, +Y down |
| Units | PDF points (times the page UserUnit) |
| Clipping | boxes clipped to the canonical page bounds |

This is identical to a pdf.js `page.getViewport({ scale: 1 })` coordinate space, and the
module reproduces that viewport transform as pure math. It is verified against the real
pdf.js viewport for `/Rotate` 0/90/180/270 crossed with a crop box and an offset media box,
and over the rotated corpus.

## Coordinate spaces

Every box crossing an extraction or viewer boundary carries an explicit `coordinate_space`.
Nothing infers a space from a source layer, extractor or field presence.

| Tag | Meaning |
|---|---|
| `canonical_v1` | the frame above |
| `pdf_user_unrotated` | historical native pdf.js geometry: PDF user space, bottom-left origin, rotation and crop not applied |
| `ocr_render_px` | historical OCR geometry: top-left pixels of a render of the viewer-visible, rotated page |

The one exception is persisted **v1** evidence, which predates the tag. Its space comes from
the layer contract it was written under, resolved in exactly one place:
`historicalV1CoordinateSpace` in `lib/recovery/sourceGeometry.ts`.

## The additive rule

Source geometry is immutable and keeps its historical meaning. Canonical geometry is a
derived, normalized view carried beside it, never in place of it.

This is not a style preference. Recovery candidate digests, V2 proposal IDs and digests, V1
proposal digests and reviewed-confirmation binding are hashes over source geometry, and
layout observations are compared byte-exactly against reconstruction refs. Rewriting a box
in place would move reviewed evidence and break those bindings.

**Canonical geometry is used for:** native/OCR duplicate detection and reconciliation,
viewer and source-highlight mapping, cross-extractor alignment, and future derived structure.

**Source geometry remains what is used for:** candidate evidence serialization, proposal
persistence, proposal and review digest verification, reconstruction-reference exact-match
checks, and any historical v1/v2 binding.

Persisted canonical geometry lives in the `canonical_geometry_v1` sidecar on the
layout-observations layer. Each entry restates the source box it was derived from, so a
consumer may only adopt canonical geometry for evidence whose source box still matches.
No persisted data was migrated.

## Boundary

E2 is additive geometry normalization only. Moving canonical geometry *into*
identity-bearing recovery or proposal structures is deferred to the planned versioned
identity work (E9 / RecoveryCandidateV3 or equivalent), which requires an explicit identity
transition and human re-review. Do not pull that work forward.

## Known transitional geometry debt

- The legacy pixel-based structural table extractor still consumes legacy OCR coordinates.
  Untouched by E2 by design; transitional until E10.
- `nativeEnginePages` in `lib/server/documentExtraction.ts` (the step-3 located-tokens
  compliance path) still projects native tokens to render pixels assuming an upright,
  uncropped page.
- `reconciled_pdf_points` OCR layout coordinates remain bottom-left PDF points derived from
  the rotated page height. They are historical inputs, not canonical.
- The page representation digest does not bind the page box or rotation, so two otherwise
  identical pages at different rotations hash alike.
