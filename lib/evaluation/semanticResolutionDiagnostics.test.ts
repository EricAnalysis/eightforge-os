import { describe, expect, it } from 'vitest';

import { buildSemanticResolutionDiagnostic } from '@/lib/evaluation/semanticResolutionDiagnostics';
import type {
  GenericShadowRun,
  ParityRecord,
} from '@/lib/evaluation/tdotPhase1Harness';

describe('semantic resolution diagnostic', () => {
  it('serializes the actual predicate and evaluator rejection without changing results', () => {
    const box = {
      coordinate_space: 'page_normalized' as const,
      origin: 'top_left' as const,
      x0: 0.1,
      y0: 0.1,
      x1: 0.9,
      y1: 0.9,
      rotation: 0 as const,
    };
    const mapping = {
      id: 'mapping-1',
      table_chain_id: 'chain-1',
      column_index: 0,
      domain_role: 'description',
      status: 'resolved',
      header_verified_field_ids: ['header-field'],
      cell_verified_field_ids: ['cell-field'],
      interpretation_rule_id: 'observed-column-evidence-v2',
      interpretation_rule_version: '2',
      assessment: {
        selected_role: 'description',
        candidate_roles: [{
          role: 'description',
          score: 1,
          evidence: ['header_exact_alias:description', 'body_value_kind:1.000'],
          verified_field_ids: ['header-field', 'cell-field'],
          dependency_hashes: ['header-dependency', 'cell-dependency'],
        }],
        resolution_policy: {
          minimum_score: 0.7,
          minimum_margin: 0.2,
          observed_top_score: 1,
          observed_margin: 1,
        },
        source_evidence: [],
        source_region: { page: 1, bounding_box: box },
      },
    };
    const run = {
      source_sha256: 'source',
      implementation_build: 'build',
      graph: {
        snapshot: { parser_manifest_hash: 'parser' },
        fragments: [],
        verifiedFields: [{
          id: 'cell-field',
          normalized_value: 'value',
          source_fragment_ids: [],
        }],
        tableRows: [],
        tableSegments: [{
          id: 'segment-1',
          page: 1,
          bounding_box: box,
          row_ids: [],
          column_hypotheses: [{
            index: 0,
            x0: 0.1,
            x1: 0.9,
            header: {
              observed_text: 'Description',
              normalized_label: 'Description',
              fragment_ids: [],
              transformations: [],
            },
            value_kind_hypotheses: [{
              kind: 'free_text',
              measurement: { value: 1, basis_artifact_ids: [] },
            }],
          }],
        }],
        tableChains: [{
          id: 'chain-1',
          segment_ids: ['segment-1'],
        }],
        tableSections: [],
      },
      fields: [{ interpretation_manifest_hash: 'interpreter' }],
      interpretation: { semantic_column_mappings: [mapping] },
    } as unknown as GenericShadowRun;
    const record = {
      id: 'record-1',
      material: true,
      resolution: 'unresolved',
      classification: 'missing_or_uncertain',
      explanation: 'evaluator rejected the otherwise resolved role',
      ledger: {
        interpreted_field_or_role: 'description',
        exact_raw_text: 'value',
        source_page: 1,
        bbox_x0: 1,
        bbox_y0: 1,
        bbox_x1: 2,
        bbox_y1: 2,
      },
      generic_fields: [{
        verified_field_id: 'cell-field',
        candidate_id: 'candidate',
        dependency_hash: 'dependency',
        source_page: 1,
        source_bbox: box,
        raw_text: 'value',
        source_fragment_ids: [],
        table_cell_id: 'cell-1',
        table_row_id: null,
        table_segment_id: 'segment-1',
        semantic_mapping_evidence: { mapping_id: 'mapping-1' },
        interpretation_manifest_hash: 'interpreter',
      }],
      reconstruction_comparison: {
        reconstructed_raw_text: 'value',
        exact_equal: true,
      },
      semantic_role_comparison: {
        acceptable_roles: ['description'],
      },
    } as unknown as ParityRecord;

    const diagnostic = buildSemanticResolutionDiagnostic({
      run,
      records: [record],
      baselineReportVersion: '1.11.0',
    });

    expect(diagnostic.non_resolved_record_count).toBe(1);
    expect(diagnostic.invariant_boundaries).toEqual({
      interpretation_results_changed: false,
      evaluator_contract_changed: false,
      extraction_results_changed: false,
    });
    expect(
      diagnostic.non_resolved_record_traces[0]?.earliest_stage_preventing_resolution,
    ).toBe('mapping_resolved_generically_but_the_evaluator_rejected_it');
    expect(
      diagnostic.ambiguous_semantic_mappings,
    ).toHaveLength(0);
  });
});
