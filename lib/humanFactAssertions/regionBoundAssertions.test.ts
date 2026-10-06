import { describe, expect, it } from 'vitest';

import { regionAssertionEntryTargets, reviewRequiredValueTargets, verifyRegionEvidence, withheldPricedLineTargets } from '@/lib/humanFactAssertions/regionBoundAssertions';

const DIGEST = 'a'.repeat(64);

function extraction(observations: unknown[], digest: string | null = DIGEST) {
  return {
    extraction: {
      content_layers_v1: {
        pdf: {
          page_extraction_coverage_v1: { pages: digest ? [{ page_number: 3, page_representation_digest: digest }] : [] },
          priced_schedule_reconstruction_v1: { parser_version: 'priced_schedule_reconstruction_v2', pages: [] },
          layout_observations_v1: { source_artifact_id: 'artifact-1', observations },
        },
      },
    },
  };
}

const observation = (id: string, rawText: string, page = 3) => ({ id, raw_text: rawText, physical_page_number: page });

describe('server-side region evidence verification (B3)', () => {
  it('reads the original source text from persisted observations, in cited order', () => {
    const result = verifyRegionEvidence({
      extractionData: extraction([observation('o1', 'sia'), observation('o2', '50')]),
      physicalPageNumber: 3, pageRepresentationDigest: DIGEST, sourceObservationIds: ['o1', 'o2'],
    });
    expect(result).toEqual({
      status: 'verified', originalSourceText: 'sia 50', sourceArtifactId: 'artifact-1',
      parserVersion: 'priced_schedule_reconstruction_v2',
    });
  });

  it('records no original text when the region cites no observations (extraction read nothing)', () => {
    const result = verifyRegionEvidence({
      extractionData: extraction([]), physicalPageNumber: 3, pageRepresentationDigest: DIGEST, sourceObservationIds: [],
    });
    expect(result).toMatchObject({ status: 'verified', originalSourceText: null });
  });

  it('rejects a region reviewed against a page representation that is no longer current', () => {
    expect(verifyRegionEvidence({
      extractionData: extraction([], 'b'.repeat(64)), physicalPageNumber: 3,
      pageRepresentationDigest: DIGEST, sourceObservationIds: [],
    })).toEqual({ status: 'rejected', reason: 'page_representation_not_current' });
    expect(verifyRegionEvidence({
      extractionData: extraction([], null), physicalPageNumber: 3,
      pageRepresentationDigest: DIGEST, sourceObservationIds: [],
    })).toEqual({ status: 'rejected', reason: 'page_representation_unknown' });
  });

  it('rejects observations that are absent, on another page, or ambiguous', () => {
    const check = (observations: unknown[]) => verifyRegionEvidence({
      extractionData: extraction(observations), physicalPageNumber: 3,
      pageRepresentationDigest: DIGEST, sourceObservationIds: ['o1'],
    });
    expect(check([])).toEqual({ status: 'rejected', reason: 'unknown_source_observation' });
    expect(check([observation('o1', 'x', 4)])).toEqual({ status: 'rejected', reason: 'unknown_source_observation' });
    expect(check([observation('o1', 'x'), observation('o1', 'y')]))
      .toEqual({ status: 'rejected', reason: 'unknown_source_observation' });
  });
});

