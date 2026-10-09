import { describe, expect, it } from 'vitest';

import {
  classifyDifferenceOrigin,
  jsonDifferences,
  parseCorpusPins,
  stripVolatileExtractionFields,
  VOLATILE_EXTRACTION_PATHS,
} from '@/lib/evaluation/pinnedEvaluationCapture';

const SHA = 'a'.repeat(64);

describe('pinned evaluation capture', () => {
  it('removes exactly the enumerated wall-clock fields and nothing else', () => {
    const payload = {
      analyzed_at: '2026-10-07T00:00:00Z',
      status: 'ok',
      extraction: { content_layers_v1: { pdf: { page_extraction_coverage_v1: { performance: {
        native_extraction_ms: 1, preflight_ms: 2, ocr_ms: 3, total_through_reconciliation_ms: 4, ocr_pages_attempted: 4,
      } } } } },
    };
    const { data, removed } = stripVolatileExtractionFields(payload);
    expect(removed).toEqual(VOLATILE_EXTRACTION_PATHS);
    expect(data).toEqual({ status: 'ok', extraction: { content_layers_v1: { pdf: { page_extraction_coverage_v1: {
      performance: { ocr_pages_attempted: 4 } } } } } });
    // The input is never mutated.
    expect(payload.analyzed_at).toBe('2026-10-07T00:00:00Z');
  });

  it('accepts only strict pins: plain file names, exact hashes, unique labels and files', () => {
    const pins = parseCorpusPins({ schema: 'eightforge_eval_corpus_pins_v1', documents: [
      { label: 'Hillsdale', file: 'h.pdf', sha256: SHA }, { label: 'DN', file: 'dn.pdf', sha256: 'b'.repeat(64) },
    ] });
    expect(pins.documents.map((pin) => pin.label)).toEqual(['DN', 'Hillsdale']);
    const bad = (documents: unknown) => () => parseCorpusPins({ schema: 'eightforge_eval_corpus_pins_v1', documents });
    expect(bad([{ label: 'G', file: '../g.pdf', sha256: SHA }])).toThrow(/plain \.pdf file name/);
    expect(bad([{ label: 'G', file: 'C:\\g.pdf', sha256: SHA }])).toThrow(/plain \.pdf file name/);
    expect(bad([{ label: 'G', file: 'g.pdf', sha256: SHA.toUpperCase() }])).toThrow(/sha256/);
    expect(bad([{ label: 'G', file: 'g.pdf', sha256: SHA }, { label: 'G', file: 'h.pdf', sha256: SHA }])).toThrow(/duplicate label/);
    expect(bad([])).toThrow(/non-empty/);
    expect(() => parseCorpusPins({ documents: [] })).toThrow(/schema/);
  });

  it('localises differences and reports pure reordering as ordering, never as equal', () => {
    const a = { extraction: { content_layers_v1: { pdf: {
      layout_observations_v1: { observations: [{ id: 1 }, { id: 2 }] },
      priced_schedule_reconstruction_v1: { pages: [{ rows: 3 }] },
      ocr: { confidence: 0.9 },
    } } } };
    const b = { extraction: { content_layers_v1: { pdf: {
      layout_observations_v1: { observations: [{ id: 2 }, { id: 1 }] },
      priced_schedule_reconstruction_v1: { pages: [{ rows: 4 }] },
      ocr: { confidence: 0.8 },
    } } } };
    const differences = jsonDifferences(a, b);
    expect(differences.map((difference) => [difference.path, difference.kind, classifyDifferenceOrigin(difference)])).toEqual([
      ['extraction.content_layers_v1.pdf.layout_observations_v1.observations', 'reordered', 'ordering'],
      ['extraction.content_layers_v1.pdf.ocr.confidence', 'changed', 'ocr'],
      ['extraction.content_layers_v1.pdf.priced_schedule_reconstruction_v1.pages[0].rows', 'changed', 'reconstruction_geometry'],
    ]);
    expect(jsonDifferences(a, JSON.parse(JSON.stringify(a)))).toEqual([]);
  });
});
