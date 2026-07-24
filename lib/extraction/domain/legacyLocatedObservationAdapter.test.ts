import { describe, expect, it } from 'vitest';
import { adaptLegacyExtractionToStep1Shadow } from '@/lib/extraction/domain/legacyLocatedObservationAdapter';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  buildLegacyShadowParserManifest,
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';
import type {
  ExtractionRun,
  SourceArtifact,
} from '@/lib/extraction/domain/types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_HASH = 'a'.repeat(64);
const PARSER_MANIFEST = buildLegacyShadowParserManifest({
  analysisMode: 'deterministic',
  unstructuredEnabled: false,
  visionEnabled: false,
  typedAiEnabled: false,
  implementationBuild: 'adapter-test-build',
  verificationPolicy: 'step1_span_verified',
});
const MANIFEST_HASH = hashParserManifest(PARSER_MANIFEST);

function fixture() {
  const sourceArtifact: SourceArtifact = {
    id: opaqueIds.existingSourceArtifact('10000000-0000-4000-8000-000000000001'),
    organization_id: 'org-1',
    source_document_id: 'document-1',
    source_sha256: SOURCE_HASH,
    storage_object_version: 'object-1:version-1',
    media_type_sniffed: 'application/pdf',
    byte_length: 100,
    created_at: '2026-07-24T00:00:00.000Z',
  };
  const run: ExtractionRun = {
    id: opaqueIds.extractionRun({
      source_artifact_id: sourceArtifact.id,
      parser_manifest_hash: MANIFEST_HASH,
      idempotency_key: 'fixture',
    }),
    organization_id: 'org-1',
    semantic_key: 'semantic-1',
    attempt_number: 1,
    source_artifact_id: sourceArtifact.id,
    parser_manifest_hash: MANIFEST_HASH,
    artifact_schema_version: 'extraction-artifact-v1',
    status: 'partial_terminal',
  };
  return { sourceArtifact, run };
}