describe('reviewed-value entry targets (B3)', () => {
  const ref = (id: string | null, text: string, x: number) => ({
    ...(id ? { observation_id: id } : {}), text, x_min: x, x_max: x + 10, y_min: 300, y_max: 310,
  });
  const data = (digest: string | null, refs: unknown[]) => ({
    extraction: { content_layers_v1: { pdf: {
      page_extraction_coverage_v1: { pages: digest ? [{ page_number: 3, page_representation_digest: digest }] : [] },
      priced_schedule_reconstruction_v1: {
        parser_version: 'priced_schedule_reconstruction_v2', pages: [],
        unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found', physical_page_number: 3,
          header_lines: [], priced_lines: [{ raw_text: 'Hauling $ sia 50', y: 300, source_refs: refs }] }],
      },
    } } },
  });

  it('offers each unresolved priced line with its current digest, observations and region', () => {
    const targets = regionAssertionEntryTargets(data(DIGEST, [ref('o1', 'Hauling', 10), ref('o2', 'sia 50', 400)]));
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      physicalPageNumber: 3, pageRepresentationDigest: DIGEST, unresolvedReason: 'header_not_found',
      rawText: 'Hauling $ sia 50', sourceObservationIds: ['o1', 'o2'],
      sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 10 }, { x_min: 400 }] },
    });
    expect(targets[0]!.anchorKey).toMatch(/^p3:priced_line:[0-9a-f]{32}$/);
    // Deterministic: the same evidence always yields the same anchor.
    expect(regionAssertionEntryTargets(data(DIGEST, [ref('o1', 'Hauling', 10), ref('o2', 'sia 50', 400)]))[0]!.anchorKey)
      .toBe(targets[0]!.anchorKey);
  });

  it('draws each line on its source page from the server-side extraction (B5-B)', () => {
    const withArtifact = (refs: unknown[]) => {
      const base = data(DIGEST, refs);
      const pdf = base.extraction.content_layers_v1.pdf as Record<string, unknown>;
      pdf.layout_observations_v1 = { source_artifact_id: 'artifact-1', observations: [] };
      return base;
    };
    // Without a document identity, or without a source artifact, no page is offered.
    expect(regionAssertionEntryTargets(withArtifact([ref('o1', 'Hauling', 10)]))[0]!.visual).toBeNull();
    expect(regionAssertionEntryTargets(data(DIGEST, [ref('o1', 'Hauling', 10)]), 'doc-1')[0]!.visual).toBeNull();
    const [target] = regionAssertionEntryTargets(withArtifact([ref('o1', 'Hauling', 10), ref('o2', 'sia 50', 400)]), 'doc-1');
    expect(target!.visual).toMatchObject({
      kind: 'diagnostic', diagnosticId: target!.anchorKey, sourceArtifactId: 'artifact-1', sourceDocumentId: 'doc-1',
      physicalPageNumber: 3, pageRepresentationDigest: DIGEST,
      boxes: [
        { observationId: 'o1', rawText: 'Hauling', boundingBox: { xMin: 10, xMax: 20, yMin: 300, yMax: 310 }, memberIndex: 0 },
        { observationId: 'o2', rawText: 'sia 50', boundingBox: { xMin: 400 }, memberIndex: 1 },
      ],
    });
  });

  it('offers nothing it cannot bind exactly', () => {
    expect(regionAssertionEntryTargets(data(null, [ref('o1', 'Hauling', 10)]))).toEqual([]);
    expect(regionAssertionEntryTargets(data(DIGEST, [ref('o1', 'Hauling', 10), ref(null, 'sia 50', 400)]))).toEqual([]);
  });
});

