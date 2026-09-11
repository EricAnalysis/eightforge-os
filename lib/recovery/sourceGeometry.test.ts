import { describe, expect, it } from 'vitest';

import { toViewportRect } from '@/lib/recovery/sourceGeometry';
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

  it('fails closed for rotated pages', () => {
    expect(toViewportRect(native, { ...page, rotation: 90 })).toBeNull();
  });

  it('fails closed for invalid or out-of-page geometry', () => {
    expect(toViewportRect({ ...native,
      boundingBox: { xMin: 30, xMax: 10, yMin: 100, yMax: 112 } }, page)).toBeNull();
    expect(toViewportRect({ ...native,
      boundingBox: { ...native.boundingBox, yMax: 900 } }, page)).toBeNull();
  });
});
