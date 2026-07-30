import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  REQUIRED_METAMORPHIC_INVARIANTS,
  TDOT_PHASE1_HARNESS_VERSION,
  blockedMetamorphicResults,
  buildParityRecords,
  classifyParityDifference,
  evaluateHistoricalFingerprintInert,
  executeSourceMetamorphicInvariants,
  loadPhase1Inputs,
  manifestInvariantSemanticProjection,
  mergeMetamorphicResults,
  preconditionedMetamorphicResults,
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
  semanticRole = 'description',
): GenericComparedField {
  const verifiedFieldId = `verified-${x0}`;
  return {
    verified_field_id: verifiedFieldId,
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
    semantic_role: semanticRole,
    semantic_status: semanticStatus,
    semantic_mapping_evidence: semanticStatus === 'unmapped' ? null : {
      mapping_id: `mapping-${x0}`,
      selected_role: semanticStatus === 'resolved'
        ? semanticRole as 'description' : null,
      assessment: {
        version: 'interpretation-confidence-v2',
        verified_field_ids: [verifiedFieldId],
        header_role: {
          state: 'observed',
          score: 1,
          basis_artifact_ids: ['fragment'],
          diagnostics: [],
        },
        arithmetic_consistency: {
          state: 'not_applicable',
          score: null,
          basis_artifact_ids: [],
          diagnostics: [],
        },
        candidate_roles: [{
          role: semanticRole as 'description',
          score: 0.9,
          evidence: ['test_evidence'],
          verified_field_ids: [verifiedFieldId],
          dependency_hashes: ['hash'],
        }],
        selected_role: semanticStatus === 'resolved'
          ? semanticRole as 'description' : null,
        resolution_policy: {
          minimum_score: 0.7,
          minimum_margin: 0.2,
          observed_top_score: 0.9,
          observed_margin: 0.3,
        },
        source_evidence: [],
        source_region: {
          page: 46,
          bounding_box: {
            coordinate_space: 'page_normalized',
            origin: 'top_left',
            x0,
            y0: 0.13,
            x1,
            y1: 0.17,
            rotation: 0,
          },
        },
        uncertainties: semanticStatus === 'resolved'
          ? [] : ['ambiguous_column_role'],
      } as unknown as GenericComparedField['semantic_mapping_evidence'] extends infer T
        ? T extends { assessment: infer A } ? A : never
        : never,
      interpretation_rule_id: 'observed-column-evidence-v2',
      interpretation_rule_version: '2',
    },
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

  it('reports exact, whitespace-normalized, and punctuation-normalized reconstruction separately', () => {
    const records = buildParityRecords({
      ledger,
      legacyRows: [],
      genericFields: [field('Loading  and Hauling', 0.18, 0.48)],
    });

    expect(records[0]).toMatchObject({
      classification: 'missing_or_uncertain',
      resolution: 'unresolved',
      reconstruction_comparison: {
        exact_equal: false,
        whitespace_normalized_equal: true,
        punctuation_normalized_equal: true,
      },
    });
  });

  it('preserves rate versus extension in the typed cost-role contract', () => {
    const costLedger: TdotLedger = {
      ...ledger,
      observations: [{
        ...observation,
        field_identifier: 'tdot:p46:r1:cost',
        exact_raw_text: '$125.00',
        interpreted_field_or_role: 'cost',
      }],
    };
    const rateRecord = buildParityRecords({
      ledger: costLedger,
      legacyRows: [],
      genericFields: [field('$125.00', 0.18, 0.48, 'resolved', 'rate')],
    })[0];
    const extensionRecord = buildParityRecords({
      ledger: costLedger,
      legacyRows: [],
      genericFields: [field('$125.00', 0.18, 0.48, 'resolved', 'extension')],
    })[0];

    expect(rateRecord?.semantic_role_comparison).toMatchObject({
      contract_kind: 'evidence_supported_alternatives',
      acceptable_roles: ['rate', 'extension'],
      observed_role: 'rate',
      evidence_supported: true,
    });
    expect(extensionRecord?.semantic_role_comparison).toMatchObject({
      contract_kind: 'evidence_supported_alternatives',
      acceptable_roles: ['rate', 'extension'],
      observed_role: 'extension',
      evidence_supported: true,
    });
  });

  it('keeps an unresolved cost-family role in semantic review', () => {
    const costLedger: TdotLedger = {
      ...ledger,
      observations: [{
        ...observation,
        field_identifier: 'tdot:p46:r1:cost',
        exact_raw_text: '$125.00',
        interpreted_field_or_role: 'cost',
      }],
    };
    const record = buildParityRecords({
      ledger: costLedger,
      legacyRows: [],
      genericFields: [field('$125.00', 0.18, 0.48, 'ambiguous', 'rate')],
    })[0];

    expect(record).toMatchObject({
      resolution: 'requires_semantic_review',
      semantic_role_comparison: {
        observed_role: 'rate',
        observed_status: 'ambiguous',
        evidence_supported: false,
      },
    });
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

  it('uses invariant-specific preconditions instead of a global parity gate', () => {
    const results = preconditionedMetamorphicResults();
    expect(results.find(({ invariant_id }) =>
      invariant_id === 'delete_supporting_span')?.explanation)
      .toContain('invariant-specific');
    expect(results.find(({ invariant_id }) =>
      invariant_id === 'change_rate')?.explanation)
      .toContain('invariant-specific');
    expect(results.find(({ invariant_id }) =>
      invariant_id === 'change_quantity')?.explanation)
      .toContain('no quantity-role observation');
    expect(results.every(({ explanation }) =>
      !explanation.includes('baseline parity unresolved'))).toBe(true);
  });

  it('classifies absent TDOT structures as source-limited without making them globally not applicable', () => {
    const results = preconditionedMetamorphicResults();
    for (const invariantId of [
      'merged_multiline_cells',
      'subtables',
      'repeated_headers',
      'cross_page_continuation',
    ]) {
      const result = results.find(({ invariant_id }) =>
        invariant_id === invariantId);
      expect(result).toMatchObject({
        status: 'blocked',
        mutation_manifest: {
          disposition: 'source_limited_for_tdot_pdf',
          synthetic_source_required: true,
          generic_phase2_evidence_required: true,
          production_parser_input: false,
        },
      });
      expect(result?.explanation).toContain('purpose-built synthetic source');
    }
  });

  it('blocks only source mutations whose target support is unavailable', async () => {
    const execution = await executeSourceMetamorphicInvariants({
      pdfPath: path.join(
        process.cwd(),
        'lib/evaluation/tdotPhase1Harness.test.ts',
      ),
      baseline: {
        graph: { fragments: [] },
        fields: [],
      } as unknown as GenericShadowRun,
      parityRecords: [{
        id: 'unrelated-unresolved-record',
        material: true,
        resolution: 'unresolved',
        ledger: null,
        legacy_row: null,
        generic_fields: [],
      } as unknown as ReturnType<typeof buildParityRecords>[number]],
    });
    expect(execution.results).toEqual([
      expect.objectContaining({
        invariant_id: 'delete_supporting_span',
        status: 'blocked',
        explanation: expect.stringContaining('no exact, resolved'),
      }),
      expect.objectContaining({
        invariant_id: 'duplicate_row',
        status: 'blocked',
        explanation: expect.stringContaining('appended-page duplication was removed'),
      }),
      expect.objectContaining({
        invariant_id: 'insert_row',
        status: 'blocked',
        explanation: expect.stringContaining('movable table-bottom band'),
      }),
      expect.objectContaining({
        invariant_id: 'change_rate',
        status: 'blocked',
        explanation: expect.stringContaining('no exact source-grounded ledger cost'),
      }),
      expect.objectContaining({
        invariant_id: 'change_unit',
        status: 'blocked',
        explanation: expect.stringContaining('no exact single-native-span unit target'),
      }),
      expect.objectContaining({
        invariant_id: 'remove_row',
        status: 'blocked',
        explanation: expect.stringContaining('no exact source-grounded row'),
      }),
    ]);
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

  it('keeps the report version explicit without using it as extraction identity', () => {
    expect(TDOT_PHASE1_HARNESS_VERSION).toBe('1.11.0');
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

  it('keeps the remediated generic modules free of TDOT routing fingerprints', async () => {
    const productionSources = await Promise.all([
      'lib/extraction/domain/genericTableArtifacts.ts',
      'lib/extraction/domain/regionArbitration.ts',
      'lib/interpretation/semanticColumnMapping.ts',
      'lib/interpretation/step3ShadowBridge.ts',
    ].map((file) => readFile(path.join(process.cwd(), file), 'utf8')));
    expect(productionSources.join('\n')).not.toMatch(
      /TDOT_APPENDIX_B_SPECS|tdot_appendix_b_stitched_table|89633|7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a|page\s*===?\s*(43|44|46)/i,
    );
  });
});

const integrationEnvironment = {
  pdfPath: process.env.TDOT_PHASE1_SOURCE_PDF,
  phase0Package: process.env.TDOT_PHASE1_PHASE0_PACKAGE,
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

  it('keeps real-pipeline semantics invariant when only manifest identity changes', async () => {
    const baseline = await runGenericShadowFromPdf({
      pdfPath: integrationEnvironment.pdfPath!,
      implementationBuild: 'manifest-invariance-build-a',
    });
    const reidentified = await runGenericShadowFromPdf({
      pdfPath: integrationEnvironment.pdfPath!,
      implementationBuild: 'manifest-invariance-build-b',
    });
    expect(baseline.graph.snapshot.parser_manifest_hash).not.toBe(
      reidentified.graph.snapshot.parser_manifest_hash,
    );
    expect(baseline.graph.fragments.map(({ id }) => id)).not.toEqual(
      reidentified.graph.fragments.map(({ id }) => id),
    );
    expect(manifestInvariantSemanticProjection(reidentified)).toEqual(
      manifestInvariantSemanticProjection(baseline),
    );
    if (integrationEnvironment.phase0Package) {
      const { ledger, legacyRows } = await loadPhase1Inputs({
        ledgerPath: path.join(
          integrationEnvironment.phase0Package,
          'annotation',
          'tdot-appendix-b-ledger.v1.0.0-draft.json',
        ),
        historicalContractAnalysisPath: path.join(
          integrationEnvironment.phase0Package,
          'exports',
          '2026-07-28T154510Z',
          'intelligence_trace.contract_analysis.json',
        ),
      });
      const parityProjection = (run: GenericShadowRun) =>
        buildParityRecords({
          ledger,
          legacyRows,
          genericFields: run.fields,
        }).filter(({ ledger: observation }) => observation != null)
          .map((record) => ({
            field_identifier: record.ledger!.field_identifier,
            classification: record.classification,
            resolution: record.resolution,
            exact: record.reconstruction_comparison?.exact_equal ?? false,
            generic_field_count: record.generic_fields.length,
          }));
      expect(parityProjection(reidentified)).toEqual(
        parityProjection(baseline),
      );
    }
    expect(baseline.dependency_closure.status).toBe('pass');
    expect(reidentified.dependency_closure.status).toBe('pass');
  }, 360_000);
});
