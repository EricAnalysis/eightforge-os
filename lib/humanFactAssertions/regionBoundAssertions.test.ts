import { describe, expect, it } from 'vitest';

import { regionAssertionEntryTargets, verifyRegionEvidence } from '@/lib/humanFactAssertions/regionBoundAssertions';

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
