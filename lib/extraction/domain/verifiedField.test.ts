import { describe, expect, it } from 'vitest';
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import type {
  ExtractionRun,
  FieldCandidate,
  FieldCandidateId,
  FragmentArtifactId,
  PageArtifact,
  PageArtifactId,
  SourceArtifact,
  SourceArtifactId,
  SourceFragmentArtifact,
  TransformationStep,
} from '@/lib/extraction/domain/types';
import {
  verifyFieldCandidate,
  type VerificationRepository,
} from '@/lib/extraction/domain/verifiedField';

const HASH = 'a'.repeat(64);
const MANIFEST_HASH = 'b'.repeat(64);
const SOURCE_ID = 'source-1' as SourceArtifactId;
const RUN_ID = 'run-1' as ExtractionRun['id'];
const PAGE_ID = 'page-1' as PageArtifactId;
const FRAGMENT_ID = 'fragment-1' as FragmentArtifactId;
const CANDIDATE_ID = 'candidate-1' as FieldCandidateId;

function decimalSteps(): readonly TransformationStep[] {
  const input1 = '$ 1,250.00';
  const output1 = '1,250.00';
  const output2 = '1250.00';
  const output3 = '1250';
  return [
    {
      sequence: 1,
      operation: 'strip_currency_symbol',
      implementation_version: 'v1',
      input_sha256: sha256Hex(input1),
      output_sha256: sha256Hex(output1),
      input_text: input1,
      output_text: output1,
      lossless: true,
      rationale: 'Observed currency marker is not part of the decimal primitive.',
    },
    {
      sequence: 2,
      operation: 'remove_group_separator',
      implementation_version: 'v1',
      input_sha256: sha256Hex(output1),
      output_sha256: sha256Hex(output2),
      input_text: output1,
      output_text: output2,
      lossless: true,
      rationale: 'Locale grouping separator is formatting.',
    },
    {
      sequence: 3,
      operation: 'decimal_parse',
      implementation_version: 'v1',
      input_sha256: sha256Hex(output2),
      output_sha256: sha256Hex(output3),
      input_text: output2,
      output_text: output3,
      lossless: true,
      rationale: 'Canonical decimal representation.',
    },
  ];
}

function fixture(overrides?: {
  fragment?: Partial<SourceFragmentArtifact>;
  candidate?: Partial<FieldCandidate>;
}): {
  repository: VerificationRepository;
  candidate: FieldCandidate;
} {
  const source: SourceArtifact = {
    id: SOURCE_ID,
    organization_id: 'org-1',
    source_document_id: 'document-1',
    source_sha256: HASH,
    storage_object_version: 'version-1',
    media_type_sniffed: 'application/pdf',
    byte_length: 100,
    created_at: '2026-07-23T00:00:00.000Z',
  };
  const run: ExtractionRun = {
    id: RUN_ID,
    organization_id: 'org-1',
    semantic_key: 'semantic-key',
    attempt_number: 1,
    source_artifact_id: SOURCE_ID,
    parser_manifest_hash: MANIFEST_HASH,
    artifact_schema_version: 'v1',
    status: 'complete',
  };
  const parser = {
    stage: 'native_text' as const,
    name: 'fixture-parser',
    version: '1',
    configuration_hash: 'c'.repeat(64),
  };
  const page: PageArtifact = {
    id: PAGE_ID,
    organization_id: 'org-1',
    extraction_run_id: RUN_ID,
    source_artifact_id: SOURCE_ID,
    source_document_id: 'document-1',
    source_sha256: HASH,
    page: 1,
    width: 612,
    height: 792,
    rotation_degrees: 0,
    render_sha256: 'd'.repeat(64),
    parser_manifest_hash: MANIFEST_HASH,
    parser,
    status: 'processed',
  };
  const fragment: SourceFragmentArtifact = {
    id: FRAGMENT_ID,
    organization_id: 'org-1',
    kind: 'token',
    extraction_run_id: RUN_ID,
    source_artifact_id: SOURCE_ID,
    page_artifact_id: PAGE_ID,
    source_document_id: 'document-1',
    source_sha256: HASH,
    parser_manifest_hash: MANIFEST_HASH,
    page: 1,
    bounding_box: {
      coordinate_space: 'page_normalized',
      origin: 'top_left',
      x0: 0.1,
      y0: 0.2,
      x1: 0.3,
      y1: 0.25,
      rotation: 0,
    },
    raw_text: '$ 1,250.00',
    parser,
    recognition_confidence: 0.99,
    reading_order: 1,
    ...overrides?.fragment,
  };
  const observed = {
    state: 'observed' as const,
    score: 0.99,
    basis_artifact_ids: [FRAGMENT_ID] as const,
    diagnostics: [],
  };
  const candidate: FieldCandidate = {
    id: CANDIDATE_ID,
    organization_id: 'org-1',
    extraction_run_id: RUN_ID,
    source_artifact_id: SOURCE_ID,
    source_document_id: 'document-1',
    source_sha256: HASH,
    parser_manifest_hash: MANIFEST_HASH,
    source_fragment_ids: [FRAGMENT_ID],
    raw_text: '$ 1,250.00',
    primitive_kind: 'decimal',
    proposed_value: { type: 'decimal', value: '1250' },
    transformations: decimalSteps(),
    parser: { ...parser, stage: 'primitive_parse' },
    confidence: {
      version: 'extraction-confidence-v1',
      recognition: observed,
      geometry_alignment: observed,
      parse_normalization: observed,
      cross_engine_agreement: {
        state: 'not_available',
        score: null,
        basis_artifact_ids: [],
        diagnostics: ['single_engine_only'],
      },
      overall: 0.85,
      grade: 'high',
      uncertainties: ['single_engine_only'],
    },
    status: 'candidate',
    ...overrides?.candidate,
  };
  const repository: VerificationRepository = {
    async getCandidate(id) {
      return id === CANDIDATE_ID ? candidate : null;
    },
    async getFragments(ids) {
      return ids.includes(FRAGMENT_ID) ? [fragment] : [];
    },
    async getPages(ids) {
      return ids.includes(PAGE_ID) ? [page] : [];
    },
    async getRun(id) {
      return id === RUN_ID ? run : null;
    },
    async getSourceArtifact(id) {
      return id === SOURCE_ID ? source : null;
    },
    async getCorroborationPolicy() {
      return null;
    },
  };
  return { repository, candidate };
}

