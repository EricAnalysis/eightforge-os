import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_METAMORPHIC_INVARIANTS,
  blockedMetamorphicResults,
  buildParityRecords,
  classifyParityDifference,
  evaluateHistoricalFingerprintInert,
  mergeMetamorphicResults,
  runGenericShadowFromPdf,
  type GenericComparedField,
  type GenericShadowRun,
  type TdotLedger,
} from '@/lib/evaluation/tdotPhase1Harness';

const observation = {
  field_identifier: 'tdot:p46:r1:description',
  source_pdf_sha256: 'a'.repeat(64),
  source_page: 46,
  bbox_x0: 100,
  bbox_y0: 100,
  bbox_x1: 300,
  bbox_y1: 140,
  page_width_points: 600,
  page_height_points: 800,
  exact_raw_text: 'Loading and Hauling',
  raw_text_sha256: 'b'.repeat(64),
  interpreted_field_or_role: 'description',
  row_identity: 'source:p46:geometric-row:001',
} as const;

function field(
  rawText: string,
  x0: number,
  x1: number,
  semanticStatus: GenericComparedField['semantic_status'] = 'resolved',
): GenericComparedField {
  return {
    verified_field_id: `verified-${x0}`,
    candidate_id: `candidate-${x0}`,
    dependency_hash: `${x0}`.padStart(64, '0'),
    source_page: 46,
    source_bbox: {
      coordinate_space: 'page_normalized',
      origin: 'top_left',
      x0,
      y0: 0.13,
      x1,
      y1: 0.17,
      rotation: 0,
    },
    raw_text: rawText,
    raw_text_sha256: 'c'.repeat(64),
    normalized_value: { type: 'text', value: rawText },
    confidence: { overall: 0.85 },
    source_fragment_ids: [`fragment-${x0}`],
    table_cell_id: `cell-${x0}`,
    table_row_id: 'row-1',
    table_segment_id: 'segment-1',
    semantic_role: 'description',
    semantic_status: semanticStatus,
    parser_manifest_hash: 'd'.repeat(64),
    interpretation_manifest_hash: 'e'.repeat(64),
  };
}

const ledger: TdotLedger = {
  ledger_version: 'test',
  source_pdf: { sha256: 'a'.repeat(64), byte_length: 1, pages: 46 },
  observations: [observation],
};

