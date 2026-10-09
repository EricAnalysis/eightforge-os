# B4.6.1 Phase B: latency audit (2026-10-09)

B4.6 failed the pre-registered bar on median total wait (render + provider), which must be at most 3000 ms per class:

| Class | Median wait | Bar |
|---|---:|---:|
| `ocr_price_sheet` | 3561 ms | 3000 ms |
| dense scanned | 3016 ms | 3000 ms |

This audit asks where the time goes, and what can be cut without changing what is read. It uses the pinned corpus and no provider calls. Provider figures are the recorded B4.6 result (`docs/runbooks/b46-value-reading-result.md`).

## Where the time goes

**Render** (this host; B4.6.1 production crops; 5 runs per stage, median):

| Page | Document load | Page render (crop canvas) | PNG encode |
|---|---:|---:|---:|
| DN p107 (scanned) | 93 ms | 295 ms | 9 ms |
| Golden p8 (scanned) | 2 ms | 107 ms | 10 ms |
| Hillsdale p3 (scanned) | 2 ms | 483 ms | 17 ms |
| Hillsdale p1 (native text plus page image) | 1 ms | 605 ms | 9 ms |

Rendering is dominated by decoding the page's scanned image, which pdf.js must do in full for any crop of the page. Every request renders once from verified source bytes, and that is kept.

**Provider** (B4.6, `claude-sonnet-4-6`, production request shape):
- median 2618 to 3422 ms per document;
- about 92 output tokens per call (7,827 over 85 calls);
- input about 950 tokens per call.

Output length drives provider time. Most of the output is the free-text `rationale`.

## Changes (fixed before any B4.6.1 provider run)

1. **Renderer v2** (`value_reading_region_crop_v2`, carried forward from `e1eb5d3`). It paints only the crop rectangle instead of a full-page canvas followed by a copy, at the same scale and over the same rectangle.

   | Page | v1 median (p95) | v2 median (p95) |
   |---|---:|---:|
   | DN p107 | 307 (359) ms | 258 (348) ms |
   | Golden p8 | 128 (165) ms | 101 (126) ms |
   | Hillsdale p3 | 514 (640) ms | 473 (588) ms |

   All 83 bound crops still render to identical bytes on re-render. A fidelity test pins v2 against v1: fewer than 0.5% of channels differ, from glyph anti-aliasing only.
2. **Prompt `forgewing-priced-value-reading@v2`.** The rationale is now at most twelve words, where v1 allowed one or two sentences. Every value instruction, the output schema and the abstention rule are unchanged. The aim is fewer output tokens, which is the largest provider-time lever the request shape allows.

Both changes alter request identity: the crop renderer id, the render digest and the prompt version. **No B4.6.1 provider run has happened, so nothing goes stale.** After the contract is frozen, any further change to the crop, context, prompt, renderer or request identity makes earlier runs stale, and must be reported as such.

## What remains

The bar is fixed and is not relaxed here. On the B4.6 provider medians:
- DN p107 would sit at about 2.98 s with v2 render, before any saving from a shorter rationale;
- the price-sheet pages (Golden 3.4 s provider, Hillsdale 2.6 s provider plus 0.47 s render) are at or over the bar.

Whether v2 clears it is measured only by the qualification run. If the median bar still fails, the owner is the provider runtime. Under the B4.6 record, the next step is a separately versioned B4.6.2 (another model, with its own approval), or an owner decision that sets a new bar **before** that execution. Neither is taken here.