describe('shadow-only legacy located-observation adapter', () => {
  it('derives opaque UUIDs deterministically from kind and semantic identity', () => {
    const identity = { source_document_id: 'document-1', page: 2 };
    expect(opaqueIds.pageArtifact(identity)).toBe(opaqueIds.pageArtifact(identity));
    expect(opaqueIds.pageArtifact(identity)).not.toBe(opaqueIds.fragmentArtifact(identity));
    expect(opaqueIds.pageArtifact(identity)).toMatch(UUID_PATTERN);
    expect(() => opaqueIds.existingSourceArtifact('source-1')).toThrow(
      'source artifact identity must be a UUID',
    );
  });

  it('converts only geometry-complete OCR words through verified dependency closure', async () => {
    const { sourceArtifact, run } = fixture();
    const result = await adaptLegacyExtractionToStep1Shadow({
      sourceArtifact,
      parserManifest: PARSER_MANIFEST,
      parserManifestHash: run.parser_manifest_hash,
      artifactSchemaVersion: run.artifact_schema_version,
      idempotencyKey: 'job:1',
      completedAt: '2026-07-24T00:00:00.000Z',
      locatedObservations: [{
        page: 2,
        page_width: 1000,
        page_height: 2000,
        render_sha256: 'c'.repeat(64),
        parser: {
          stage: 'ocr',
          name: 'legacy-tesseract',
          version: '5',
          configuration_hash: 'd'.repeat(64),
        },
        text: '  Total  ',
        confidence: 92,
        bbox: { x0: 100, y0: 400, x1: 250, y1: 450 },
      }],
    });

    expect(result).toMatchObject({
      pages: [{ page: 2, status: 'processed' }],
      fragments: [{
        raw_text: '  Total  ',
        recognition_confidence: 0.92,
        bounding_box: {
          coordinate_space: 'page_normalized',
          x0: 0.1,
          y0: 0.2,
          x1: 0.25,
          y1: 0.225,
        },
      }],
      candidates: [{
        proposed_value: { type: 'text', value: '  Total  ' },
        transformations: [],
        confidence: {
          version: 'extraction-confidence-v1',
          recognition: { state: 'observed', score: 0.92 },
          geometry_alignment: { state: 'observed', score: 1 },
          parse_normalization: { state: 'observed', score: 1 },
          cross_engine_agreement: { state: 'not_available', score: null },
          overall: 0.85,
          uncertainties: ['single_engine_only'],
        },
      }],
      gaps: [],
      skippedRecordCount: 0,
    });
    expect(result.run.status).toBe('complete');
    expect(result.snapshot.status).toBe('complete');
    expect(result.members.map((member) => member.member_kind)).toEqual([
      'page',
      'fragment',
      'candidate',
      'verified_field',
    ]);
    expect(result.verifiedFields).toHaveLength(1);
    expect(result.verifiedFields[0]?.source_fragment_ids).toEqual([
      result.fragments[0]?.id,
    ]);
    expect(result.verifiedFields[0]?.raw_text).toBe('  Total  ');
    for (const id of [
      result.pages[0]?.id,
      result.fragments[0]?.id,
      result.candidates[0]?.id,
      result.verifiedFields[0]?.id,
    ]) {
      expect(id).toMatch(UUID_PATTERN);
    }
  });

  it('emits explicit gaps and no fields for unlocated or invalid legacy output', async () => {
    const { sourceArtifact, run } = fixture();
    const parser = {
      stage: 'ocr' as const,
      name: 'legacy-tesseract',
      version: '5',
      configuration_hash: 'f'.repeat(64),
    };
    const result = await adaptLegacyExtractionToStep1Shadow({
      sourceArtifact,
      parserManifest: PARSER_MANIFEST,
      parserManifestHash: run.parser_manifest_hash,
      artifactSchemaVersion: run.artifact_schema_version,
      idempotencyKey: 'job:2',
      locatedObservations: [
        {
          page: 1,
          page_width: 612,
          page_height: 792,
          render_sha256: 'e'.repeat(64),
          parser,
          text: 'No box',
          confidence: 80,
        },
        {
          page: 1,
          page_width: 612,
          page_height: 792,
          render_sha256: 'e'.repeat(64),
          parser,
          text: 'Outside page',
          confidence: 80,
          bbox: { x0: 10, y0: 10, x1: 700, y1: 20 },
        },
      ],
      unlocatedOutputs: [
        { category: 'typed_ai_field_without_citation', page: null },
      ],
    });

    expect(result.pages).toMatchObject([{ page: 1, status: 'partial' }]);
    expect(result.fragments).toEqual([]);
    expect(result.candidates).toEqual([]);
    expect(result.verifiedFields).toEqual([]);
    expect(result.gaps).toHaveLength(3);
    expect(result.skippedRecordCount).toBe(3);
    expect(result.run.status).toBe('partial_terminal');
    expect(result.snapshot.status).toBe('partial');
    expect(result.gaps).toEqual(result.gaps.map(() => expect.objectContaining({
      stage: 'field_verification',
      retryable: false,
      bounding_box: null,
      upstream_artifact_ids: [],
    })));
    expect(result.gaps.map((gap) => gap.reason)).toEqual([
      'missing_geometry',
      'missing_geometry',
      'no_source_span',
    ]);
  });

  it('does not manufacture fields when page geometry or render identity is missing', async () => {
    const { sourceArtifact, run } = fixture();
    const result = await adaptLegacyExtractionToStep1Shadow({
      sourceArtifact,
      parserManifest: PARSER_MANIFEST,
      parserManifestHash: run.parser_manifest_hash,
      artifactSchemaVersion: run.artifact_schema_version,
      idempotencyKey: 'job:3',
      locatedObservations: [{
        page: 3,
        page_width: null,
        page_height: 792,
        render_sha256: null,
        parser: {
          stage: 'ocr',
          name: 'legacy-tesseract',
          version: '5',
          configuration_hash: 'f'.repeat(64),
        },
        text: 'Unlocated',
        confidence: null,
        bbox: { x0: 10, y0: 10, x1: 20, y1: 20 },
      }],
    });

    expect(result.pages).toEqual([]);
    expect(result.verifiedFields).toEqual([]);
    expect(result.gaps).toMatchObject([{
      page: 3,
      reason: 'missing_geometry',
    }]);
  });

  it('retains every rendered OCR page and does not infer blank verification', async () => {
    const { sourceArtifact, run } = fixture();
    const parser = {
      stage: 'ocr' as const,
      name: 'legacy-tesseract',
      version: '5',
      configuration_hash: 'f'.repeat(64),
    };
    const common = {
      sourceArtifact,
      parserManifest: PARSER_MANIFEST,
      parserManifestHash: run.parser_manifest_hash,
      artifactSchemaVersion: run.artifact_schema_version,
      idempotencyKey: 'job:empty-pages',
      locatedObservations: [],
    };
    const blank = await adaptLegacyExtractionToStep1Shadow({
      ...common,
      locatedPages: [{
        page: 1,
        page_width: 100,
        page_height: 200,
        render_sha256: 'e'.repeat(64),
        parser,
        text_detected: false,
      }],
    });
    expect(blank.pages).toMatchObject([{ page: 1, status: 'partial' }]);
    expect(blank.gaps).toMatchObject([{ page: 1, reason: 'missing_geometry' }]);

    const missingWords = await adaptLegacyExtractionToStep1Shadow({
      ...common,
      locatedPages: [{
        page: 2,
        page_width: 100,
        page_height: 200,
        render_sha256: 'd'.repeat(64),
        parser,
        text_detected: true,
      }],
    });
    expect(missingWords.pages).toMatchObject([{ page: 2, status: 'partial' }]);
    expect(missingWords.gaps).toMatchObject([{
      page: 2,
      reason: 'missing_geometry',
    }]);
  });

  it('converges across reordered observations and different idempotency keys', async () => {
    const { sourceArtifact, run } = fixture();
    const parser = {
      stage: 'ocr' as const,
      name: 'legacy-tesseract',
      version: '5',
      configuration_hash: 'f'.repeat(64),
    };
    const observations = [
      {
        page: 1,
        page_width: 100,
        page_height: 100,
        render_sha256: 'e'.repeat(64),
        parser,
        text: 'Second',
        confidence: 80,
        bbox: { x0: 40, y0: 10, x1: 70, y1: 20 },
      },
      {
        page: 1,
        page_width: 100,
        page_height: 100,
        render_sha256: 'e'.repeat(64),
        parser,
        text: 'First',
        confidence: 90,
        bbox: { x0: 10, y0: 10, x1: 30, y1: 20 },
      },
    ] as const;
    const base = {
      sourceArtifact,
      parserManifest: PARSER_MANIFEST,
      parserManifestHash: run.parser_manifest_hash,
      artifactSchemaVersion: run.artifact_schema_version,
      completedAt: '2026-07-24T00:00:00.000Z',
    };

    const first = await adaptLegacyExtractionToStep1Shadow({
      ...base,
      idempotencyKey: 'job:first',
      locatedObservations: observations,
    });
    const second = await adaptLegacyExtractionToStep1Shadow({
      ...base,
      idempotencyKey: 'job:retry',
      locatedObservations: [...observations].reverse(),
    });

    expect(first.run.id).toBe(second.run.id);
    expect(first.fragments.map((fragment) => fragment.raw_text)).toEqual(['First', 'Second']);
    expect(first.pages.map((page) => page.id)).toEqual(second.pages.map((page) => page.id));
    expect(first.fragments.map((fragment) => fragment.id)).toEqual(
      second.fragments.map((fragment) => fragment.id),
    );
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(
      second.candidates.map((candidate) => candidate.id),
    );
    expect(first.verifiedFields.map((field) => field.id)).toEqual(
      second.verifiedFields.map((field) => field.id),
    );
    expect(first.snapshot.artifact_root_hash).toBe(second.snapshot.artifact_root_hash);
    expect(first.snapshot.content_extraction_fingerprint).toBe(
      second.snapshot.content_extraction_fingerprint,
    );
  });

  it('keeps content fingerprints association-independent while IDs remain scoped', async () => {
    const firstFixture = fixture();
    const secondSource: SourceArtifact = {
      ...firstFixture.sourceArtifact,
      id: opaqueIds.existingSourceArtifact('20000000-0000-4000-8000-000000000002'),
      organization_id: 'org-2',
      source_document_id: 'document-2',
    };
    const parser = {
      stage: 'ocr' as const,
      name: 'legacy-tesseract',
      version: '5',
      configuration_hash: 'f'.repeat(64),
    };
    const common = {
      parserManifest: PARSER_MANIFEST,
      parserManifestHash: firstFixture.run.parser_manifest_hash,
      artifactSchemaVersion: firstFixture.run.artifact_schema_version,
      idempotencyKey: 'job:same-content',
      completedAt: '2026-07-24T00:00:00.000Z',
      locatedObservations: [{
        page: 1,
        page_width: 100,
        page_height: 100,
        render_sha256: 'e'.repeat(64),
        parser,
        text: 'Same bytes',
        confidence: 90,
        bbox: { x0: 10, y0: 10, x1: 50, y1: 20 },
      }],
    };

    const first = await adaptLegacyExtractionToStep1Shadow({
      ...common,
      sourceArtifact: firstFixture.sourceArtifact,
    });
    const second = await adaptLegacyExtractionToStep1Shadow({
      ...common,
      sourceArtifact: secondSource,
    });

    expect(first.snapshot.content_extraction_fingerprint).toBe(
      second.snapshot.content_extraction_fingerprint,
    );
    expect(first.run.id).not.toBe(second.run.id);
    expect(first.pages[0]?.id).not.toBe(second.pages[0]?.id);
    expect(first.snapshot.id).not.toBe(second.snapshot.id);
  });
});
