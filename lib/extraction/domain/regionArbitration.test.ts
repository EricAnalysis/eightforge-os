import { describe, expect, it } from 'vitest';
import {
  arbitrateRegion,
  buildRegionCandidate,
  REGION_ARBITRATOR,
  REGION_ARBITRATION_POLICY_V2,
} from '@/lib/extraction/domain/regionArbitration';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  MeasuredScore,
  ParserIdentity,
  RegionCandidate,
  SourceFragmentArtifact,
} from '@/lib/extraction/domain/types';

const SHA = 'c'.repeat(64);
const MANIFEST = 'd'.repeat(64);
const sourceId = opaqueIds.existingSourceArtifact('20000000-0000-4000-8000-000000000002');
const runId = opaqueIds.extractionRun({ sourceId, manifest: MANIFEST });
const pageId = opaqueIds.pageArtifact({ runId, page: 1 });

function token(text = 'Amount'): SourceFragmentArtifact {
  const box = {
    coordinate_space: 'page_normalized' as const,
    origin: 'top_left' as const,
    x0: 0.1,
    y0: 0.1,
    x1: 0.4,
    y1: 0.2,
    rotation: 0 as const,
  };
  return {
    id: opaqueIds.fragmentArtifact({ pageId, text }),
    organization_id: 'org-1',
    kind: 'token',
    extraction_run_id: runId,
    source_artifact_id: sourceId,
    page_artifact_id: pageId,
    source_document_id: 'document-1',
    source_sha256: SHA,
    parser_manifest_hash: MANIFEST,
    page: 1,
    bounding_box: box,
    raw_text: text,
    parser: { ...REGION_ARBITRATOR, stage: 'native_text' },
    recognition_confidence: 0.9,
    reading_order: 1,
  };
}

function parser(stage: ParserIdentity['stage'], name: string): ParserIdentity {
  return { ...REGION_ARBITRATOR, stage, name };
}

function candidate(
  id: string,
  sourceToken: SourceFragmentArtifact,
  rawText: string,
  quality: number,
  sourceParser: ParserIdentity,
  box = sourceToken.bounding_box,
): RegionCandidate {
  const artifactId = opaqueIds.fragmentArtifact({ kind: 'region_candidate', id });
  const measurement = (diagnostic: string): MeasuredScore => ({
    value: quality,
    calculator: sourceParser,
    basis_artifact_ids: [sourceToken.id],
    diagnostics: [diagnostic],
  });
  return {
    id: artifactId,
    organization_id: sourceToken.organization_id,
    kind: 'region',
    extraction_run_id: runId,
    source_artifact_id: sourceId,
    page_artifact_id: pageId,
    source_document_id: sourceToken.source_document_id,
    source_sha256: SHA,
    parser_manifest_hash: MANIFEST,
    page: 1,
    bounding_box: box,
    raw_text: rawText,
    parser: sourceParser,
    recognition_confidence: quality,
    reading_order: 1,
    region_role: 'text_block',
    child_fragment_ids: [sourceToken.id],
    ordered_token_ids: [sourceToken.id],
    engine_reported_confidence: quality,
    quality_signals: {
      glyph_validity: measurement('glyph'),
      geometry_coverage: measurement('geometry'),
      reading_order_consistency: measurement('order'),
      image_text_coverage: null,
    },
  };
}