describe('TDOT Phase 1 shadow parity harness', () => {
  it('classifies an exact verified source/role field without legacy support as newly supported', () => {
    const records = buildParityRecords({
      ledger,
      legacyRows: [],
      genericFields: [field('Loading and Hauling', 0.18, 0.48)],
    });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      classification: 'newly_supported',
      resolution: 'resolved',
      material: true,
      comparison_scope: 'generic_to_ledger',
    });
  });

  it('implements all six Section 12.2 classifications without positional matching', () => {
    const classify = (
      overrides: Partial<Parameters<typeof classifyParityDifference>[0]>,
    ) => classifyParityDifference({
      legacy_present: true,
      legacy_supported: true,
      generic_supported: true,
      values_equivalent: true,
      duplicate_split_merge: false,
      ...overrides,
    });
    expect(classify({})).toBe('match');
    expect(classify({
      legacy_supported: false,
      generic_supported: false,
    })).toBe('legacy_unsupported');
    expect(classify({
      legacy_supported: false,
      generic_supported: true,
    })).toBe('newly_supported');
    expect(classify({ values_equivalent: false })).toBe('changed_source_grounded');
    expect(classify({
      legacy_present: false,
      legacy_supported: false,
      generic_supported: false,
    })).toBe('missing_or_uncertain');
    expect(classify({ duplicate_split_merge: true })).toBe('duplicate_split_merge');
  });

  it('persists a split logical cell as an unresolved duplicate/split/merge difference', () => {
    const records = buildParityRecords({
      ledger,
      legacyRows: [],
      genericFields: [
        field('Loading and', 0.18, 0.30),
        field('Hauling', 0.31, 0.48),
      ],
    });
    expect(records[0]).toMatchObject({
      classification: 'duplicate_split_merge',
      resolution: 'unresolved',
      material: true,
    });
    expect(records[0]?.generic_fields).toHaveLength(2);
  });

  it('keeps authored TDOT history diagnostic and unsupported', () => {
    const records = buildParityRecords({
      ledger: { ...ledger, observations: [] },
      genericFields: [],
      legacyRows: [{
        row_id: 'tdot_appendix_b_stitched:1',
        page: 43,
        description: 'Authored value',
        unit: 'CY',
        origin_destination: null,
        rate_amount: 29,
        rate_raw: '$29.00',
        source_kind: 'tdot_appendix_b_stitched_table',
        source_anchor_ids: ['pdf:table:p43:t1:r1'],
      }],
    });
    expect(records[0]).toMatchObject({
      classification: 'legacy_unsupported',
      resolution: 'resolved',
      comparison_scope: 'legacy_diagnostic',
    });
    expect(records[0]?.generic_fields).toEqual([]);
    expect(records[0]?.ledger).toBeNull();
  });

  it('enumerates every revised Section 12.3 invariant exactly once', () => {
    const ids = REQUIRED_METAMORPHIC_INVARIANTS.map(([id]) => id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      'change_rate',
      'change_quantity',
      'change_unit',
      'change_description',
      'change_extension',
      'remove_row',
      'insert_row',
      'duplicate_row',
      'reorder_rows',
      'move_table_page',
      'reorder_columns',
      'missing_borders',
      'merged_multiline_cells',
      'subtables',
      'repeated_headers',
      'cross_page_continuation',
      'delete_supporting_span',
      'association_invariance',
      'historical_fingerprint_inert',
      'native_ocr_arbitration',
      'engine_conflict',
    ]);
  });

  it('replaces a blocked invariant only with its executed result', () => {
    const blocked = blockedMetamorphicResults('base parity blocked');
    const historical = {
      ...blocked.find((result) =>
        result.invariant_id === 'historical_fingerprint_inert')!,
      status: 'pass' as const,
      explanation: 'executed',
    };
    const merged = mergeMetamorphicResults(blocked, [historical]);
    expect(merged.find((result) =>
      result.invariant_id === 'historical_fingerprint_inert')?.status).toBe('pass');
    expect(merged.filter((result) => result.status === 'blocked')).toHaveLength(
      REQUIRED_METAMORPHIC_INVARIANTS.length - 1,
    );
  });

  it('proves the generic output contract has no legacy-fingerprint input', () => {
    const baseline = {
      graph: { snapshot: { content_extraction_fingerprint: 'f'.repeat(64) } },
      fields: [],
      interpretation: {},
    } as unknown as GenericShadowRun;
    expect(evaluateHistoricalFingerprintInert({
      baseline,
      historicalFingerprintBefore: 'legacy-tdot-fingerprint-before',
      historicalFingerprintAfter: 'legacy-tdot-fingerprint-after',
    }).status).toBe('pass');
  });

  it('has no contract assembler, persistence writer, reader, or validator import', async () => {
    const source = await readFile(
      path.join(process.cwd(), 'lib/evaluation/tdotPhase1Harness.ts'),
      'utf8',
    );
    const imports = source.split('\n').filter((line) => line.startsWith('import '));
    expect(imports.join('\n')).not.toMatch(
      /lib\/contracts|complianceShadow|persistExtractionStep1Shadow|validator|reader/i,
    );
  });
});

const integrationEnvironment = {
  pdfPath: process.env.TDOT_PHASE1_SOURCE_PDF,
};

describe.skipIf(!integrationEnvironment.pdfPath)('TDOT Phase 1 verified-source integration', () => {
  it('runs the real PDF through the in-memory generic graph with dependency closure', async () => {
    const run = await runGenericShadowFromPdf({
      pdfPath: integrationEnvironment.pdfPath!,
    });
    expect(run.source_sha256).toBe(
      '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a',
    );
    expect(run.source_byte_length).toBe(1_063_619);
    expect(run.graph.pages).toHaveLength(46);
    expect(run.dependency_closure).toMatchObject({ status: 'pass', errors: [] });
    expect(run.graph.tableSegments.length).toBeGreaterThan(0);
    expect(run.fields.length).toBeGreaterThan(0);
  }, 120_000);
});
