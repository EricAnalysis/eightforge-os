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
      engine_pages: (['native', 'ocr'] as const).map((engine) => ({
        page_number: 1,
        render_sha256: 'a'.repeat(64),
        width: 1224,
        height: 1584,
        text_detected: true,
        words: [{
          text: engine === 'native' ? 'Contract' : 'Contraet',
          confidence: engine === 'ocr' ? 91 : null,
          bbox: { x0: 10, y0: 20, x1: 80, y1: 42 },
        }],
        engine,
        parser: {
          stage: engine === 'native' ? 'native_text' as const : 'ocr' as const,
          name: engine,
          version: '1',
          configuration_hash: 'b'.repeat(64),
        },
      })),
    } as const;
    const observationsJson = JSON.stringify(observations);

    attachLocatedOcrObservations(payload, observations);

    expect(getLocatedOcrObservations(payload)).toBe(observations);
    expect(getLocatedOcrObservations(payload)?.engine_pages?.map((page) => page.engine))
      .toEqual(['native', 'ocr']);
    expect(JSON.stringify(payload)).toBe(legacyJson);
    expect(Object.keys(payload)).toEqual(['extraction', 'fields']);
    expect(JSON.stringify(observations)).toBe(observationsJson);
  });

  it('returns null for legacy payloads created without the sidecar', () => {
    expect(getLocatedOcrObservations({ extraction: { mode: 'pdf_text' } })).toBeNull();
  });
});