describe('withheld priced-line targets (Forgewing generalization, phase 1)', () => {
  const ref = (id: string, text: string, x: number) => ({ observation_id: id, text, x_min: x, x_max: x + 10, y_min: 300, y_max: 310 });
  const data = (unresolvedRefs: unknown[] | null, spineRefs: unknown[], unassigned: unknown[] = []) => ({
    extraction: { content_layers_v1: { pdf: {
      page_extraction_coverage_v1: { pages: [{ page_number: 3, page_representation_digest: DIGEST }] },
      priced_schedule_reconstruction_v1: {
        parser_version: 'priced_schedule_reconstruction_v3',
        pages: [{ physical_page_number: 3, status: 'reconstructed', rows: [], columns: [],
          rejected_spines: [{ reason: 'inconsistent_row_pitch', physical_page_number: 3, raw_text: 'Hauling $ 9.50', source_refs: spineRefs }],
          unassigned_lines: unassigned }],
        ...(unresolvedRefs ? { unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found',
          physical_page_number: 3, header_lines: [], priced_lines: [{ raw_text: 'Hauling $ 9.50', y: 300, source_refs: unresolvedRefs }] }] } : {}),
      },
    } } },
  });

  it('offers rejected spines and unpriced rows, never other unassigned lines, under the unread-line anchor scheme', () => {
    const spine = [ref('o1', 'Hauling', 10), ref('o2', '9.50', 400)];
    const extraction = data(null, spine, [
      { reason: 'unpriced_row', physical_page_number: 3, raw_text: 'Snow Removal 96.00/hr', y: 280, source_refs: [ref('o3', 'Snow', 10)] },
      { reason: 'unsupported_trailing_line', physical_page_number: 3, raw_text: 'Note', y: 260, source_refs: [ref('o4', 'Note', 10)] },
    ]);
    const targets = withheldPricedLineTargets(extraction);
    expect(targets.map((target) => [target.unresolvedReason, target.sourceObservationIds])).toEqual([
      ['inconsistent_row_pitch', ['o1', 'o2']], ['unpriced_row', ['o3']],
    ]);
    // The same evidence carries the same anchor whether it was unread or withheld.
    expect(targets[0]!.anchorKey).toBe(regionAssertionEntryTargets(data(spine, []))[0]!.anchorKey);
    // The unread-page selector itself is unchanged: it never offers withheld evidence.
    expect(regionAssertionEntryTargets(extraction)).toEqual([]);
  });
});

describe('review-required value targets (Forgewing generalization, phase 2)', () => {
  const ref = (id: string, text: string, x: number, source: 'pdfjs' | 'ocr_fallback') =>
    ({ observation_id: id, text, x_min: x, x_max: x + 8, y_min: 100, y_max: 110, source });
  const cell = (role: string, id: string, text: string, x: number, source: 'pdfjs' | 'ocr_fallback') =>
    ({ role, raw_text: text, source_refs: [ref(id, text, x, source)], x_min: x, x_max: x + 8, y_min: 100, y_max: 110 });
  const data = (rateSource: 'pdfjs' | 'ocr_fallback', semantic: 'resolved' | 'unresolved' = 'resolved') => {
    const base = extraction([]);
    base.extraction.content_layers_v1.pdf.priced_schedule_reconstruction_v1 = {
      parser_version: 'priced_schedule_reconstruction_v3',
      pages: [{
        physical_page_number: 3, status: 'reconstructed', semantic_status: semantic, columns: [],
        rejected_spines: [], unassigned_lines: [],
        rows: [{ row_index: 0, physical_page_number: 3, raw_text: 'Haul | CY | $8.75',
          x_min: 10, x_max: 140, y_min: 100, y_max: 110,
          cells: [cell('description', 'd1', 'Haul', 10, 'ocr_fallback'), cell('unit', 'u1', 'CY', 60, 'ocr_fallback'),
            cell('rate', 'r1', '$8.75', 100, rateSource)] }],
      }],
    } as never;
    return base;
  };

  it('offers a published row whose rate was read from a scan, bound to the whole row', () => {
    const [target] = reviewRequiredValueTargets(data('ocr_fallback'));
    expect(target).toMatchObject({ physicalPageNumber: 3, unresolvedReason: 'scanned_source',
      rawText: 'Haul | CY | $8.75', candidateRateRaw: '$8.75', sourceObservationIds: ['d1', 'u1', 'r1'] });
    expect(target!.anchorKey).toMatch(/^p3:priced_line:[0-9a-f]{32}$/u);
  });

  it('offers nothing for a native rate, or on a page whose semantics are unresolved (it publishes no rows)', () => {
    expect(reviewRequiredValueTargets(data('pdfjs'))).toEqual([]);
    expect(reviewRequiredValueTargets(data('ocr_fallback', 'unresolved'))).toEqual([]);
  });
});
