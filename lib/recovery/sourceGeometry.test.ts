import { describe, expect, it } from 'vitest';

import { buildCanonicalPageFrame } from '@/lib/extraction/geometry/canonicalPageFrame';
import { historicalV1CoordinateSpace, toViewportRect } from '@/lib/recovery/sourceGeometry';
import type { VisualSourceBox } from '@/lib/recovery/visualSourceEvidence';

const native: VisualSourceBox = {
  observationId: 'obs:1', rawText: 'Disposal', role: 'candidate_member', memberIndex: 0,
  sourceLayer: 'pdf_native_text',
  boundingBox: { xMin: 10, xMax: 30, yMin: 100, yMax: 112 },
};
const page = {
  viewportWidth: 1224, viewportHeight: 1584, scale: 2,
  pageWidthPoints: 612, pageHeightPoints: 792,
};
/** What a pdf.js viewport reports for the same page, which E2 added to the viewer. */
const framed = { ...page, viewBox: [0, 0, 612, 792], userUnit: 1 };

describe('source evidence geometry', () => {
  it('flips native PDF Y coordinates into the top-left viewport', () => {
    expect(toViewportRect(native, page)).toEqual({
      left: 20, top: 1360, width: 40, height: 24,
    });
  });

  it('fails closed for OCR without exact source pixel dimensions', () => {
    expect(toViewportRect({ ...native, sourceLayer: 'ocr' }, page)).toBeNull();
  });

  it('scales OCR without flipping when exact source pixel dimensions exist', () => {
    expect(toViewportRect({ ...native, sourceLayer: 'ocr' }, {
      ...page, ocrPixelWidth: 612, ocrPixelHeight: 792,
    })).toEqual({ left: 20, top: 200, width: 40, height: 24 });
  });

  it('fails closed for rotated pages when no page frame is available', () => {
    expect(toViewportRect(native, { ...page, rotation: 90 })).toBeNull();
  });

  it('fails closed for invalid or out-of-page geometry', () => {
    expect(toViewportRect({ ...native,
      boundingBox: { xMin: 30, xMax: 10, yMin: 100, yMax: 112 } }, page)).toBeNull();
    expect(toViewportRect({ ...native,
      boundingBox: { ...native.boundingBox, yMax: 900 } }, page)).toBeNull();
    expect(toViewportRect({ ...native,
      boundingBox: { ...native.boundingBox, yMax: 900 } }, framed)).toBeNull();
  });
});

describe('historical v1 evidence with a page frame', () => {
  it('renders identically to the pre-frame path on an upright, uncropped page', () => {
    expect(toViewportRect(native, framed)).toEqual(toViewportRect(native, page));
    expect(toViewportRect({ ...native, sourceLayer: 'ocr' },
      { ...framed, ocrPixelWidth: 612, ocrPixelHeight: 792 }))
      .toEqual(toViewportRect({ ...native, sourceLayer: 'ocr' },
        { ...page, ocrPixelWidth: 612, ocrPixelHeight: 792 }));
  });

  it('renders native evidence on a rotated, cropped page instead of failing closed', () => {
    const rotated = {
      ...page, viewportWidth: 1500, viewportHeight: 1160, rotation: 90,
      viewBox: [20, 30, 600, 780], userUnit: 1,
    };
    // rotate 90 sends user +Y to canonical +X and user +X to canonical +Y.
    expect(toViewportRect({ ...native, boundingBox: { xMin: 120, xMax: 140, yMin: 230, yMax: 242 } },
      rotated)).toEqual({ left: 400, top: 200, width: 24, height: 40 });
  });

  it('renders OCR render pixels on a rotated page through the same frame', () => {
    const rotated = {
      ...page, viewportWidth: 1500, viewportHeight: 1160, rotation: 90,
      viewBox: [20, 30, 600, 780], userUnit: 1, ocrPixelWidth: 1500, ocrPixelHeight: 1160,
    };
    expect(toViewportRect({ ...native, sourceLayer: 'ocr',
      boundingBox: { xMin: 400, xMax: 424, yMin: 200, yMax: 240 } }, rotated))
      .toEqual({ left: 400, top: 200, width: 24, height: 40 });
  });

  it('reads the historical space from the v1 layer contract, in one place', () => {
    expect(historicalV1CoordinateSpace('pdf_native_text')).toBe('pdf_user_unrotated');
    expect(historicalV1CoordinateSpace('ocr')).toBe('ocr_render_px');
  });

  it('honours an explicit source coordinate space over the layer default', () => {
    const tagged: VisualSourceBox = {
      ...native, sourceLayer: 'ocr', sourceCoordinateSpace: 'pdf_user_unrotated',
    };
    // Tagged as native user space, so no OCR pixel dimensions are required.
    expect(toViewportRect(tagged, framed)).toEqual(toViewportRect(native, framed));
  });
});

describe('canonical_v1 evidence', () => {
  const frame = buildCanonicalPageFrame({ view: [20, 30, 600, 780], rotation: 90 })!;
  const rotated = {
    ...page, viewportWidth: frame.width * 2, viewportHeight: frame.height * 2, rotation: 90,
    viewBox: [20, 30, 600, 780], userUnit: 1,
  };

  it('is preferred when present, with no OCR dimension lookup', () => {
    const box: VisualSourceBox = {
      ...native, sourceLayer: 'ocr',
      boundingBox: { xMin: 400, xMax: 424, yMin: 200, yMax: 240 },
      canonicalBoundingBox: {
        coordinate_space: 'canonical_v1', x_min: 200, x_max: 212, y_min: 100, y_max: 120,
      },
    };
    expect(rotated.ocrPixelWidth).toBeUndefined();
    expect(toViewportRect(box, rotated)).toEqual({ left: 400, top: 200, width: 24, height: 40 });
  });

  it('fails closed for canonical geometry outside the canonical page', () => {
    const box: VisualSourceBox = {
      ...native,
      canonicalBoundingBox: {
        coordinate_space: 'canonical_v1', x_min: 200, x_max: frame.width + 5, y_min: 100, y_max: 120,
      },
    };
    expect(toViewportRect(box, rotated)).toBeNull();
  });
});
