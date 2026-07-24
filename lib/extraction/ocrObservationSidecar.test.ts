import { describe, expect, it } from 'vitest';
import {
  attachLocatedOcrObservations,
  getLocatedOcrObservations,
} from '@/lib/extraction/ocrObservationSidecar';

describe('located OCR observation sidecar', () => {
  it('keeps observations available in memory without changing legacy JSON', () => {
    const payload = {
      extraction: { mode: 'ocr_recovery' },
      fields: {},
    };
    const legacyJson = JSON.stringify(payload);
    const observations = {
      pages: [{
        page_number: 1,
        render_sha256: 'a'.repeat(64),
        width: 1224,
        height: 1584,
        text_detected: true,
        words: [{
          text: 'Contract',
          confidence: 91,
          bbox: { x0: 10, y0: 20, x1: 80, y1: 42 },
        }],
      }],
    } as const;

    attachLocatedOcrObservations(payload, observations);

    expect(getLocatedOcrObservations(payload)).toBe(observations);
    expect(JSON.stringify(payload)).toBe(legacyJson);
    expect(Object.keys(payload)).toEqual(['extraction', 'fields']);
  });

  it('returns null for legacy payloads created without the sidecar', () => {
    expect(getLocatedOcrObservations({ extraction: { mode: 'pdf_text' } })).toBeNull();
  });
});