describe('verified field dependency integrity', () => {
  it('resolves one source/run/manifest, validates boxes, and replays transformations', async () => {
    const { repository } = fixture();
    const result = await verifyFieldCandidate(CANDIDATE_ID, repository);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verifiedField.normalized_value).toEqual({
        type: 'decimal',
        value: '1250',
      });
      expect(result.verifiedField.source_fragment_ids).toEqual([FRAGMENT_ID]);
      expect(result.verifiedField.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    }
  });

  it.each([
    ['cross source', { source_sha256: 'f'.repeat(64) }, 'cross_source'],
    ['cross run', { extraction_run_id: 'run-2' as ExtractionRun['id'] }, 'cross_run'],
    [
      'out-of-page box',
      {
        bounding_box: {
          coordinate_space: 'page_normalized' as const,
          origin: 'top_left' as const,
          x0: -0.1,
          y0: 0,
          x1: 0.2,
          y1: 0.2,
          rotation: 0 as const,
        },
      },
      'invalid_box',
    ],
  ])('rejects %s dependencies', async (_label, fragment, code) => {
    const { repository } = fixture({ fragment });
    const result = await verifyFieldCandidate(CANDIDATE_ID, repository);
    expect(result).toMatchObject({ ok: false, code });
  });

  it('rejects a transformation trace that cannot reproduce the normalized value', async () => {
    const badSteps = decimalSteps().map((step) => ({ ...step }));
    badSteps[1] = { ...badSteps[1], output_sha256: hashCanonical('wrong') };
    const { repository } = fixture({ candidate: { transformations: badSteps } });
    const result = await verifyFieldCandidate(CANDIDATE_ID, repository);
    expect(result).toMatchObject({ ok: false, code: 'invalid_transformation' });
  });

  it('rejects uncorroborated OCR glyph substitution', async () => {
    const raw = '$ 1,250.00';
    const { repository } = fixture({
      candidate: {
        transformations: [{
          sequence: 1,
          operation: 'ocr_glyph_substitution',
          implementation_version: 'v1',
          input_sha256: sha256Hex(raw),
          output_sha256: sha256Hex(raw),
          input_text: raw,
          output_text: raw,
          lossless: false,
          rationale: 'fixture',
        }],
      },
    });
    const result = await verifyFieldCandidate(CANDIDATE_ID, repository);
    expect(result).toMatchObject({
      ok: false,
      code: 'uncorroborated_glyph_substitution',
    });
  });

  it('accepts glyph substitution only with an independent exact-box corroborator', async () => {
    const { repository: baseRepository, candidate: baseCandidate } = fixture();
    const primary = {
      ...(await baseRepository.getFragments([FRAGMENT_ID]))[0],
      raw_text: 'O',
    };
    const corroboratorId = 'fragment-2' as FragmentArtifactId;
    const corroborator: SourceFragmentArtifact = {
      ...primary,
      id: corroboratorId,
      raw_text: '0',
      parser: { ...primary.parser, name: 'source-pixel-classifier' },
      dependency_role: 'corroboration',
      corroboration_kind: 'source_pixel_classifier',
    };
    const candidate: FieldCandidate = {
      ...baseCandidate,
      source_fragment_ids: [FRAGMENT_ID, corroboratorId],
      raw_text: 'O',
      primitive_kind: 'decimal',
      proposed_value: { type: 'decimal', value: '0' },
      transformations: [
        {
          sequence: 1,
          operation: 'ocr_glyph_substitution',
          implementation_version: 'confusion-rule-v1',
          input_sha256: sha256Hex('O'),
          output_sha256: sha256Hex('0'),
          input_text: 'O',
          output_text: '0',
          lossless: false,
          rationale: 'O/0 confusion corroborated by exact-box pixel classifier.',
        },
        {
          sequence: 2,
          operation: 'decimal_parse',
          implementation_version: 'v1',
          input_sha256: sha256Hex('0'),
          output_sha256: sha256Hex('0'),
          input_text: '0',
          output_text: '0',
          lossless: true,
          rationale: 'Canonical decimal representation.',
        },
      ],
    };
    const repository: VerificationRepository = {
      ...baseRepository,
      async getCandidate(id) {
        return id === CANDIDATE_ID ? candidate : null;
      },
      async getFragments(ids) {
        return ids.map((id) => id === FRAGMENT_ID ? primary : corroborator);
      },
      async getCorroborationPolicy() {
        return [{
          kind: 'source_pixel_classifier',
          parser: corroborator.parser,
        }];
      },
    };
    const result = await verifyFieldCandidate(CANDIDATE_ID, repository);
    expect(result).toMatchObject({
      ok: true,
      verifiedField: { normalized_value: { type: 'decimal', value: '0' } },
    });
  });
});

export { fixture as verifiedFieldFixture };