describe('manifest-versioned region arbitration', () => {
  it('uses the documented calibratable thresholds', () => {
    expect(REGION_ARBITRATION_POLICY_V2).toMatchObject({
      comparison_iou_minimum: 0.5,
      comparison_containment_minimum: 0.8,
      winner_quality_margin_minimum: 0.15,
      high_quality_conflict_minimum: 0.75,
    });
  });

  it('constructs a deterministic source-only region candidate from one engine and page', () => {
    const first = token('Amount');
    const second = {
      ...token('Due'),
      id: opaqueIds.fragmentArtifact({ pageId, text: 'Due' }),
      reading_order: 2,
      bounding_box: { ...first.bounding_box, x0: 0.45, x1: 0.6 },
    };
    const left = buildRegionCandidate({ tokens: [first, second], region_role: 'text_block' });
    const right = buildRegionCandidate({ tokens: [first, second], region_role: 'text_block' });

    expect(left).toEqual(right);
    expect(left).toMatchObject({
      raw_text: 'Amount Due',
      ordered_token_ids: [first.id, second.id],
      region_role: 'text_block',
    });
  });

  it('creates consensus only for exact or normalized-equivalent text', () => {
    const sourceToken = token('Amount Due');
    const native = candidate(
      'native',
      sourceToken,
      'Amount Due',
      0.9,
      parser('native_text', 'native'),
    );
    const ocr = candidate(
      'ocr',
      sourceToken,
      ' Amount   Due ',
      0.88,
      parser('ocr', 'ocr'),
    );
    const result = arbitrateRegion({ candidates: [native, ocr], tokens: [sourceToken] });

    expect(result.decision).toMatchObject({
      decision: 'consensus',
      accepted_candidate_ids: expect.arrayContaining([native.id, ocr.id]),
    });
    expect(result.gap).toBeNull();
  });

  it('accepts a grounded single source and a clear winner over low-quality conflicts', () => {
    const sourceToken = token();
    const native = candidate(
      'native',
      sourceToken,
      'Amount',
      0.92,
      parser('native_text', 'native'),
    );
    expect(arbitrateRegion({ candidates: [native], tokens: [sourceToken] }).decision.decision)
      .toBe('single_source');

    const weak = candidate('weak', sourceToken, 'Arnount', 0.6, parser('ocr', 'ocr'));
    const result = arbitrateRegion({ candidates: [native, weak], tokens: [sourceToken] });
    expect(result.decision).toMatchObject({
      decision: 'single_source',
      accepted_candidate_ids: [native.id],
    });
    expect(result.gap).toBeNull();
  });

  it('persists conflict and gap when high-quality candidates disagree without margin', () => {
    const sourceToken = token();
    const native = candidate(
      'native',
      sourceToken,
      'Amount',
      0.9,
      parser('native_text', 'native'),
    );
    const ocr = candidate('ocr', sourceToken, 'Arnount', 0.86, parser('ocr', 'ocr'));
    const result = arbitrateRegion({ candidates: [native, ocr], tokens: [sourceToken] });

    expect(result.decision).toMatchObject({
      decision: 'conflict',
      accepted_candidate_ids: [],
    });
    expect(result.gap).toMatchObject({
      stage: 'region_arbitration',
      reason: 'arbitration_unresolved',
    });
  });

  it('does not compare candidates that miss overlap thresholds', () => {
    const sourceToken = token();
    const native = candidate(
      'native',
      sourceToken,
      'Amount',
      0.9,
      parser('native_text', 'native'),
    );
    const moved = candidate(
      'moved',
      sourceToken,
      'Amount',
      0.9,
      parser('ocr', 'ocr'),
      { ...sourceToken.bounding_box, x0: 0.6, x1: 0.9 },
    );
    const result = arbitrateRegion({ candidates: [native, moved], tokens: [sourceToken] });

    expect(result.decision.decision).toBe('unresolved');
    expect(result.gap?.reason).toBe('arbitration_unresolved');
  });

  it('rejects ungrounded vision text before any field candidate can be produced', () => {
    const sourceToken = token('Observed');
    const vision = candidate(
      'vision',
      sourceToken,
      'Invented',
      0.99,
      parser('vision', 'vision'),
    );
    const result = arbitrateRegion({ candidates: [vision], tokens: [sourceToken] });

    expect(result.decision).toMatchObject({
      decision: 'unresolved',
      accepted_candidate_ids: [],
    });
    expect(result.gap?.detail).toMatch(/exact supporting text/);
  });
});
