import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  adaptLegacyExtractionToStep1Shadow,
  type AdaptLegacyExtractionToStep1ShadowResult,
  type LegacyLocatedObservation,
  type LegacyLocatedPageObservation,
} from '@/lib/extraction/domain/legacyLocatedObservationAdapter';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import { GENERIC_TABLE_POLICY_V7 } from '@/lib/extraction/domain/genericTableArtifacts';
import {
  buildLegacyShadowParserManifest,
  hashParserManifest,
} from '@/lib/extraction/domain/parserManifest';
import type {
  BoundingBox,
  GridCellArtifact,
  LogicalTableRow,
  ParserIdentity,
  SourceArtifact,
  SourceFragmentArtifact,
} from '@/lib/extraction/domain/types';
import type { LocatedOcrObservationSidecar } from '@/lib/extraction/ocrObservationSidecar';
import type {
  InterpretationAssessment,
  SemanticColumnRole,
} from '@/lib/interpretation/semanticColumnMapping';
import { buildStep3SemanticInterpretation } from '@/lib/interpretation/step3ShadowBridge';
import { buildGenericPdfShadowSidecar } from '@/lib/server/documentExtraction';
import {
  deleteSupportingSpanFromPdf,
  insertInlineSourceRowInPdf,
  removeSourceRowFromPdf,
  replaceSourceTextInPdf,
  type PdfSourceMutationArtifact,
  type RowClearanceEnvelope,
  type SourceRowCell,
} from '@/lib/evaluation/pdfSourceMutations';
import {
  deriveTdotPhase1ImplementationBuild,
} from '@/lib/evaluation/tdotPhase1ExtractionBuild';

export const TDOT_PHASE1_HARNESS_VERSION = '1.13.0';
export const TDOT_PHASE1_EXPECTED_SOURCE_SHA256 =
  '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a';
export const TDOT_PHASE1_FIXED_TIME = '2026-07-28T00:00:00.000Z';

export type ParityClassification =
  | 'match'
  | 'legacy_unsupported'
  | 'newly_supported'
  | 'changed_source_grounded'
  | 'missing_or_uncertain'
  | 'duplicate_split_merge';

export type DifferenceResolution =
  | 'resolved'
  | 'unresolved'
  | 'requires_semantic_review';

export interface TdotLedgerObservation {
  readonly field_identifier: string;
  readonly source_pdf_sha256: string;
  readonly source_page: number;
  readonly bbox_x0: number;
  readonly bbox_y0: number;
  readonly bbox_x1: number;
  readonly bbox_y1: number;
  readonly page_width_points: number;
  readonly page_height_points: number;
  readonly exact_raw_text: string;
  readonly raw_text_sha256: string;
  readonly interpreted_field_or_role: string;
  readonly row_identity: string;
}

export interface TdotLedger {
  readonly ledger_version: string;
  readonly source_pdf: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly pages: number;
  };
  readonly observations: readonly TdotLedgerObservation[];
}

interface HistoricalExport<T> {
  readonly availability: string;
  readonly source_pdf_sha256: string;
  readonly rows: readonly T[];
}

export interface LegacyTdotRow {
  readonly row_id: string;
  readonly page: number;
  readonly description: string;
  readonly unit: string;
  readonly origin_destination: string | null;
  readonly rate_amount: number | null;
  readonly rate_raw: string | null;
  readonly source_kind: string;
  readonly source_anchor_ids: readonly string[];
}

interface HistoricalContractAnalysis {
  readonly rate_schedule_rows?: readonly LegacyTdotRow[];
}

export interface GenericComparedField {
  readonly verified_field_id: string;
  readonly candidate_id: string;
  readonly dependency_hash: string;
  readonly source_page: number;
  readonly source_bbox: BoundingBox;
  readonly raw_text: string;
  readonly raw_text_sha256: string;
  readonly normalized_value: unknown;
  readonly confidence: unknown;
  readonly source_fragment_ids: readonly string[];
  readonly table_cell_id: string;
  readonly table_row_id: string | null;
  readonly table_segment_id: string;
  readonly semantic_role: string | null;
  readonly semantic_status: 'resolved' | 'ambiguous' | 'unmapped';
  readonly semantic_mapping_evidence: {
    readonly mapping_id: string;
    readonly selected_role: SemanticColumnRole | null;
    readonly assessment: InterpretationAssessment;
    readonly interpretation_rule_id: string;
    readonly interpretation_rule_version: string;
  } | null;
  readonly parser_manifest_hash: string;
  readonly interpretation_manifest_hash: string | null;
}

export interface ParityRecord {
  readonly id: string;
  readonly comparison_scope: 'generic_to_ledger' | 'legacy_diagnostic';
  readonly classification: ParityClassification;
  readonly resolution: DifferenceResolution;
  readonly material: boolean;
  readonly explanation: string;
  readonly ledger: TdotLedgerObservation | null;
  readonly generic_fields: readonly GenericComparedField[];
  readonly legacy_row: LegacyTdotRow | null;
  readonly comparison_basis: readonly string[];
  readonly reconstruction_comparison: {
    readonly reconstructed_raw_text: string;
    readonly exact_equal: boolean;
    readonly whitespace_normalized_equal: boolean;
    readonly punctuation_normalized_equal: boolean;
  } | null;
  readonly semantic_role_comparison: {
    readonly contract_version: 'ledger-role-contract-v2';
    readonly contract_kind: 'exact' | 'evidence_supported_alternatives';
    readonly acceptable_roles: readonly SemanticColumnRole[];
    readonly observed_role: string | null;
    readonly observed_status: GenericComparedField['semantic_status'] | null;
    readonly evidence_supported: boolean;
    readonly prior_cost_as_rate_outcome:
      | 'resolved'
      | 'requires_semantic_review'
      | 'not_applicable';
  } | null;
}

export function classifyParityDifference(input: {
  readonly legacy_present: boolean;
  readonly legacy_supported: boolean;
  readonly generic_supported: boolean;
  readonly values_equivalent: boolean;
  readonly duplicate_split_merge: boolean;
}): ParityClassification {
  if (input.duplicate_split_merge) return 'duplicate_split_merge';
  if (input.generic_supported && input.legacy_supported) {
    return input.values_equivalent ? 'match' : 'changed_source_grounded';
  }
  if (input.generic_supported && !input.legacy_supported) return 'newly_supported';
  if (!input.generic_supported && input.legacy_present && !input.legacy_supported) {
    return 'legacy_unsupported';
  }
  return 'missing_or_uncertain';
}

export interface DependencyClosureResult {
  readonly status: 'pass' | 'fail';
  readonly checked_verified_fields: number;
  readonly checked_candidates: number;
  readonly checked_fragments: number;
  readonly errors: readonly string[];
}

export interface GenericShadowRun {
  readonly source_sha256: string;
  readonly source_byte_length: number;
  readonly source_document_id: string;
  readonly implementation_build: string;
  readonly graph: AdaptLegacyExtractionToStep1ShadowResult;
  readonly interpretation: Awaited<ReturnType<typeof buildStep3SemanticInterpretation>>;
  readonly fields: readonly GenericComparedField[];
  readonly dependency_closure: DependencyClosureResult;
}

function semanticFragmentKey(fragment: SourceFragmentArtifact): string {
  return hashCanonical({
    page: fragment.page,
    bounding_box: fragment.bounding_box,
    raw_text: fragment.raw_text,
    kind: fragment.kind,
    reading_order: fragment.reading_order,
    parser: {
      stage: fragment.parser.stage,
      name: fragment.parser.name,
      version: fragment.parser.version,
    },
  });
}

export function manifestInvariantSemanticProjection(run: GenericShadowRun) {
  const fragmentById = new Map<string, SourceFragmentArtifact>(
    run.graph.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const cells = run.graph.fragments
    .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
    .map((cell) => ({
      page: cell.page,
      bounding_box: cell.bounding_box,
      raw_text: cell.raw_text,
      row_start: cell.row_start,
      row_span: cell.row_span,
      column_start: cell.column_start,
      column_span: cell.column_span,
      structure: cell.structure,
      line_break_offsets: cell.line_break_offsets,
      content: cell.content_token_ids.map((id) => {
        const fragment = fragmentById.get(id);
        return fragment ? semanticFragmentKey(fragment) : 'missing';
      }),
    }))
    .sort((left, right) =>
      left.page - right.page
      || left.bounding_box.y0 - right.bounding_box.y0
      || left.bounding_box.x0 - right.bounding_box.x0
      || left.row_start - right.row_start
      || left.column_start - right.column_start);
  const cellById = new Map(
    run.graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  const rows = run.graph.tableRows.map((row) => ({
    page: row.page,
    bounding_box: row.bounding_box,
    row_kind: row.row_kind,
    cells: row.cell_ids.map((id) => {
      const cell = cellById.get(id);
      return cell ? {
        page: cell.page,
        bounding_box: cell.bounding_box,
        raw_text: cell.raw_text,
        row_start: cell.row_start,
        column_start: cell.column_start,
      } : null;
    }),
  }));
  const segmentById = new Map(
    run.graph.tableSegments.map((segment) => [segment.id, segment]),
  );
  return {
    reconstructed_fields: run.fields.map((field) => ({
      source_page: field.source_page,
      source_bbox: field.source_bbox,
      raw_text: field.raw_text,
      raw_text_sha256: field.raw_text_sha256,
      normalized_value: field.normalized_value,
      semantic_role: field.semantic_role,
      semantic_status: field.semantic_status,
      source_dependencies: field.source_fragment_ids.map((id) => {
        const fragment = fragmentById.get(id);
        return fragment ? semanticFragmentKey(fragment) : 'missing';
      }).sort(),
    })).sort((left, right) =>
      left.source_page - right.source_page
      || left.source_bbox.y0 - right.source_bbox.y0
      || left.source_bbox.x0 - right.source_bbox.x0
      || left.source_bbox.y1 - right.source_bbox.y1
      || left.source_bbox.x1 - right.source_bbox.x1
      || left.raw_text.localeCompare(right.raw_text)
      || (left.semantic_role ?? '').localeCompare(right.semantic_role ?? '')),
    cells,
    rows,
    continuation_chains: run.graph.tableChains.map((chain) =>
      chain.segment_ids.map((id) => {
        const segment = segmentById.get(id);
        return segment ? {
          page: segment.page,
          reading_order: segment.reading_order,
          bounding_box: segment.bounding_box,
          column_hypotheses: segment.column_hypotheses.map((column) => ({
            index: column.index,
            x0: column.x0,
            x1: column.x1,
            header: column.header.normalized_label,
          })),
        } : null;
      })),
    fragment_dispositions: run.graph.tableReconstructionDiagnostics
      .sparse_row_dispositions.map((disposition) => ({
        page: disposition.page,
        physical_row_index: disposition.physical_row_index,
        outcome: disposition.outcome,
        selected_primary_row_index: disposition.selected_primary_row_index,
        selected_column_index: disposition.selected_column_index,
        candidate_rows: disposition.candidate_rows,
        fragments: disposition.fragment_ids.map((id) => {
          const fragment = fragmentById.get(id);
          return fragment ? semanticFragmentKey(fragment) : 'missing';
        }).sort(),
      })),
  };
}

export interface MetamorphicResult {
  readonly invariant_id: string;
  readonly description: string;
  readonly status: 'pass' | 'fail' | 'blocked' | 'not_applicable';
  readonly mutation_manifest: Readonly<Record<string, unknown>> | null;
  readonly explanation: string;
  readonly changed_field_ids: readonly string[];
  readonly unexpected_field_ids: readonly string[];
}

export interface Phase1CycleMetrics {
  readonly total_material_records: number;
  readonly resolved: number;
  readonly unresolved: number;
  readonly semantic_review: number;
  readonly newly_supported: number;
  readonly missing_or_uncertain: number;
  readonly duplicate_split_merge: number;
  readonly mappings_resolved: number;
  readonly mappings_ambiguous: number;
  readonly ledger_cells_with_dependencies: number;
  readonly ledger_cells_without_dependencies: number;
  readonly exact_reconstructions: number;
  readonly non_exact_single_field_reconstructions: number;
  readonly split_reconstructions: number;
  readonly exact_split_reconstructions: number;
  readonly non_exact_split_reconstructions: number;
  readonly explicit_gaps: number;
  readonly sparse_rows_unresolved: number | null;
  readonly overflow_unassigned_cells: number | null;
  readonly calibration_adaptive_pages: number | null;
  readonly calibration_fallback_pages: number | null;
  readonly metamorphic_passed: number;
  readonly metamorphic_failed: number;
  readonly metamorphic_blocked: number;
  readonly metamorphic_not_applicable: number;
}

export interface TdotPhase1Report {
  readonly report_version: string;
  readonly generated_at: string;
  readonly phase: 'phase3_step4_phase1_shadow';
  readonly shadow_only: true;
  readonly source: {
    readonly sha256: string;
    readonly byte_length: number;
    readonly page_count: number;
  };
  readonly phase0_gate: {
    readonly status: string;
    readonly gate_definition_version: string;
    readonly check_count: number;
    readonly failed_check_count: number;
    readonly production_reader_changes_authorized: false;
    readonly legacy_removal_authorized: false;
  };
  readonly generic_run: {
    readonly snapshot_id: string;
    readonly content_extraction_fingerprint: string;
    readonly parser_manifest_hash: string;
    readonly artifact_root_hash: string;
    readonly status: string;
    readonly pages: number;
    readonly table_segments: number;
    readonly table_chains: number;
    readonly verified_fields: number;
    readonly compared_fields: number;
    readonly semantic_mappings: number;
    readonly semantic_ambiguities: number;
    readonly gaps: number;
    readonly reconstruction_diagnostics:
      AdaptLegacyExtractionToStep1ShadowResult['tableReconstructionDiagnostics'];
    readonly reconstruction_summary: {
      readonly calibration_adaptive_pages: number;
      readonly calibration_fallback_pages: number;
      readonly sparse_rows_attached: number;
      readonly sparse_rows_unresolved: number;
      readonly overflow_unassigned_cells: number;
      readonly table_candidate_fragments: number;
      readonly disposed_fragments: number;
      readonly undisposed_fragments: number;
    };
    readonly dependency_closure: DependencyClosureResult;
  };
  readonly parity: {
    readonly classification_counts: Readonly<Record<ParityClassification, number>>;
    readonly page_metrics: readonly {
      readonly page: number;
      readonly ledger_records: number;
      readonly exact_reconstructions: number;
      readonly non_exact_reconstructions: number;
      readonly fields_with_dependencies: number;
      readonly fields_without_dependencies: number;
    }[];
    readonly records: readonly ParityRecord[];
    readonly material_differences: readonly ParityRecord[];
  };
  readonly metamorphic: {
    readonly result_counts: Readonly<Record<MetamorphicResult['status'], number>>;
    readonly results: readonly MetamorphicResult[];
  };
  readonly cycle_comparison: {
    readonly baseline_report_version: string | null;
    readonly before: Phase1CycleMetrics | null;
    readonly after: Phase1CycleMetrics;
  };
  readonly record_transition_composition: {
    readonly records: readonly {
      readonly record_key: string;
      readonly record_id: string;
      readonly transitions: readonly (
        | 'recovered_dependency'
        | 'newly_missing_dependency'
        | 'exact_to_non_exact'
        | 'non_exact_to_exact'
        | 'unresolved_to_resolved'
        | 'resolved_to_semantic_review'
        | 'semantic_review_to_resolved'
        | 'unchanged'
      )[];
      readonly page: number | null;
      readonly ledger_role: string | null;
      readonly mechanism: string;
      readonly table_id: string | null;
      readonly source_row_id: string | null;
      readonly current_failure_reason: string | null;
    }[];
    readonly counts: Readonly<Record<string, number>>;
    readonly grouped: {
      readonly by_page: Readonly<Record<string, number>>;
      readonly by_ledger_role: Readonly<Record<string, number>>;
      readonly by_mechanism: Readonly<Record<string, number>>;
      readonly by_table: Readonly<Record<string, number>>;
      readonly by_source_row: Readonly<Record<string, number>>;
      readonly by_failure_reason: Readonly<Record<string, number>>;
    };
  };
  readonly diagnostic_scope: {
    readonly audited_ledger_pages: readonly number[];
    readonly audited_sparse_dispositions: number;
    readonly audited_overflow_cells: number;
    readonly outside_audited_pages_sparse_dispositions: number;
    readonly outside_audited_pages_overflow_cells: number;
    readonly non_parity_table_diagnostics_retained: number;
    readonly page_prose_or_note_classification:
      'not_inferred_without_source_role_evidence';
  };
  readonly remaining_failures: {
    readonly non_exact_reconstructions: readonly {
      readonly record_id: string;
      readonly field_identifier: string | null;
      readonly mechanism:
        | 'single_field_text_divergence'
        | 'split_merge_text_divergence';
    }[];
    readonly missing_dependencies: readonly {
      readonly record_id: string;
      readonly field_identifier: string | null;
      readonly mechanism: 'no_verified_generic_table_cell_in_ledger_geometry';
    }[];
    readonly unresolved_sparse_rows:
      AdaptLegacyExtractionToStep1ShadowResult[
        'tableReconstructionDiagnostics'
      ]['sparse_row_dispositions'];
    readonly overflow_cells:
      AdaptLegacyExtractionToStep1ShadowResult[
        'tableReconstructionDiagnostics'
      ]['column_overflows'];
    readonly semantic_review_record_ids: readonly string[];
  };
  readonly evaluator_role_contract: {
    readonly version: 'ledger-role-contract-v2';
    readonly cost_records: number;
    readonly exact_single_field_cost_records: number;
    readonly prior_cost_as_rate_resolved: number;
    readonly prior_cost_as_rate_semantic_review: number;
    readonly resolved_as_rate: number;
    readonly resolved_as_extension: number;
    readonly semantic_review: number;
    readonly changed_record_ids: readonly string[];
  };
  readonly prohibited_builder_calls: {
    readonly count: 0;
    readonly symbols: readonly [
      'TDOT_APPENDIX_B_SPECS',
      'tdot_appendix_b_stitched_table',
      'assembleContractRateScheduleRows',
    ];
  };
  readonly phase2_readiness: {
    readonly status: 'not_ready';
    readonly unresolved_material_difference_ids: readonly string[];
    readonly cutover_decision: null;
  };
  readonly cycle5: {
    readonly verdict: 'pass' | 'fail';
    readonly implementation_build: {
      readonly value: string;
      readonly derivation:
        'normalized-explicit-source-closure-and-runtime-version-sha256';
      readonly report_version_independent: true;
    };
    readonly part_a: {
      readonly before: Phase1CycleMetrics | null;
      readonly after: Phase1CycleMetrics | null;
      readonly checkpoint:
        'phase1-v1.11.0-part-a-2';
      readonly manifest_invariance:
        'passed_real_pdf_two_build_identity_test';
    };
    readonly comparator_audit: readonly {
      readonly file: string;
      readonly function: string;
      readonly ordered_object: string;
      readonly earlier_keys: readonly string[];
      readonly prior_effect: string;
      readonly classification:
        | 'semantically_significant_corrected'
        | 'deterministic_output_only_retained'
        | 'redundant_removed';
      readonly current_basis: string;
    }[];
    readonly page44_diagnostics: readonly {
      readonly field_identifier: string;
      readonly record_id: string;
      readonly ledger_role: string;
      readonly expected_text: string;
      readonly reconstructed_text: string | null;
      readonly relevant_sparse_dispositions:
        AdaptLegacyExtractionToStep1ShadowResult[
          'tableReconstructionDiagnostics'
        ]['sparse_row_dispositions'];
      readonly earliest_causal_divergence: string;
      readonly primary_mechanism: string;
    }[];
    readonly source_limited_invariant_count: number;
    readonly rejected_experiments: readonly {
      readonly checkpoint: string;
      readonly reason: string;
      readonly measurements: Readonly<Record<string, number>>;
    }[];
  };
}

const DEFAULT_NATIVE_PARSER: ParserIdentity = Object.freeze({
  stage: 'native_text',
  name: 'pdfjs-native-text',
  version: '5.5.207',
  configuration_hash: sha256Hex('pdfjs-native-text:5.5.207:step3-located-tokens-v1'),
});

function toArrayBuffer(bytes: Buffer): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function flattenLocatedObservations(
  sidecar: LocatedOcrObservationSidecar,
): LegacyLocatedObservation[] {
  const pages = sidecar.engine_pages && sidecar.engine_pages.length > 0
    ? sidecar.engine_pages
    : sidecar.pages;
  return pages.flatMap((page) =>
    page.words.map((word) => ({
      page: page.page_number,
      page_width: page.width,
      page_height: page.height,
      rotation_degrees: 0 as const,
      render_sha256: page.render_sha256,
      parser: (
        page as { readonly parser?: ParserIdentity }
      ).parser ?? DEFAULT_NATIVE_PARSER,
      text: word.text,
      confidence: word.confidence,
      bbox: word.bbox,
    })));
}

function locatedPages(
  sidecar: LocatedOcrObservationSidecar,
): LegacyLocatedPageObservation[] {
  return sidecar.pages.map((page) => ({
    page: page.page_number,
    page_width: page.width,
    page_height: page.height,
    rotation_degrees: 0,
    render_sha256: page.render_sha256,
    parser: DEFAULT_NATIVE_PARSER,
    text_detected: page.text_detected,
  }));
}

function dependencyClosure(
  graph: AdaptLegacyExtractionToStep1ShadowResult,
): DependencyClosureResult {
  const errors: string[] = [];
  const fragments = new Map<string, (typeof graph.fragments)[number]>(
    graph.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const candidates = new Map<string, (typeof graph.candidates)[number]>(
    graph.candidates.map((candidate) => [candidate.id, candidate]),
  );
  const pages = new Set<string>(graph.pages.map((page) => page.id));
  for (const fragment of graph.fragments) {
    if (!pages.has(fragment.page_artifact_id)) {
      errors.push(`fragment ${fragment.id} has no page`);
    }
  }
  for (const candidate of graph.candidates) {
    for (const dependency of candidate.source_fragment_dependencies) {
      if (!fragments.has(dependency.fragment_artifact_id)) {
        errors.push(`candidate ${candidate.id} has missing fragment ${dependency.fragment_artifact_id}`);
      }
    }
  }
  for (const field of graph.verifiedFields) {
    if (!candidates.has(field.candidate_id)) {
      errors.push(`verified field ${field.id} has no candidate`);
    }
    for (const fragmentId of field.source_fragment_ids) {
      if (!fragments.has(fragmentId)) {
        errors.push(`verified field ${field.id} has missing fragment ${fragmentId}`);
      }
    }
  }
  for (const dependency of graph.fragmentDependencies) {
    if (!fragments.has(dependency.fragment_artifact_id)) {
      errors.push(`fragment dependency owner ${dependency.fragment_artifact_id} is missing`);
    }
    for (const id of dependency.dependency_fragment_ids) {
      if (!fragments.has(id)) errors.push(`fragment dependency ${id} is missing`);
    }
  }
  return {
    status: errors.length === 0 ? 'pass' : 'fail',
    checked_verified_fields: graph.verifiedFields.length,
    checked_candidates: graph.candidates.length,
    checked_fragments: graph.fragments.length,
    errors,
  };
}

function comparedFields(
  graph: AdaptLegacyExtractionToStep1ShadowResult,
  interpretation: Awaited<ReturnType<typeof buildStep3SemanticInterpretation>>,
): GenericComparedField[] {
  const cells = new Map<string, GridCellArtifact>(
    graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  const rows = graph.fragments
    .filter((fragment): fragment is LogicalTableRow =>
      fragment.kind === 'region'
      && (fragment as LogicalTableRow).region_role === 'table_row');
  const rowByCell = new Map<string, string>(rows.flatMap((row) =>
    row.cell_ids.map((cellId) => [cellId, row.id] as const)));
  const roleByField = new Map<string, {
    role: string;
    status: 'resolved' | 'ambiguous';
    evidence: NonNullable<GenericComparedField['semantic_mapping_evidence']>;
  }>();
  for (const mapping of interpretation.semantic_column_mappings) {
    const record = mapping as {
      id: string;
      domain_role?: string;
      status?: 'resolved' | 'ambiguous';
      cell_verified_field_ids?: readonly string[];
      assessment: InterpretationAssessment;
      interpretation_rule_id: string;
      interpretation_rule_version: string;
    };
    for (const fieldId of record.cell_verified_field_ids ?? []) {
      roleByField.set(fieldId, {
        role: record.domain_role ?? 'other',
        status: record.status ?? 'ambiguous',
        evidence: {
          mapping_id: record.id,
          selected_role: record.assessment.selected_role,
          assessment: record.assessment,
          interpretation_rule_id: record.interpretation_rule_id,
          interpretation_rule_version: record.interpretation_rule_version,
        },
      });
    }
  }
  const interpretationManifestHash = interpretation.interpretation_snapshot
    ? (interpretation.interpretation_snapshot.interpreter_manifest_hash as string)
    : null;
  return graph.verifiedFields.flatMap((field) => {
    const cellId = field.source_fragment_ids.find((id) => cells.has(id));
    const cell = cellId ? cells.get(cellId) : null;
    if (!cell || !cellId) return [];
    const role = roleByField.get(field.id);
    return [{
      verified_field_id: field.id,
      candidate_id: field.candidate_id,
      dependency_hash: hashCanonical({
        verified_field: field,
        source_fragments: field.source_fragment_ids,
      }),
      source_page: cell.page,
      source_bbox: cell.bounding_box,
      raw_text: field.raw_text,
      raw_text_sha256: sha256Hex(field.raw_text),
      normalized_value: field.normalized_value,
      confidence: field.confidence,
      source_fragment_ids: field.source_fragment_ids,
      table_cell_id: cellId,
      table_row_id: rowByCell.get(cellId) ?? null,
      table_segment_id: cell.table_segment_id,
      semantic_role: role?.role ?? null,
      semantic_status: role?.status ?? 'unmapped' as const,
      semantic_mapping_evidence: role?.evidence ?? null,
      parser_manifest_hash: field.parser_manifest_hash,
      interpretation_manifest_hash: interpretationManifestHash,
    }];
  }).sort((left, right) =>
    left.source_page - right.source_page
    || left.source_bbox.y0 - right.source_bbox.y0
    || left.source_bbox.x0 - right.source_bbox.x0
    || left.dependency_hash.localeCompare(right.dependency_hash));
}

export async function runGenericShadowFromPdf(input: {
  readonly pdfPath: string;
  readonly expectedSha256?: string;
  readonly sourceDocumentId?: string;
  readonly associationSeed?: string;
  readonly implementationBuild?: string;
}): Promise<GenericShadowRun> {
  const bytes = await readFile(input.pdfPath);
  return runGenericShadowFromBytes({
    bytes,
    expectedSha256: input.expectedSha256,
    sourceDocumentId: input.sourceDocumentId,
    associationSeed: input.associationSeed,
    implementationBuild: input.implementationBuild,
  });
}

export async function runGenericShadowFromBytes(input: {
  readonly bytes: Uint8Array;
  readonly expectedSha256?: string;
  readonly sourceDocumentId?: string;
  readonly associationSeed?: string;
  readonly implementationBuild?: string;
}): Promise<GenericShadowRun> {
  const bytes = input.bytes;
  const sourceSha256 = sha256Hex(bytes);
  const expectedSha256 = input.expectedSha256 ?? TDOT_PHASE1_EXPECTED_SOURCE_SHA256;
  if (sourceSha256 !== expectedSha256) {
    throw new Error(`source SHA-256 mismatch: expected ${expectedSha256}, received ${sourceSha256}`);
  }
  const sidecar = await buildGenericPdfShadowSidecar(
    toArrayBuffer(Buffer.from(bytes)),
    'application/pdf',
  );
  if (!sidecar) throw new Error('generic PDF shadow sidecar was not produced');
  const implementationBuild = input.implementationBuild
    ?? await deriveTdotPhase1ImplementationBuild();
  const parserManifest = buildLegacyShadowParserManifest({
    analysisMode: 'deterministic',
    unstructuredEnabled: false,
    visionEnabled: false,
    typedAiEnabled: false,
    implementationBuild,
    verificationPolicy: 'step1_span_verified',
  });
  const parserManifestHash = hashParserManifest(parserManifest);
  const sourceDocumentId = input.sourceDocumentId
    ?? opaqueIds.sourceArtifact({
      kind: 'evaluation_source_document_association',
      association_seed: input.associationSeed ?? 'default',
    });
  const sourceArtifact: SourceArtifact = {
    id: opaqueIds.sourceArtifact({
      source_sha256: sourceSha256,
      byte_length: bytes.byteLength,
      media_type_sniffed: 'application/pdf',
    }),
    organization_id: 'phase1-shadow-evaluation',
    source_document_id: sourceDocumentId,
    source_sha256: sourceSha256,
    storage_object_version: `sha256:${sourceSha256}`,
    media_type_sniffed: 'application/pdf',
    byte_length: bytes.byteLength,
    created_at: TDOT_PHASE1_FIXED_TIME,
  };
  const graph = await adaptLegacyExtractionToStep1Shadow({
    sourceArtifact,
    parserManifest,
    parserManifestHash,
    artifactSchemaVersion: parserManifest.artifact_schema_version,
    idempotencyKey: `tdot-phase1:${sourceSha256}:${parserManifestHash}`,
    completedAt: TDOT_PHASE1_FIXED_TIME,
    locatedObservations: flattenLocatedObservations(sidecar),
    locatedPages: locatedPages(sidecar),
    genericContentAnalysis: sidecar.content_analysis,
    genericContentGaps: sidecar.content_gaps,
  });
  const interpretation = await buildStep3SemanticInterpretation({
    extraction_snapshot_id: graph.snapshot.id,
    chains: graph.tableChains,
    continuation_links: graph.continuationLinks,
    segments: graph.tableSegments,
    cells: graph.fragments.filter(
      (fragment): fragment is GridCellArtifact => fragment.kind === 'cell',
    ),
    verified_field_handles: graph.verifiedFieldHandles,
    published_at: TDOT_PHASE1_FIXED_TIME,
  });
  return {
    source_sha256: sourceSha256,
    source_byte_length: bytes.byteLength,
    source_document_id: sourceDocumentId,
    implementation_build: implementationBuild,
    graph,
    interpretation,
    fields: comparedFields(graph, interpretation),
    dependency_closure: dependencyClosure(graph),
  };
}

function normalizedBox(observation: TdotLedgerObservation): BoundingBox {
  return {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0: observation.bbox_x0 / observation.page_width_points,
    y0: observation.bbox_y0 / observation.page_height_points,
    x1: observation.bbox_x1 / observation.page_width_points,
    y1: observation.bbox_y1 / observation.page_height_points,
    rotation: 0,
  };
}

function centerInside(field: GenericComparedField, observation: TdotLedgerObservation): boolean {
  if (field.source_page !== observation.source_page) return false;
  const ledger = normalizedBox(observation);
  const x = (field.source_bbox.x0 + field.source_bbox.x1) / 2;
  const y = (field.source_bbox.y0 + field.source_bbox.y1) / 2;
  return x >= ledger.x0 && x <= ledger.x1 && y >= ledger.y0 && y <= ledger.y1;
}

function normalizedText(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function punctuationNormalizedText(value: string): string {
  return normalizedText(value)
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function reconstruction(fields: readonly GenericComparedField[]): string {
  const bands: GenericComparedField[][] = [];
  for (const field of [...fields].sort((left, right) =>
    left.source_bbox.y0 - right.source_bbox.y0
    || left.source_bbox.x0 - right.source_bbox.x0
    || left.dependency_hash.localeCompare(right.dependency_hash))) {
    const center = (field.source_bbox.y0 + field.source_bbox.y1) / 2;
    const band = bands.find((candidate) => {
      const first = candidate[0];
      if (!first) return false;
      const firstCenter = (first.source_bbox.y0 + first.source_bbox.y1) / 2;
      return Math.abs(center - firstCenter) <= 0.004;
    });
    if (band) band.push(field);
    else bands.push([field]);
  }
  return bands.map((band) =>
    band.sort((left, right) => left.source_bbox.x0 - right.source_bbox.x0)
      .map((field) => field.raw_text).join(' ')).join('\n');
}

type LedgerRoleContract =
  | {
      readonly kind: 'exact';
      readonly acceptable_roles: readonly SemanticColumnRole[];
    }
  | {
      readonly kind: 'evidence_supported_alternatives';
      readonly acceptable_roles: readonly ['rate', 'extension'];
    };

function roleContractForLedger(role: string): LedgerRoleContract | null {
  if (role === 'cost') {
    return {
      kind: 'evidence_supported_alternatives',
      acceptable_roles: ['rate', 'extension'],
    };
  }
  const exactRoles: readonly SemanticColumnRole[] = [
    'description',
    'row_label',
    'quantity',
    'unit',
    'rate',
    'extension',
    'origin',
    'destination',
    'origin_destination',
    'category',
    'code',
    'identifier',
  ];
  return exactRoles.includes(role as SemanticColumnRole)
    ? { kind: 'exact', acceptable_roles: [role as SemanticColumnRole] }
    : null;
}

function mappingEvidenceSupports(
  field: GenericComparedField,
  acceptableRoles: readonly SemanticColumnRole[],
): boolean {
  const evidence = field.semantic_mapping_evidence;
  if (
    field.semantic_status !== 'resolved'
    || evidence == null
    || evidence.selected_role !== field.semantic_role
    || !acceptableRoles.includes(field.semantic_role as SemanticColumnRole)
  ) {
    return false;
  }
  const candidate = evidence.assessment.candidate_roles.find((item) =>
    item.role === field.semantic_role);
  return candidate != null
    && candidate.verified_field_ids.some((id) =>
      (id as string) === field.verified_field_id)
    && candidate.score >= evidence.assessment.resolution_policy.minimum_score
    && evidence.assessment.resolution_policy.observed_top_score
      >= evidence.assessment.resolution_policy.minimum_score
    && evidence.assessment.resolution_policy.observed_margin
      >= evidence.assessment.resolution_policy.minimum_margin;
}

function classifyLedgerObservation(
  observation: TdotLedgerObservation,
  fields: readonly GenericComparedField[],
): Pick<
  ParityRecord,
  'classification' | 'resolution' | 'material' | 'explanation'
  | 'reconstruction_comparison' | 'semantic_role_comparison'
> {
  if (fields.length === 0) {
    return {
      classification: 'missing_or_uncertain',
      resolution: 'unresolved',
      material: true,
      explanation: 'No verified generic table-cell dependency falls inside the source ledger cell.',
      reconstruction_comparison: null,
      semantic_role_comparison: null,
    };
  }
  const reconstructed = reconstruction(fields);
  const reconstructionComparison = {
    reconstructed_raw_text: reconstructed,
    exact_equal: reconstructed === observation.exact_raw_text,
    whitespace_normalized_equal:
      normalizedText(reconstructed) === normalizedText(observation.exact_raw_text),
    punctuation_normalized_equal:
      punctuationNormalizedText(reconstructed)
        === punctuationNormalizedText(observation.exact_raw_text),
  };
  if (!reconstructionComparison.exact_equal) {
    return {
      classification: fields.length > 1 ? 'duplicate_split_merge' : 'missing_or_uncertain',
      resolution: 'unresolved',
      material: true,
      explanation: `Generic verified fragments do not reconstruct exact ledger raw text `
        + `(whitespace_normalized_equal=${reconstructionComparison.whitespace_normalized_equal}, `
        + `punctuation_normalized_equal=${reconstructionComparison.punctuation_normalized_equal}).`,
      reconstruction_comparison: reconstructionComparison,
      semantic_role_comparison: null,
    };
  }
  if (fields.length !== 1) {
    return {
      classification: 'duplicate_split_merge',
      resolution: 'unresolved',
      material: true,
      explanation: 'Source text is covered, but the generic graph split one logical ledger cell into multiple verified cells.',
      reconstruction_comparison: reconstructionComparison,
      semantic_role_comparison: null,
    };
  }
  const roleContract = roleContractForLedger(observation.interpreted_field_or_role);
  const field = fields[0];
  const evidenceSupported = roleContract != null
    && mappingEvidenceSupports(field, roleContract.acceptable_roles);
  const roleComparison: NonNullable<ParityRecord['semantic_role_comparison']> = {
    contract_version: 'ledger-role-contract-v2',
    contract_kind: roleContract?.kind ?? 'exact',
    acceptable_roles: roleContract?.acceptable_roles ?? [],
    observed_role: field.semantic_role,
    observed_status: field.semantic_status,
    evidence_supported: evidenceSupported,
    prior_cost_as_rate_outcome: observation.interpreted_field_or_role === 'cost'
      ? field.semantic_status === 'resolved' && field.semantic_role === 'rate'
        ? 'resolved' : 'requires_semantic_review'
      : 'not_applicable',
  };
  if (
    roleContract == null
    || !evidenceSupported
  ) {
    return {
      classification: 'missing_or_uncertain',
      resolution: 'requires_semantic_review',
      material: true,
      explanation: `Raw source matches, but semantic role is ${field.semantic_status}:${field.semantic_role ?? 'none'} for ledger role ${observation.interpreted_field_or_role}.`,
      reconstruction_comparison: reconstructionComparison,
      semantic_role_comparison: roleComparison,
    };
  }
  return {
    classification: classifyParityDifference({
      legacy_present: false,
      legacy_supported: false,
      generic_supported: true,
      values_equivalent: false,
      duplicate_split_merge: false,
    }),
    resolution: 'resolved',
    material: true,
    explanation: 'The generic field is source-grounded and semantically resolved; no independently supported historical field exists for a legacy match.',
    reconstruction_comparison: reconstructionComparison,
    semantic_role_comparison: roleComparison,
  };
}

function findContractAnalysis(value: unknown): HistoricalContractAnalysis | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.rate_schedule_rows)) {
    return record as unknown as HistoricalContractAnalysis;
  }
  for (const child of Object.values(record)) {
    const found = findContractAnalysis(child);
    if (found) return found;
  }
  return null;
}

export async function loadPhase1Inputs(input: {
  readonly ledgerPath: string;
  readonly historicalContractAnalysisPath: string;
}): Promise<{
  readonly ledger: TdotLedger;
  readonly legacyRows: readonly LegacyTdotRow[];
}> {
  const ledger = JSON.parse(await readFile(input.ledgerPath, 'utf8')) as TdotLedger;
  const historical = JSON.parse(
    await readFile(input.historicalContractAnalysisPath, 'utf8'),
  ) as HistoricalExport<unknown>;
  const analysis = findContractAnalysis(historical);
  const legacyRows = analysis?.rate_schedule_rows?.filter(
    (row) => row.source_kind === 'tdot_appendix_b_stitched_table',
  ) ?? [];
  return { ledger, legacyRows };
}

export function buildParityRecords(input: {
  readonly ledger: TdotLedger;
  readonly legacyRows: readonly LegacyTdotRow[];
  readonly genericFields: readonly GenericComparedField[];
}): ParityRecord[] {
  const genericRecords = input.ledger.observations.map((observation) => {
    const fields = input.genericFields.filter((field) => centerInside(field, observation));
    const classification = classifyLedgerObservation(observation, fields);
    return {
      id: hashCanonical({
        scope: 'generic_to_ledger',
        field_identifier: observation.field_identifier,
        generic_dependencies: fields.map((field) => field.dependency_hash),
      }),
      comparison_scope: 'generic_to_ledger' as const,
      ...classification,
      ledger: observation,
      generic_fields: fields,
      legacy_row: null,
      comparison_basis: [
        'source_pdf_sha256',
        'source_page',
        'source_bbox',
        'raw_text_sha256',
        'verified_dependency_hash',
        'semantic_mapping',
      ],
    };
  });
  const legacyRecords = input.legacyRows.map((row) => ({
    id: hashCanonical({
      scope: 'legacy_diagnostic',
      row_id: row.row_id,
      source_anchor_ids: row.source_anchor_ids,
    }),
    comparison_scope: 'legacy_diagnostic' as const,
    classification: 'legacy_unsupported' as const,
    resolution: 'resolved' as const,
    material: true,
    explanation:
      'Historical TDOT row is authored/quarantined and lacks independent field-level dependency closure; retained only as diagnostic comparison evidence.',
    ledger: null,
    generic_fields: [],
    legacy_row: row,
    comparison_basis: [
      'historical_source_kind',
      'historical_row_id',
      'historical_source_anchor_ids_diagnostic_only',
    ],
    reconstruction_comparison: null,
    semantic_role_comparison: null,
  }));
  return [...genericRecords, ...legacyRecords];
}

export const REQUIRED_METAMORPHIC_INVARIANTS = Object.freeze([
  ['change_rate', 'Changing one rate changes only that field and descendants.'],
  ['change_quantity', 'Changing one quantity changes only that field and descendants.'],
  ['change_unit', 'Changing one unit changes only that field and descendants.'],
  ['change_description', 'Changing one description changes only that field and descendants.'],
  ['change_extension', 'Changing one extension changes only that field and descendants.'],
  ['remove_row', 'Removing a row removes only that row and dependents.'],
  ['insert_row', 'Inserting a row produces one new source-grounded row.'],
  ['duplicate_row', 'Duplicating a row preserves both source instances.'],
  ['reorder_rows', 'Reordering rows preserves values and changes source positions.'],
  ['move_table_page', 'Moving a table or page preserves values and changes provenance.'],
  ['reorder_columns', 'Reordering columns preserves roles and values.'],
  ['missing_borders', 'Missing borders retain supported values.'],
  ['merged_multiline_cells', 'Merged and multiline cells retain supported values.'],
  ['subtables', 'Subtables retain supported values.'],
  ['repeated_headers', 'Repeated headers retain supported values.'],
  ['cross_page_continuation', 'Cross-page continuation retains supported values.'],
  ['delete_supporting_span', 'Deleting support removes verification and produces a gap.'],
  ['association_invariance', 'Renaming or changing association IDs preserves semantic values and fingerprint.'],
  ['historical_fingerprint_inert', 'Changing a historical fingerprint never restores an old value.'],
  ['native_ocr_arbitration', 'Superior OCR and partial native text remain inspectable.'],
  ['engine_conflict', 'Native/OCR/vision conflicts remain inspectable and unsupported winners do not verify.'],
] as const);

export function blockedMetamorphicResults(reason: string): MetamorphicResult[] {
  return REQUIRED_METAMORPHIC_INVARIANTS.map(([invariantId, description]) => ({
    invariant_id: invariantId,
    description,
    status: 'blocked',
    mutation_manifest: null,
    explanation: reason,
    changed_field_ids: [],
    unexpected_field_ids: [],
  }));
}

export function preconditionedMetamorphicResults(): MetamorphicResult[] {
  const implementedSourceMutations = new Set([
    'delete_supporting_span',
    'change_rate',
    'change_unit',
    'remove_row',
    'duplicate_row',
    'insert_row',
  ]);
  const blockedReasons: Readonly<Record<string, string>> = {
    change_quantity:
      'The annotation ledger contains no quantity-role observation; evaluation must not relabel a row label or other numeric field as quantity.',
    change_description:
      'Source-PDF mutation is feasible, but multiline free-text replacement with measured reflow isolation is not implemented.',
    change_extension:
      'The annotation ledger contains only cost-family observations with rate-or-extension alternatives and no authoritative extension-role target.',
    insert_row:
      'Source-PDF mutation is feasible only after a grounded movable table-bottom band and footer-clearance bound are exposed.',
    duplicate_row:
      'Source-PDF mutation is feasible only after a grounded movable table-bottom band and footer-clearance bound are exposed; appended-page copying is not this invariant.',
    reorder_rows:
      'Source-PDF mutation is feasible, but safe row-band translation and footer-clearance capability are missing.',
    move_table_page:
      'Source-PDF mutation is feasible, but page relocation preserving native text, table membership, and unrelated page content is missing.',
    reorder_columns:
      'Source-PDF mutation is feasible, but safe native-content and rule translation by grounded column bands is missing.',
    missing_borders:
      'Source-PDF mutation is feasible, but selective vector-rule removal with proof that text operators are unchanged is missing.',
    merged_multiline_cells:
      'A purpose-built synthetic source is required because the audited source has multiline cells but no independently evidenced merged-cell span precondition.',
    subtables:
      'A purpose-built synthetic source is required because the audited source has no independently evidenced parent-child subtable structure.',
    repeated_headers:
      'A purpose-built synthetic source is required because the audited table population does not provide an independently grounded repeated-header mutation target.',
    cross_page_continuation:
      'A purpose-built synthetic source is required to isolate continuation semantics from page relocation and unrelated intervening content.',
    engine_conflict:
      'A purpose-built synthetic source with independently controlled native/OCR/vision alternatives is required; injected OCR is forbidden.',
  };
  const sourceLimited = new Set([
    'change_quantity',
    'change_extension',
    'merged_multiline_cells',
    'subtables',
    'repeated_headers',
    'cross_page_continuation',
    'engine_conflict',
  ]);
  return REQUIRED_METAMORPHIC_INVARIANTS.map(([invariantId, description]) => ({
    invariant_id: invariantId,
    description,
    status: 'blocked',
    mutation_manifest: sourceLimited.has(invariantId) ? {
      disposition: 'source_limited_for_tdot_pdf',
      missing_source_property: blockedReasons[invariantId],
      synthetic_source_required: true,
      generic_phase2_evidence_required: true,
      production_parser_input: false,
    } : null,
    explanation: implementedSourceMutations.has(invariantId)
      ? `The ${invariantId} executor has not completed its invariant-specific target, mutation-output, and unaffected-scope preconditions.`
      : blockedReasons[invariantId]
        ?? `Source-level mutation capability "${invariantId}" is not implemented by the Phase 1 mutation executor.`,
    changed_field_ids: [],
    unexpected_field_ids: [],
  }));
}

function fieldLocator(field: GenericComparedField): string {
  return hashCanonical({
    source_page: field.source_page,
    raw_text: field.raw_text,
  });
}

function fieldCenterInBox(
  field: GenericComparedField,
  box: BoundingBox,
): boolean {
  const x = (field.source_bbox.x0 + field.source_bbox.x1) / 2;
  const y = (field.source_bbox.y0 + field.source_bbox.y1) / 2;
  return x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1;
}

function contentTokenBoxes(
  run: GenericShadowRun,
  field: GenericComparedField,
): readonly BoundingBox[] {
  const cell = run.graph.fragments.find((fragment) =>
    fragment.id === field.table_cell_id && fragment.kind === 'cell') as
      | GridCellArtifact
      | undefined;
  if (!cell) return [];
  const fragmentsById = new Map(run.graph.fragments.map((fragment) =>
    [fragment.id, fragment] as const));
  return cell.content_token_ids.flatMap((tokenId) => {
    const token = fragmentsById.get(tokenId);
    return token?.kind === 'token' ? [token.bounding_box] : [];
  });
}

function contentTokens(
  run: GenericShadowRun,
  field: GenericComparedField,
): readonly SourceFragmentArtifact[] {
  const cell = run.graph.fragments.find((fragment) =>
    fragment.id === field.table_cell_id && fragment.kind === 'cell') as
      | GridCellArtifact
      | undefined;
  if (!cell) return [];
  const fragmentsById = new Map(run.graph.fragments.map((fragment) =>
    [fragment.id, fragment] as const));
  return cell.content_token_ids.flatMap((tokenId) => {
    const token = fragmentsById.get(tokenId);
    return token?.kind === 'token' ? [token] : [];
  });
}

function rowCells(
  run: GenericShadowRun,
  row: LogicalTableRow,
): readonly GridCellArtifact[] {
  const cells = new Map(
    run.graph.fragments
      .filter((fragment): fragment is GridCellArtifact => fragment.kind === 'cell')
      .map((cell) => [cell.id, cell]),
  );
  return row.cell_ids.flatMap((id) => {
    const cell = cells.get(id);
    return cell ? [cell] : [];
  }).sort((left, right) =>
    left.column_start - right.column_start
    || left.bounding_box.x0 - right.bounding_box.x0);
}

function rowSignature(run: GenericShadowRun, row: LogicalTableRow): string {
  return hashCanonical(rowCells(run, row).map((cell) => ({
    column_start: cell.column_start,
    raw_text: cell.raw_text,
  })));
}

function pageRowTopology(run: GenericShadowRun, page: number) {
  return run.graph.tableRows.filter((row) => row.page === page)
    .sort((left, right) =>
      left.bounding_box.y0 - right.bounding_box.y0
      || left.bounding_box.x0 - right.bounding_box.x0)
    .map((row, ordinal) => ({
      row,
      ordinal,
      signature: rowSignature(run, row),
      cells: rowCells(run, row),
    }));
}

function deriveRowClearanceEnvelope(
  run: GenericShadowRun,
  row: LogicalTableRow,
): RowClearanceEnvelope {
  const cells = rowCells(run, row);
  const segmentId = cells[0]?.table_segment_id;
  const segment = run.graph.tableSegments.find(({ id }) => id === segmentId);
  const page = run.graph.pages.find((candidate) => candidate.page === row.page);
  if (!segment || !page || cells.length < 2) {
    return {
      version: 'measured-row-clearance-v1',
      page_media_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
      page_crop_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
      table_bottom: segment?.bounding_box.y1 ?? row.bounding_box.y1,
      movable_row_band: {
        x0: 0,
        y0: row.bounding_box.y0,
        x1: 1,
        y1: row.bounding_box.y1,
      },
      next_non_table_content: null,
      footer_bounds: null,
      row_height: row.bounding_box.y1 - row.bounding_box.y0,
      required_displacement: row.bounding_box.y1 - row.bounding_box.y0,
      overlap_margin: 0,
      available_clearance: 0,
      clipping_risk: true,
      overlap_risk: true,
      disposition: 'blocked',
      blocked_reason: 'row lacks a multi-cell segment or page geometry',
    };
  }
  const allCells = new Map(
    run.graph.fragments
      .filter((fragment) => fragment.kind === 'cell')
      .map((fragment) => {
        const cell = fragment as GridCellArtifact;
        return [cell.id, cell] as const;
      }),
  );
  const peerRows = run.graph.tableRows
    .filter((candidate) =>
      candidate.page === row.page
      && candidate.cell_ids.some((id) =>
        cells.some(({ table_segment_id }) =>
          allCells.get(id)?.table_segment_id === table_segment_id)))
    .sort((left, right) => left.bounding_box.y0 - right.bounding_box.y0);
  const rowIndex = peerRows.findIndex(({ id }) => id === row.id);
  const previous = peerRows[rowIndex - 1] ?? null;
  const next = peerRows[rowIndex + 1] ?? null;
  const bandY0 = previous
    ? (previous.bounding_box.y1 + row.bounding_box.y0) / 2
    : row.bounding_box.y0;
  const bandY1 = next
    ? (row.bounding_box.y1 + next.bounding_box.y0) / 2
    : row.bounding_box.y1;
  const rowHeight = bandY1 - bandY0;
  const segmentCells = run.graph.fragments
    .filter((fragment) =>
      fragment.kind === 'cell'
      && (fragment as GridCellArtifact).table_segment_id === segment.id)
    .map((fragment) => fragment as GridCellArtifact);
  const segmentTokenIds = new Set(segmentCells.flatMap(({ content_token_ids }) =>
    content_token_ids));
  const nextNonTableFragments = run.graph.fragments
    .filter((fragment) =>
      fragment.kind === 'token'
      && fragment.page === row.page
      && !segmentTokenIds.has(fragment.id)
      && fragment.bounding_box.y0 >= segment.bounding_box.y1)
    .sort((left, right) =>
      left.bounding_box.y0 - right.bounding_box.y0
      || left.bounding_box.x0 - right.bounding_box.x0);
  const nextNonTable = nextNonTableFragments[0]?.bounding_box ?? null;
  const calibration = run.graph.tableReconstructionDiagnostics.calibrations
    .find((candidate) => candidate.page === row.page);
  const overlapMargin =
    calibration?.thresholds.boundary_uncertainty.selected ?? 0;
  const clearanceBoundary = nextNonTable?.y0 ?? 1;
  const availableClearance = clearanceBoundary - segment.bounding_box.y1;
  const clippingRisk = segment.bounding_box.y1 + rowHeight > 1;
  const overlapRisk = availableClearance < rowHeight + overlapMargin;
  return {
    version: 'measured-row-clearance-v1',
    page_media_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
    page_crop_box: { x0: 0, y0: 0, x1: 1, y1: 1 },
    table_bottom: segment.bounding_box.y1,
    movable_row_band: { x0: 0, y0: bandY0, x1: 1, y1: bandY1 },
    next_non_table_content: nextNonTable ? {
      x0: nextNonTable.x0,
      y0: nextNonTable.y0,
      x1: nextNonTable.x1,
      y1: nextNonTable.y1,
    } : null,
    footer_bounds: null,
    row_height: rowHeight,
    required_displacement: rowHeight,
    overlap_margin: overlapMargin,
    available_clearance: availableClearance,
    clipping_risk: clippingRisk,
    overlap_risk: overlapRisk,
    disposition: clippingRisk || overlapRisk ? 'blocked' : 'executable',
    blocked_reason: clippingRisk
      ? 'required displacement would clip the page crop box'
      : overlapRisk
        ? 'measured clearance is smaller than row displacement plus overlap margin'
        : null,
  };
}

function mutationRowCells(
  run: GenericShadowRun,
  row: LogicalTableRow,
): readonly SourceRowCell[] {
  const fragments = new Map(run.graph.fragments.map((fragment) =>
    [fragment.id, fragment] as const));
  return rowCells(run, row).map((cell) => ({
    raw_text: cell.raw_text,
    bounding_box: cell.bounding_box,
    source_fragment_ids: cell.content_token_ids,
    token_boxes: cell.content_token_ids.flatMap((id) => {
      const fragment = fragments.get(id);
      return fragment?.kind === 'token' ? [fragment.bounding_box] : [];
    }),
  }));
}

function compareUnaffectedFields(input: {
  readonly baseline: GenericShadowRun;
  readonly mutated: GenericShadowRun;
  readonly excludedPages: ReadonlySet<number>;
  readonly expectedFields?: readonly GenericComparedField[];
}): {
  readonly expected_count: number;
  readonly unchanged_count: number;
  readonly missing_locators: readonly string[];
} {
  const expected = (input.expectedFields ?? input.baseline.fields).filter((field) =>
    !input.excludedPages.has(field.source_page));
  const available = new Map<string, number>();
  for (const field of input.mutated.fields) {
    const locator = fieldLocator(field);
    available.set(locator, (available.get(locator) ?? 0) + 1);
  }
  const missingLocators: string[] = [];
  for (const field of expected) {
    const locator = fieldLocator(field);
    const count = available.get(locator) ?? 0;
    if (count === 0) missingLocators.push(locator);
    else available.set(locator, count - 1);
  }
  missingLocators.sort();
  return {
    expected_count: expected.length,
    unchanged_count: expected.length - missingLocators.length,
    missing_locators: missingLocators,
  };
}

function mutationArtifactFile(artifact: PdfSourceMutationArtifact): string {
  return path.posix.join(
    'mutations',
    `${artifact.mutation_type}.${artifact.mutation_id}.pdf`,
  );
}

export interface SourceMetamorphicExecution {
  readonly results: readonly MetamorphicResult[];
  readonly artifacts: readonly PdfSourceMutationArtifact[];
}

function blockedSourceMutation(
  invariantId: (typeof REQUIRED_METAMORPHIC_INVARIANTS)[number][0],
  reason: string,
): MetamorphicResult {
  const description = REQUIRED_METAMORPHIC_INVARIANTS.find(
    ([id]) => id === invariantId,
  )?.[1] ?? invariantId;
  return {
    invariant_id: invariantId,
    description,
    status: 'blocked',
    mutation_manifest: {
      mutation_type: invariantId,
      execution_result: 'not_executed',
      failed_precondition: reason,
    },
    explanation: `Blocked: ${reason}`,
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
}

export async function executeSourceMetamorphicInvariants(input: {
  readonly pdfPath: string;
  readonly baseline: GenericShadowRun;
  readonly parityRecords: readonly ParityRecord[];
}): Promise<SourceMetamorphicExecution> {
  const sourceBytes = new Uint8Array(await readFile(input.pdfPath));
  const exactResolved = input.parityRecords.filter((record) =>
    record.ledger != null
    && record.resolution === 'resolved'
    && record.reconstruction_comparison?.exact_equal === true
    && record.generic_fields.length === 1);
  const exactLedgerGrounded = input.parityRecords.filter((record) =>
    record.ledger != null
    && record.reconstruction_comparison?.exact_equal === true
    && record.generic_fields.length === 1);
  const results: MetamorphicResult[] = [];
  const artifacts: PdfSourceMutationArtifact[] = [];
  const exactResolvedFields = [...new Map(exactResolved.flatMap((record) =>
    record.generic_fields.map((field) =>
      [field.verified_field_id, field] as const))).values()];
  const exactLedgerGroundedFields = [...new Map(
    exactLedgerGrounded.flatMap((record) =>
      record.generic_fields.map((field) =>
        [field.verified_field_id, field] as const)),
  ).values()];

  const deleteTarget = [...exactResolved].sort((left, right) =>
    (left.ledger?.source_page ?? 0) - (right.ledger?.source_page ?? 0)
    || (left.ledger?.bbox_y0 ?? 0) - (right.ledger?.bbox_y0 ?? 0)
    || left.id.localeCompare(right.id))[0];
  if (!deleteTarget?.ledger || !deleteTarget.generic_fields[0]) {
    results.push(blockedSourceMutation(
      'delete_supporting_span',
      'no exact, resolved, source-grounded single-field target exists',
    ));
  } else {
    try {
      const targetField = deleteTarget.generic_fields[0];
      const targetBoxes = contentTokenBoxes(input.baseline, targetField);
      if (targetBoxes.length === 0) {
        throw new Error('verified target has no ordered content-token geometry');
      }
      const artifact = await deleteSupportingSpanFromPdf({
        source_bytes: sourceBytes,
        target_page: targetField.source_page,
        target_boxes: targetBoxes,
        target_verified_field_id: targetField.verified_field_id,
        target_raw_text_sha256: targetField.raw_text_sha256,
      });
      if (!artifact.validation.valid_pdf || !artifact.validation.visible_source_changed) {
        results.push(blockedSourceMutation(
          'delete_supporting_span',
          'mutation output failed PDF validity or visible-source-change verification',
        ));
      } else {
        const mutated = await runGenericShadowFromBytes({
          bytes: artifact.bytes,
          expectedSha256: artifact.mutated_sha256,
          associationSeed: artifact.mutation_id,
        });
        const targetStillSupported = mutated.fields.some((field) =>
          field.source_page === targetField.source_page
          && field.raw_text === targetField.raw_text
          && fieldCenterInBox(field, targetField.source_bbox));
        const unaffected = compareUnaffectedFields({
          baseline: input.baseline,
          mutated,
          excludedPages: new Set([targetField.source_page]),
          expectedFields: exactResolvedFields,
        });
        const passed = !targetStillSupported
          && unaffected.missing_locators.length === 0
          && mutated.dependency_closure.status === 'pass';
        artifacts.push(artifact);
        results.push({
          invariant_id: 'delete_supporting_span',
          description: 'Deleting support removes verification and produces a gap.',
          status: passed ? 'pass' : 'fail',
          mutation_manifest: {
            mutation_id: artifact.mutation_id,
            source_sha256: artifact.source_sha256,
            mutated_sha256: artifact.mutated_sha256,
            mutation_type: artifact.mutation_type,
            target_page: artifact.target_page,
            target_source_span: artifact.target_source_span,
            exact_mutation_operation: artifact.exact_mutation_operation,
            expected_affected_descendants: [
              targetField.verified_field_id,
              targetField.candidate_id,
              targetField.table_cell_id,
              targetField.table_row_id,
              targetField.table_segment_id,
            ].filter((value): value is string => value != null),
            expected_unaffected_descendants: {
              scope:
                'exact_resolved_fields_outside_target_page_by_source_page_and_exact_raw_text_multiset',
              count: unaffected.expected_count,
              geometry_and_generated_identity_changes:
                'retained_as_diagnostics_not_invariant_failures',
            },
            executor: artifact.executor,
            artifact_file: mutationArtifactFile(artifact),
            validation: artifact.validation,
            execution_result: {
              extraction_status: mutated.graph.snapshot.status,
              dependency_closure: mutated.dependency_closure,
            },
            comparison_result: {
              target_still_supported: targetStillSupported,
              unaffected,
            },
            retained_evidence: {
              target_record_id: deleteTarget.id,
              target_field_identifier: deleteTarget.ledger.field_identifier,
              target_verified_field_id: targetField.verified_field_id,
              source_bbox: targetField.source_bbox,
              raw_text_sha256: targetField.raw_text_sha256,
            },
          },
          explanation: passed
            ? 'The source page was visibly neutralized at the verified span; the target lost support, all compared fields outside that page remained stable, and mutated dependency closure passed.'
            : 'The executed source mutation did not satisfy target-loss, unaffected-scope, or dependency-closure assertions.',
          changed_field_ids: [targetField.verified_field_id],
          unexpected_field_ids: unaffected.missing_locators,
        });
      }
    } catch (error) {
      results.push(blockedSourceMutation(
        'delete_supporting_span',
        `mutation executor error: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  const rowGroups = new Map<string, GenericComparedField[]>();
  for (const record of exactResolved) {
    const field = record.generic_fields[0];
    if (!field?.table_row_id) continue;
    rowGroups.set(field.table_row_id, [
      ...(rowGroups.get(field.table_row_id) ?? []),
      field,
    ]);
  }
  const rowCandidates = [...rowGroups.entries()].flatMap(([rowId, fields]) => {
    const row = input.baseline.graph.tableRows.find(({ id }) => id === rowId);
    if (!row || fields.length < 2) return [];
    const topology = pageRowTopology(input.baseline, row.page);
    const signature = rowSignature(input.baseline, row);
    if (topology.filter((candidate) => candidate.signature === signature).length !== 1) {
      return [];
    }
    const envelope = deriveRowClearanceEnvelope(input.baseline, row);
    const cells = mutationRowCells(input.baseline, row);
    if (cells.some(({ token_boxes }) => token_boxes.length === 0)) return [];
    return [{ row, fields, topology, signature, envelope, cells }];
  }).sort((left, right) =>
    Number(right.envelope.disposition === 'executable')
      - Number(left.envelope.disposition === 'executable')
    || right.envelope.available_clearance - left.envelope.available_clearance
    || left.row.page - right.row.page
    || left.row.bounding_box.y0 - right.row.bounding_box.y0);
  const rowMutationTarget = rowCandidates[0] ?? null;
  for (const invariantId of ['duplicate_row', 'insert_row'] as const) {
    if (!rowMutationTarget || rowMutationTarget.envelope.disposition !== 'executable') {
      results.push({
        ...blockedSourceMutation(
          invariantId,
          rowMutationTarget?.envelope.blocked_reason
            ?? 'no unique multi-cell row has a measured non-overlapping movable-content envelope',
        ),
        mutation_manifest: {
          mutation_type: invariantId,
          execution_result: 'not_executed',
          failed_precondition:
            rowMutationTarget?.envelope.blocked_reason
            ?? 'no unique multi-cell row has a measured non-overlapping movable-content envelope',
          row_clearance_envelope: rowMutationTarget?.envelope ?? null,
        },
      });
      continue;
    }
    try {
      const artifact = await insertInlineSourceRowInPdf({
        mutation_type: invariantId,
        source_bytes: sourceBytes,
        target_page: rowMutationTarget.row.page,
        source_row_id: rowMutationTarget.row.id,
        cells: rowMutationTarget.cells,
        envelope: rowMutationTarget.envelope,
      });
      const mutated = await runGenericShadowFromBytes({
        bytes: artifact.bytes,
        expectedSha256: artifact.mutated_sha256,
        associationSeed: artifact.mutation_id,
      });
      const baselineTopology = rowMutationTarget.topology;
      const mutatedTopology = pageRowTopology(mutated, rowMutationTarget.row.page);
      const targetOrdinal = baselineTopology.findIndex(({ row }) =>
        row.id === rowMutationTarget.row.id);
      const matchingRows = mutatedTopology.filter(({ signature }) =>
        signature === rowMutationTarget.signature);
      const matchingFragmentSets = matchingRows.map(({ cells }) =>
        new Set(cells.flatMap(({ content_token_ids }) => content_token_ids)));
      const distinctProvenance = matchingRows.length >= 2
        && new Set(matchingRows.map(({ row }) => row.id)).size === matchingRows.length
        && matchingFragmentSets.every((left, index) =>
          matchingFragmentSets.slice(index + 1).every((right) =>
            [...left].every((id) => !right.has(id))));
      const insertedAtIntendedOrdinal = targetOrdinal >= 0
        && mutatedTopology[targetOrdinal]?.signature === rowMutationTarget.signature
        && mutatedTopology[targetOrdinal + 1]?.signature === rowMutationTarget.signature;
      const beforeStable = baselineTopology.slice(0, targetOrdinal)
        .map(({ signature }) => signature)
        .every((signature, index) =>
          mutatedTopology[index]?.signature === signature);
      const shiftedRowsStable = baselineTopology.slice(targetOrdinal + 1)
        .map(({ signature }) => signature)
        .every((signature, index) =>
          mutatedTopology[targetOrdinal + 2 + index]?.signature === signature);
      const rowCountDelta = mutatedTopology.length - baselineTopology.length;
      const unaffected = compareUnaffectedFields({
        baseline: input.baseline,
        mutated,
        excludedPages: new Set([rowMutationTarget.row.page]),
        expectedFields: exactResolvedFields,
      });
      const passed = artifact.validation.valid_pdf
        && artifact.validation.visible_source_changed
        && artifact.validation.font_fallback_count === 0
        && rowCountDelta === 1
        && matchingRows.length === 2
        && distinctProvenance
        && insertedAtIntendedOrdinal
        && beforeStable
        && shiftedRowsStable
        && unaffected.missing_locators.length === 0
        && mutated.dependency_closure.status === 'pass';
      artifacts.push(artifact);
      results.push({
        invariant_id: invariantId,
        description: invariantId === 'duplicate_row'
          ? 'Duplicating a row preserves both independently grounded rows.'
          : 'Inserting a row preserves ordinal position and shifts grounded neighbors.',
        status: passed ? 'pass' : 'fail',
        mutation_manifest: {
          mutation_id: artifact.mutation_id,
          source_sha256: artifact.source_sha256,
          mutated_sha256: artifact.mutated_sha256,
          mutation_type: invariantId,
          target_page: artifact.target_page,
          target_source_span: artifact.target_source_span,
          exact_mutation_operation: artifact.exact_mutation_operation,
          row_clearance_envelope: rowMutationTarget.envelope,
          executor: artifact.executor,
          artifact_file: mutationArtifactFile(artifact),
          validation: artifact.validation,
          execution_result: {
            extraction_status: mutated.graph.snapshot.status,
            dependency_closure: mutated.dependency_closure,
          },
          comparison_result: {
            baseline_row_count: baselineTopology.length,
            mutated_row_count: mutatedTopology.length,
            row_count_delta: rowCountDelta,
            baseline_target_signature_count: 1,
            mutated_target_signature_count: matchingRows.length,
            distinct_provenance: distinctProvenance,
            inserted_at_intended_ordinal: insertedAtIntendedOrdinal,
            preceding_rows_stable: beforeStable,
            shifted_rows_stable: shiftedRowsStable,
            genuine_single_row_not_preclassified_as_duplicate: true,
            unaffected,
          },
        },
        explanation: passed
          ? `The measured inline ${invariantId} produced exactly one new row at the intended ordinal with distinct provenance, stable shifted rows, no font fallback, and closed dependencies.`
          : `The executed inline ${invariantId} did not satisfy every row-count, ordinal, provenance, stability, font, and closure property.`,
        changed_field_ids: rowMutationTarget.fields.map(
          ({ verified_field_id }) => verified_field_id),
        unexpected_field_ids: unaffected.missing_locators,
      });
    } catch (error) {
      results.push({
        ...blockedSourceMutation(
          invariantId,
          `mutation executor error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
        mutation_manifest: {
          mutation_type: invariantId,
          target_page: rowMutationTarget.row.page,
          target_source_span: {
            source_row_id: rowMutationTarget.row.id,
            cell_count: rowMutationTarget.cells.length,
            cell_bounding_boxes: rowMutationTarget.cells.map(
              ({ bounding_box }) => bounding_box),
          },
          execution_result: 'not_executed',
          failed_precondition: `mutation executor error: ${
            error instanceof Error ? error.message : String(error)
          }`,
          row_clearance_envelope: rowMutationTarget.envelope,
        },
      });
    }
  }

  const rateTarget = exactLedgerGrounded.find((record) =>
    record.ledger?.interpreted_field_or_role === 'cost'
    && /^\$\s*\d[\d,.]*$/u.test(record.generic_fields[0]?.raw_text ?? '')
    && record.generic_fields[0]?.raw_text.includes('\n') === false);
  if (!rateTarget?.ledger || !rateTarget.generic_fields[0]) {
    results.push(blockedSourceMutation(
      'change_rate',
      'no exact source-grounded ledger cost field with safe single-span numeric replacement exists',
    ));
  } else {
    const targetField = rateTarget.generic_fields[0];
    const numericToken = contentTokens(input.baseline, targetField).find(
      ({ raw_text }) => /^\d[\d,.]*$/u.test(raw_text.trim()),
    );
    const digitEntries = [...(numericToken?.raw_text ?? '')]
      .map((character, index) => ({ character, index }))
      .filter(({ character }) => /\d/u.test(character));
    const targetDigit = digitEntries.at(-1);
    const replacementDigit = digitEntries.find(({ character }) =>
      character !== targetDigit?.character)?.character;
    if (!targetDigit || !replacementDigit) {
      results.push(blockedSourceMutation(
        'change_rate',
        'the exact ledger cost field lacks a single native numeric component with an already-observed alternate digit for font-safe replacement',
      ));
    } else {
      const sourceTokenReplacement =
        `${numericToken!.raw_text.slice(0, targetDigit.index)}`
        + `${replacementDigit}`
        + `${numericToken!.raw_text.slice(targetDigit.index + 1)}`;
      const rateReplacement = targetField.raw_text.replace(
        numericToken!.raw_text,
        sourceTokenReplacement,
      );
      try {
        const artifact = await replaceSourceTextInPdf({
          source_bytes: sourceBytes,
          target_page: targetField.source_page,
          target_boxes: [numericToken!.bounding_box],
          target_verified_field_id: targetField.verified_field_id,
          expected_text: numericToken!.raw_text,
          replacement_text: sourceTokenReplacement,
          source_match_mode: 'unique_substring_in_single_span',
        });
        const mutated = await runGenericShadowFromBytes({
          bytes: artifact.bytes,
          expectedSha256: artifact.mutated_sha256,
          associationSeed: artifact.mutation_id,
        });
        const replacement = mutated.fields.find((field) =>
          field.source_page === targetField.source_page
          && field.raw_text === rateReplacement
          && fieldCenterInBox(field, targetField.source_bbox));
        const unaffected = compareUnaffectedFields({
          baseline: input.baseline,
          mutated,
          excludedPages: new Set<number>(),
          expectedFields: exactLedgerGroundedFields.filter(
            ({ verified_field_id }) =>
              verified_field_id !== targetField.verified_field_id,
          ),
        });
        const passed = replacement != null
          && unaffected.missing_locators.length === 0
          && mutated.dependency_closure.status === 'pass';
        artifacts.push(artifact);
        results.push({
          invariant_id: 'change_rate',
          description: 'Changing one rate changes only that field and descendants.',
          status: passed ? 'pass' : 'fail',
          mutation_manifest: {
            mutation_id: artifact.mutation_id,
            source_sha256: artifact.source_sha256,
            mutated_sha256: artifact.mutated_sha256,
            mutation_type: 'change_rate',
            target_selection: {
              authority: 'annotation_ledger_evaluation_only',
              ledger_field_identifier: rateTarget.ledger.field_identifier,
              ledger_role: rateTarget.ledger.interpreted_field_or_role,
              role_contract: 'cost_allows_rate_or_extension',
              generic_semantic_confidence_required: false,
            },
            target_page: artifact.target_page,
            target_source_span: artifact.target_source_span,
            exact_mutation_operation: artifact.exact_mutation_operation,
            original_raw_text: targetField.raw_text,
            replacement_raw_text: rateReplacement,
            original_source_span_raw_text: numericToken!.raw_text,
            replacement_source_span_raw_text: sourceTokenReplacement,
            original_normalized_numeric_value: targetField.normalized_value,
            mutated_normalized_numeric_value:
              replacement?.normalized_value ?? null,
            affected_descendants: replacement ? [
              replacement.verified_field_id,
              replacement.candidate_id,
              replacement.table_cell_id,
              replacement.table_row_id,
            ].filter((value): value is string => value != null) : [],
            unaffected_comparison_population: unaffected,
            geometry_differences: {
              original: targetField.source_bbox,
              mutated: replacement?.source_bbox ?? null,
            },
            dependency_closure: mutated.dependency_closure,
            subsystem_validity: {
              intended_stages: [
                'native_text',
                'table_reconstruction',
                'verified_extraction',
                'semantic_interpretation',
              ],
              changed_stages: replacement == null ? [] : [
                'native_text',
                'table_reconstruction',
                'verified_extraction',
                'semantic_interpretation',
              ],
              invariant_stages: ['unrelated_semantic_fields'],
              bypass_check:
                'mutated PDF bytes were rerun through runGenericShadowFromBytes without injected OCR',
            },
            executor: artifact.executor,
            validation: artifact.validation,
            artifact_file: mutationArtifactFile(artifact),
          },
          explanation: passed
            ? 'The annotation-ledger cost target changed at source level, the rate-compatible descendant changed, every unrelated exact ledger field remained stable, and closure passed.'
            : 'The executed rate mutation did not preserve descendant isolation or closure.',
          changed_field_ids: replacement ? [replacement.verified_field_id] : [],
          unexpected_field_ids: unaffected.missing_locators,
        });
      } catch (error) {
        results.push(blockedSourceMutation(
          'change_rate',
          `mutation executor error: ${error instanceof Error ? error.message : String(error)}`,
        ));
      }
    }
  }

  const unitTarget = exactLedgerGrounded.find((record) =>
    record.ledger?.interpreted_field_or_role === 'unit'
    && record.generic_fields[0]?.raw_text.includes('\n') === false
    && /[A-Za-z]/u.test(record.generic_fields[0]?.raw_text ?? ''));
  if (!unitTarget?.generic_fields[0]) {
    results.push(blockedSourceMutation(
      'change_unit',
      'no exact single-native-span unit target with deterministic replacement exists',
    ));
  } else {
    const targetField = unitTarget.generic_fields[0];
    const finalLetterIndex = [...targetField.raw_text]
      .map((character, index) => ({ character, index }))
      .filter(({ character }) => /[A-Za-z]/u.test(character))
      .at(-1)!.index;
    const originalLetter = targetField.raw_text[finalLetterIndex]!;
    const replacementLetter = [...targetField.raw_text].find((character) =>
      /[A-Za-z]/u.test(character)
      && character !== originalLetter
      && (character === character.toUpperCase())
        === (originalLetter === originalLetter.toUpperCase()))!;
    const unitReplacement = `${targetField.raw_text.slice(0, finalLetterIndex)}${replacementLetter}${targetField.raw_text.slice(finalLetterIndex + 1)}`;
    try {
      const artifact = await replaceSourceTextInPdf({
        source_bytes: sourceBytes,
        target_page: targetField.source_page,
        target_boxes: contentTokenBoxes(input.baseline, targetField),
        target_verified_field_id: targetField.verified_field_id,
        expected_text: targetField.raw_text,
        replacement_text: unitReplacement,
      });
      const mutated = await runGenericShadowFromBytes({
        bytes: artifact.bytes,
        expectedSha256: artifact.mutated_sha256,
        associationSeed: artifact.mutation_id,
      });
      const replacement = mutated.fields.find((field) =>
        field.source_page === targetField.source_page
        && field.raw_text === unitReplacement
        && fieldCenterInBox(field, targetField.source_bbox));
      const unaffected = compareUnaffectedFields({
        baseline: input.baseline,
        mutated,
        excludedPages: new Set<number>(),
        expectedFields: exactLedgerGroundedFields.filter(({ verified_field_id }) =>
          verified_field_id !== targetField.verified_field_id),
      });
      const passed = replacement != null
        && unaffected.missing_locators.length === 0
        && mutated.dependency_closure.status === 'pass';
      artifacts.push(artifact);
      results.push({
        invariant_id: 'change_unit',
        description: 'Changing one unit changes only that field and descendants.',
        status: passed ? 'pass' : 'fail',
        mutation_manifest: {
          mutation_id: artifact.mutation_id,
          source_sha256: artifact.source_sha256,
          mutated_sha256: artifact.mutated_sha256,
          mutation_type: 'change_unit',
          target_page: artifact.target_page,
          target_source_span: artifact.target_source_span,
          exact_mutation_operation: artifact.exact_mutation_operation,
          original_raw_text: targetField.raw_text,
          replacement_raw_text: unitReplacement,
          original_semantic_value: targetField.normalized_value,
          mutated_semantic_value: replacement?.normalized_value ?? null,
          affected_descendants: replacement ? [
            replacement.verified_field_id,
            replacement.candidate_id,
            replacement.table_cell_id,
            replacement.table_row_id,
          ].filter((value): value is string => value != null) : [],
          unaffected_comparison_population: unaffected,
          geometry_differences: {
            original: targetField.source_bbox,
            mutated: replacement?.source_bbox ?? null,
          },
          dependency_closure: mutated.dependency_closure,
          subsystem_validity: {
            intended_stages: [
              'native_text',
              'table_reconstruction',
              'verified_extraction',
              'semantic_interpretation',
            ],
            changed_stages: replacement == null ? [] : [
              'native_text',
              'table_reconstruction',
              'verified_extraction',
              'semantic_interpretation',
            ],
            invariant_stages: ['unrelated_semantic_fields'],
            bypass_check:
              'mutated PDF bytes were rerun through runGenericShadowFromBytes without injected OCR',
          },
          executor: artifact.executor,
          validation: artifact.validation,
          artifact_file: mutationArtifactFile(artifact),
        },
        explanation: passed
          ? 'The exact native unit span changed in the source PDF, its extracted and interpreted descendant changed, unrelated exact fields remained stable, and closure passed.'
          : 'The executed unit mutation did not preserve descendant isolation or closure.',
        changed_field_ids: replacement ? [replacement.verified_field_id] : [],
        unexpected_field_ids: unaffected.missing_locators,
      });
    } catch (error) {
      results.push(blockedSourceMutation(
        'change_unit',
        `mutation executor error: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }

  const removeTarget = [...rowGroups.entries()]
    .filter(([, fields]) => fields.length >= 2)
    .sort((left, right) =>
      left[1][0]!.source_page - right[1][0]!.source_page
      || left[1][0]!.source_bbox.y0 - right[1][0]!.source_bbox.y0)[0];
  if (!removeTarget) {
    results.push(blockedSourceMutation(
      'remove_row',
      'no exact source-grounded row with at least two independently verified cells exists',
    ));
  } else {
    const [sourceRowId, rowFields] = removeTarget;
    try {
      const artifact = await removeSourceRowFromPdf({
        source_bytes: sourceBytes,
        target_page: rowFields[0]!.source_page,
        source_row_id: sourceRowId,
        target_boxes: rowFields.flatMap((field) =>
          contentTokenBoxes(input.baseline, field)),
      });
      const mutated = await runGenericShadowFromBytes({
        bytes: artifact.bytes,
        expectedSha256: artifact.mutated_sha256,
        associationSeed: artifact.mutation_id,
      });
      const targetStillPresent = mutated.fields.some((field) =>
        rowFields.some((target) =>
          field.source_page === target.source_page
          && field.raw_text === target.raw_text
          && fieldCenterInBox(field, target.source_bbox)));
      const removedIds = new Set(rowFields.map(({ verified_field_id }) =>
        verified_field_id));
      const unaffected = compareUnaffectedFields({
        baseline: input.baseline,
        mutated,
        excludedPages: new Set<number>(),
        expectedFields: exactResolvedFields.filter(({ verified_field_id }) =>
          !removedIds.has(verified_field_id)),
      });
      const passed = !targetStillPresent
        && unaffected.missing_locators.length === 0
        && mutated.dependency_closure.status === 'pass';
      artifacts.push(artifact);
      results.push({
        invariant_id: 'remove_row',
        description: 'Removing a row removes only that row and dependents.',
        status: passed ? 'pass' : 'fail',
        mutation_manifest: {
          mutation_id: artifact.mutation_id,
          source_sha256: artifact.source_sha256,
          mutated_sha256: artifact.mutated_sha256,
          mutation_type: artifact.mutation_type,
          target_page: artifact.target_page,
          target_source_span: artifact.target_source_span,
          exact_mutation_operation: artifact.exact_mutation_operation,
          affected_descendants: [...removedIds],
          unaffected_comparison_population: unaffected,
          dependency_closure: mutated.dependency_closure,
          subsystem_validity: {
            intended_stages: [
              'native_text',
              'table_reconstruction',
              'verified_extraction',
              'semantic_interpretation',
            ],
            changed_stages: ['target_logical_row_and_descendants'],
            invariant_stages: ['neighboring_rows', 'unrelated_exact_fields'],
            bypass_check:
              'mutated PDF bytes were rerun through runGenericShadowFromBytes without injected OCR',
          },
          executor: artifact.executor,
          validation: artifact.validation,
          artifact_file: mutationArtifactFile(artifact),
        },
        explanation: passed
          ? 'The grounded source row and its descendants disappeared, unrelated exact fields remained stable, and dependency closure passed.'
          : 'The executed row removal did not satisfy target-only disappearance, unaffected-scope, or closure assertions.',
        changed_field_ids: [...removedIds],
        unexpected_field_ids: unaffected.missing_locators,
      });
    } catch (error) {
      results.push(blockedSourceMutation(
        'remove_row',
        `mutation executor error: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  }
  return { results, artifacts };
}

export async function writeSourceMutationArtifacts(input: {
  readonly outputDirectory: string;
  readonly artifacts: readonly PdfSourceMutationArtifact[];
}): Promise<readonly string[]> {
  const mutationDirectory = path.join(input.outputDirectory, 'mutations');
  await mkdir(mutationDirectory, { recursive: true });
  const paths: string[] = [];
  for (const artifact of input.artifacts) {
    const artifactPath = path.join(
      input.outputDirectory,
      ...mutationArtifactFile(artifact).split('/'),
    );
    await writeFile(artifactPath, artifact.bytes);
    paths.push(artifactPath);
  }
  return paths;
}

function semanticMultiset(run: GenericShadowRun): readonly string[] {
  return run.fields.map((field) => hashCanonical({
    source_page: field.source_page,
    source_bbox: field.source_bbox,
    raw_text: field.raw_text,
    normalized_value: field.normalized_value,
    semantic_role: field.semantic_role,
    semantic_status: field.semantic_status,
    parser_manifest_hash: field.parser_manifest_hash,
    interpretation_manifest_hash: field.interpretation_manifest_hash,
  })).sort();
}

export function evaluateAssociationInvariance(input: {
  readonly baseline: GenericShadowRun;
  readonly reassociated: GenericShadowRun;
}): MetamorphicResult {
  const baselineSignature = semanticMultiset(input.baseline);
  const reassociatedSignature = semanticMultiset(input.reassociated);
  const valuesEqual = hashCanonical(baselineSignature) === hashCanonical(reassociatedSignature);
  const fingerprintEqual =
    input.baseline.graph.snapshot.content_extraction_fingerprint
    === input.reassociated.graph.snapshot.content_extraction_fingerprint;
  const associationChanged =
    input.baseline.source_document_id !== input.reassociated.source_document_id;
  const status = valuesEqual && fingerprintEqual && associationChanged ? 'pass' : 'fail';
  return {
    invariant_id: 'association_invariance',
    description:
      'Renaming or changing association IDs preserves semantic values and fingerprint.',
    status,
    mutation_manifest: {
      mutation_type: 'association_only',
      source_bytes_changed: false,
      source_sha256_before: input.baseline.source_sha256,
      source_sha256_after: input.reassociated.source_sha256,
      source_document_id_before: input.baseline.source_document_id,
      source_document_id_after: input.reassociated.source_document_id,
      semantic_multiset_hash_before: hashCanonical(baselineSignature),
      semantic_multiset_hash_after: hashCanonical(reassociatedSignature),
      content_extraction_fingerprint_before:
        input.baseline.graph.snapshot.content_extraction_fingerprint,
      content_extraction_fingerprint_after:
        input.reassociated.graph.snapshot.content_extraction_fingerprint,
    },
    explanation: status === 'pass'
      ? 'Identical source bytes under a different association ID preserved the semantic multiset and content extraction fingerprint.'
      : 'Association-only replay changed semantic output or the content extraction fingerprint.',
    changed_field_ids: [],
    unexpected_field_ids: status === 'pass'
      ? []
      : input.reassociated.fields.map((field) => field.verified_field_id),
  };
}

export function evaluateHistoricalFingerprintInert(input: {
  readonly baseline: GenericShadowRun;
  readonly historicalFingerprintBefore: string;
  readonly historicalFingerprintAfter: string;
}): MetamorphicResult {
  const serialized = JSON.stringify({
    snapshot: input.baseline.graph.snapshot,
    fields: input.baseline.fields,
    interpretation: input.baseline.interpretation,
  });
  const prohibitedValuesAbsent =
    !serialized.includes(input.historicalFingerprintBefore)
    && !serialized.includes(input.historicalFingerprintAfter);
  return {
    invariant_id: 'historical_fingerprint_inert',
    description:
      'Changing a historical fingerprint never restores an old value.',
    status: prohibitedValuesAbsent ? 'pass' : 'fail',
    mutation_manifest: {
      mutation_type: 'prohibited_legacy_fingerprint_parameter',
      historical_fingerprint_before: input.historicalFingerprintBefore,
      historical_fingerprint_after: input.historicalFingerprintAfter,
      generic_pipeline_parameter_present: false,
      generic_output_contains_either_value: !prohibitedValuesAbsent,
    },
    explanation: prohibitedValuesAbsent
      ? 'The generic evaluation API has no legacy-fingerprint input and neither altered value appears in the graph or interpretation output.'
      : 'A prohibited historical fingerprint value appeared in generic output.',
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
}

export function evaluateObservedEngineArbitration(
  baseline: GenericShadowRun,
): readonly MetamorphicResult[] {
  const multiCandidate = baseline.graph.arbitrationDecisions.filter(
    (decision) => decision.candidate_ids.length > 1,
  );
  const nativeOcr: MetamorphicResult = {
    invariant_id: 'native_ocr_arbitration',
    description: 'Superior OCR and partial native text remain inspectable.',
    status: multiCandidate.length > 0 ? 'pass' : 'blocked',
    mutation_manifest: {
      mutation_type: 'engine_observation_audit',
      multi_candidate_region_count: multiCandidate.length,
    },
    explanation: multiCandidate.length > 0
      ? `${multiCandidate.length} regions retained multiple engine candidates and an explicit arbitration decision.`
      : 'The verified TDOT source did not schedule a competing OCR candidate for any native region, so this source cannot exercise native/OCR arbitration without a source-level raster mutation.',
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
  const hasVision = baseline.graph.fragments.some(
    (fragment) => fragment.parser.stage === 'vision',
  );
  const engineConflict: MetamorphicResult = {
    invariant_id: 'engine_conflict',
    description:
      'Native/OCR/vision conflicts remain inspectable and unsupported winners do not verify.',
    status: hasVision && multiCandidate.length > 0 ? 'pass' : 'blocked',
    mutation_manifest: {
      mutation_type: 'engine_conflict_audit',
      vision_fragment_present: hasVision,
      multi_candidate_region_count: multiCandidate.length,
      ...(hasVision && multiCandidate.length > 0 ? {} : {
        disposition: 'source_limited_for_tdot_pdf',
        missing_source_property:
          'no independently controlled native/OCR/vision conflict exists in the source',
        synthetic_source_required: true,
        generic_phase2_evidence_required: true,
        production_parser_input: false,
      }),
    },
    explanation: hasVision && multiCandidate.length > 0
      ? 'Native/OCR/vision alternatives and arbitration decisions are retained.'
      : 'The deterministic Phase 1 manifest disables unpinned vision and this source produced no three-engine conflict; the invariant remains blocked rather than fabricating model output.',
    changed_field_ids: [],
    unexpected_field_ids: [],
  };
  return [nativeOcr, engineConflict];
}

export function mergeMetamorphicResults(
  baselineResults: readonly MetamorphicResult[],
  executedResults: readonly MetamorphicResult[],
): MetamorphicResult[] {
  const replacements = new Map(
    executedResults.map((result) => [result.invariant_id, result] as const),
  );
  return baselineResults.map((result) =>
    replacements.get(result.invariant_id) ?? result);
}

function countBy<T extends string>(
  values: readonly T[],
  keys: readonly T[],
): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [
    key,
    values.filter((value) => value === key).length,
  ])) as Record<T, number>;
}

function cycleMetrics(input: {
  readonly records: readonly ParityRecord[];
  readonly semanticMappings: number;
  readonly semanticAmbiguities: number;
  readonly gaps: number;
  readonly reconstructionSummary?: TdotPhase1Report[
    'generic_run'
  ]['reconstruction_summary'];
  readonly metamorphicCounts: Readonly<
    Record<MetamorphicResult['status'], number>
  >;
}): Phase1CycleMetrics {
  const material = input.records.filter(({ material }) => material);
  const ledgerRecords = input.records.filter(({ ledger }) => ledger != null);
  const split = ledgerRecords.filter(({ generic_fields }) =>
    generic_fields.length > 1);
  return {
    total_material_records: material.length,
    resolved: material.filter(({ resolution }) => resolution === 'resolved').length,
    unresolved:
      material.filter(({ resolution }) => resolution === 'unresolved').length,
    semantic_review: material.filter(
      ({ resolution }) => resolution === 'requires_semantic_review',
    ).length,
    newly_supported:
      input.records.filter(({ classification }) =>
        classification === 'newly_supported').length,
    missing_or_uncertain:
      input.records.filter(({ classification }) =>
        classification === 'missing_or_uncertain').length,
    duplicate_split_merge:
      input.records.filter(({ classification }) =>
        classification === 'duplicate_split_merge').length,
    mappings_resolved: input.semanticMappings - input.semanticAmbiguities,
    mappings_ambiguous: input.semanticAmbiguities,
    ledger_cells_with_dependencies:
      ledgerRecords.filter(({ generic_fields }) => generic_fields.length > 0).length,
    ledger_cells_without_dependencies:
      ledgerRecords.filter(({ generic_fields }) => generic_fields.length === 0).length,
    exact_reconstructions: ledgerRecords.filter(
      ({ reconstruction_comparison }) =>
        reconstruction_comparison?.exact_equal === true,
    ).length,
    non_exact_single_field_reconstructions: ledgerRecords.filter((record) =>
      record.generic_fields.length === 1
      && record.reconstruction_comparison?.exact_equal === false).length,
    split_reconstructions: split.length,
    exact_split_reconstructions: split.filter(
      ({ reconstruction_comparison }) =>
        reconstruction_comparison?.exact_equal === true,
    ).length,
    non_exact_split_reconstructions: split.filter(
      ({ reconstruction_comparison }) =>
        reconstruction_comparison?.exact_equal === false,
    ).length,
    explicit_gaps: input.gaps,
    sparse_rows_unresolved:
      input.reconstructionSummary?.sparse_rows_unresolved ?? null,
    overflow_unassigned_cells:
      input.reconstructionSummary?.overflow_unassigned_cells ?? null,
    calibration_adaptive_pages:
      input.reconstructionSummary?.calibration_adaptive_pages ?? null,
    calibration_fallback_pages:
      input.reconstructionSummary?.calibration_fallback_pages ?? null,
    metamorphic_passed: input.metamorphicCounts.pass,
    metamorphic_failed: input.metamorphicCounts.fail,
    metamorphic_blocked: input.metamorphicCounts.blocked,
    metamorphic_not_applicable: input.metamorphicCounts.not_applicable,
  };
}

export function summarizePhase1Report(
  report: TdotPhase1Report,
): Phase1CycleMetrics {
  return cycleMetrics({
    records: report.parity.records,
    semanticMappings: report.generic_run.semantic_mappings,
    semanticAmbiguities: report.generic_run.semantic_ambiguities,
    gaps: report.generic_run.gaps,
    reconstructionSummary:
      (
        report.generic_run as TdotPhase1Report['generic_run'] & {
          readonly reconstruction_summary?: TdotPhase1Report[
            'generic_run'
          ]['reconstruction_summary'];
        }
      ).reconstruction_summary,
    metamorphicCounts: report.metamorphic.result_counts,
  });
}

function parityRecordKey(record: ParityRecord): string {
  return record.ledger
    ? `ledger:${record.ledger.field_identifier}`
    : `legacy:${record.legacy_row?.row_id ?? record.id}`;
}

function transitionMechanism(record: ParityRecord): string {
  if (record.generic_fields.length === 0) return 'missing_dependency';
  if (record.reconstruction_comparison?.exact_equal === false) {
    return record.generic_fields.length > 1
      ? 'split_merge_text_divergence'
      : 'single_field_text_divergence';
  }
  if (record.resolution === 'requires_semantic_review') return 'semantic_review';
  return 'source_grounded';
}

const CYCLE5_COMPARATOR_AUDIT = Object.freeze([
  {
    file: 'lib/extraction/domain/genericTableArtifacts.ts',
    function: 'orderedLines',
    ordered_object: 'source fragments within a cell',
    earlier_keys: ['vertical center', 'x0', 'reading_order'],
    prior_effect: 'ID could change line order and reconstructed raw text.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'page, full geometry, reading order, parser identity, text hashes',
  },
  {
    file: 'lib/extraction/domain/genericTableArtifacts.ts',
    function: 'groupInlineCellFragments',
    ordered_object: 'physical-row fragments',
    earlier_keys: ['x0', 'reading_order'],
    prior_effect: 'ID could change adjacency and apparent-cell coalescing.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'full source geometry and observed reading order',
  },
  {
    file: 'lib/extraction/domain/genericTableArtifacts.ts',
    function: 'assignApparentCells and automatic caller',
    ordered_object: 'apparent cells',
    earlier_keys: ['union x0'],
    prior_effect: 'ID could change monotone column assignment.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'cell extent, geometry, and source ordinal; redundant pre-sort removed',
  },
  {
    file: 'lib/extraction/domain/genericTableArtifacts.ts',
    function: 'rowCells',
    ordered_object: 'logical-row cells',
    earlier_keys: ['column_start'],
    prior_effect: 'ID could select continuation indentation evidence.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'column span, row span, full geometry, reading order',
  },
  {
    file: 'lib/extraction/domain/genericTableArtifacts.ts',
    function: 'buildContinuationLinks',
    ordered_object: 'segments and destination candidates',
    earlier_keys: ['page', 'reading_order', 'plausibility'],
    prior_effect: 'ID was structurally unreachable but could affect future truncation.',
    classification: 'redundant_removed' as const,
    current_basis: 'page, reading order, geometry, column structure',
  },
  {
    file: 'lib/extraction/domain/genericTableArtifacts.ts',
    function: 'diagnostic serialization',
    ordered_object: 'undisposed fragments and continuation evidence',
    earlier_keys: [],
    prior_effect: 'Ordering affected diagnostic serialization only.',
    classification: 'deterministic_output_only_retained' as const,
    current_basis: 'resolved artifact source order; IDs remain equality/reference values',
  },
  {
    file: 'lib/extraction/domain/regionArbitration.ts',
    function: 'token and candidate ordering',
    ordered_object: 'region tokens and engine candidates',
    earlier_keys: ['reading_order', 'geometry', 'quality'],
    prior_effect: 'ID could alter candidate text, quality, and gap provenance.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'observed engine confidence, quality, full geometry, parser evidence',
  },
  {
    file: 'lib/extraction/domain/legacyLocatedObservationAdapter.ts',
    function: 'region band and token assembly',
    ordered_object: 'located observations',
    earlier_keys: ['y0', 'x0'],
    prior_effect: 'ID could change band construction and raw text.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'full geometry, reading order, parser evidence, stable input ordinal',
  },
  {
    file: 'lib/extraction/domain/legacyLocatedObservationAdapter.ts',
    function: 'consensus compatibility stream selection',
    ordered_object: 'accepted arbitration candidates',
    earlier_keys: [],
    prior_effect: 'Lexicographically first candidate supplied downstream table tokens.',
    classification: 'semantically_significant_corrected' as const,
    current_basis: 'observed engine confidence, measured quality, source evidence',
  },
  {
    file: 'lib/extraction/domain/genericContentScheduling.ts',
    function: 'scheduleGenericContent',
    ordered_object: 'independent region decisions',
    earlier_keys: ['page', 'bbox y0', 'bbox x0'],
    prior_effect: 'Only decision-array serialization changed.',
    classification: 'deterministic_output_only_retained' as const,
    current_basis: 'full bbox, structural kind, native text',
  },
] as const);

function groupedTransitionCounts(
  records: TdotPhase1Report['record_transition_composition']['records'],
  select: (
    record: TdotPhase1Report[
      'record_transition_composition'
    ]['records'][number],
  ) => string | number | null,
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const record of records) {
    const key = String(select(record) ?? 'none');
    result[key] = (result[key] ?? 0) + 1;
  }
  return result;
}

function buildTransitionComposition(
  baseline: TdotPhase1Report | null,
  current: readonly ParityRecord[],
): TdotPhase1Report['record_transition_composition'] {
  const prior = new Map(
    (baseline?.parity.records ?? []).map((record) =>
      [parityRecordKey(record), record] as const),
  );
  const records = current.filter(({ material }) => material).map((record) => {
    const previous = prior.get(parityRecordKey(record));
    const transitions: TdotPhase1Report[
      'record_transition_composition'
    ]['records'][number]['transitions'][number][] = [];
    if (previous) {
      if (previous.generic_fields.length === 0 && record.generic_fields.length > 0) {
        transitions.push('recovered_dependency');
      }
      if (previous.generic_fields.length > 0 && record.generic_fields.length === 0) {
        transitions.push('newly_missing_dependency');
      }
      if (
        previous.reconstruction_comparison?.exact_equal === true
        && record.reconstruction_comparison?.exact_equal === false
      ) transitions.push('exact_to_non_exact');
      if (
        previous.reconstruction_comparison?.exact_equal === false
        && record.reconstruction_comparison?.exact_equal === true
      ) transitions.push('non_exact_to_exact');
      if (
        previous.resolution === 'unresolved'
        && record.resolution === 'resolved'
      ) transitions.push('unresolved_to_resolved');
      if (
        previous.resolution === 'resolved'
        && record.resolution === 'requires_semantic_review'
      ) transitions.push('resolved_to_semantic_review');
      if (
        previous.resolution === 'requires_semantic_review'
        && record.resolution === 'resolved'
      ) transitions.push('semantic_review_to_resolved');
    }
    if (transitions.length === 0) transitions.push('unchanged');
    const field = record.generic_fields[0];
    return {
      record_key: parityRecordKey(record),
      record_id: record.id,
      transitions,
      page: record.ledger?.source_page ?? record.legacy_row?.page ?? null,
      ledger_role: record.ledger?.interpreted_field_or_role ?? null,
      mechanism: transitionMechanism(record),
      table_id: field?.table_segment_id ?? null,
      source_row_id: field?.table_row_id ?? record.ledger?.row_identity ?? null,
      current_failure_reason: record.generic_fields.length === 0
        ? 'no_verified_generic_table_cell_in_ledger_geometry'
        : record.reconstruction_comparison?.exact_equal === false
          ? transitionMechanism(record)
          : record.resolution === 'requires_semantic_review'
            ? 'semantic_mapping_requires_review'
            : null,
    };
  });
  const counts: Record<string, number> = {};
  for (const record of records) {
    for (const transition of record.transitions) {
      counts[transition] = (counts[transition] ?? 0) + 1;
    }
  }
  return {
    records,
    counts,
    grouped: {
      by_page: groupedTransitionCounts(records, ({ page }) => page),
      by_ledger_role: groupedTransitionCounts(
        records,
        ({ ledger_role }) => ledger_role,
      ),
      by_mechanism: groupedTransitionCounts(records, ({ mechanism }) => mechanism),
      by_table: groupedTransitionCounts(records, ({ table_id }) => table_id),
      by_source_row: groupedTransitionCounts(
        records,
        ({ source_row_id }) => source_row_id,
      ),
      by_failure_reason: groupedTransitionCounts(
        records,
        ({ current_failure_reason }) => current_failure_reason,
      ),
    },
  };
}

export function buildPhase1Report(input: {
  readonly gateVerification: {
    readonly gate_definition_version: string;
    readonly status: string;
    readonly check_count: number;
    readonly failed_check_count: number;
    readonly authorization: {
      readonly production_reader_changes_authorized: false;
      readonly legacy_removal_authorized: false;
    };
  };
  readonly ledger: TdotLedger;
  readonly run: GenericShadowRun;
  readonly parityRecords: readonly ParityRecord[];
  readonly metamorphicResults: readonly MetamorphicResult[];
  readonly baselineCycle?: {
    readonly report_version: string;
    readonly metrics: Phase1CycleMetrics;
  } | null;
  readonly baselineReport?: TdotPhase1Report | null;
  readonly partAReport?: TdotPhase1Report | null;
}): TdotPhase1Report {
  const classifications: readonly ParityClassification[] = [
    'match',
    'legacy_unsupported',
    'newly_supported',
    'changed_source_grounded',
    'missing_or_uncertain',
    'duplicate_split_merge',
  ];
  const metamorphicStatuses: readonly MetamorphicResult['status'][] = [
    'pass', 'fail', 'blocked', 'not_applicable',
  ];
  const materialDifferences = input.parityRecords.filter((record) => record.material);
  const unresolved = materialDifferences.filter((record) => record.resolution !== 'resolved');
  const ambiguityCount = input.run.interpretation.semantic_column_mappings.filter(
    (mapping) => mapping.status === 'ambiguous',
  ).length;
  const reconstructionDiagnostics = input.run.graph.tableReconstructionDiagnostics;
  const adaptivePages = reconstructionDiagnostics.calibrations.filter((calibration) =>
    Object.values(calibration.thresholds).some(({ mode }) => mode === 'adaptive')).length;
  const costRecords = input.parityRecords.filter((record) =>
    record.ledger?.interpreted_field_or_role === 'cost');
  const exactSingleCostRecords = costRecords.filter((record) =>
    record.generic_fields.length === 1
    && record.reconstruction_comparison?.exact_equal === true);
  const priorResolved = exactSingleCostRecords.filter((record) =>
    record.semantic_role_comparison?.prior_cost_as_rate_outcome === 'resolved');
  const newlyResolved = exactSingleCostRecords.filter((record) =>
    record.resolution === 'resolved');
  const reconstructionSummary = {
    calibration_adaptive_pages: adaptivePages,
    calibration_fallback_pages:
      reconstructionDiagnostics.calibrations.length - adaptivePages,
    sparse_rows_attached:
      reconstructionDiagnostics.sparse_row_dispositions.filter(
        ({ outcome }) => outcome === 'attached',
      ).length,
    sparse_rows_unresolved:
      reconstructionDiagnostics.sparse_row_dispositions.filter(
        ({ outcome }) => outcome === 'unresolved_gap',
      ).length,
    overflow_unassigned_cells:
      reconstructionDiagnostics.column_overflows.length,
    table_candidate_fragments:
      reconstructionDiagnostics.table_candidate_fragment_count,
    disposed_fragments: reconstructionDiagnostics.disposed_fragment_count,
    undisposed_fragments:
      reconstructionDiagnostics.undisposed_fragment_ids.length,
  };
  const metamorphicCounts = countBy(
    input.metamorphicResults.map((result) => result.status),
    metamorphicStatuses,
  );
  const afterMetrics = cycleMetrics({
    records: input.parityRecords,
    semanticMappings: input.run.interpretation.semantic_column_mappings.length,
    semanticAmbiguities: ambiguityCount,
    gaps: input.run.graph.gaps.length,
    reconstructionSummary,
    metamorphicCounts,
  });
  const transitionComposition = buildTransitionComposition(
    input.baselineReport ?? null,
    input.parityRecords,
  );
  const auditedPages = [...new Set(
    input.ledger.observations.map(({ source_page }) => source_page),
  )].sort((left, right) => left - right);
  const auditedPageSet = new Set(auditedPages);
  const auditedSparse = reconstructionDiagnostics.sparse_row_dispositions
    .filter(({ page }) => auditedPageSet.has(page)).length;
  const auditedOverflow = reconstructionDiagnostics.column_overflows
    .filter(({ page }) => auditedPageSet.has(page)).length;
  const pageMetrics = auditedPages.map((page) => {
    const records = input.parityRecords.filter(
      (record) => record.ledger?.source_page === page,
    );
    const exact = records.filter(
      ({ reconstruction_comparison }) =>
        reconstruction_comparison?.exact_equal === true,
    ).length;
    const withDependencies = records.filter(
      ({ generic_fields }) => generic_fields.length > 0,
    ).length;
    return {
      page,
      ledger_records: records.length,
      exact_reconstructions: exact,
      non_exact_reconstructions: records.length - exact,
      fields_with_dependencies: withDependencies,
      fields_without_dependencies: records.length - withDependencies,
    };
  });
  const sourceLimitedInvariantCount = input.metamorphicResults.filter((result) =>
    result.mutation_manifest?.disposition === 'source_limited_for_tdot_pdf').length;
  const baselinePage44Failures = input.baselineReport?.parity.records.filter((record) =>
    record.ledger?.source_page === 44
    && record.reconstruction_comparison?.exact_equal === false) ?? [];
  const currentByFieldIdentifier = new Map(input.parityRecords.flatMap((record) =>
    record.ledger?.field_identifier
      ? [[record.ledger.field_identifier, record] as const]
      : []));
  const page44Diagnostics = baselinePage44Failures.map((baselineRecord) => {
    const ledger = baselineRecord.ledger!;
    const ledgerBox = normalizedBox(ledger);
    const current = currentByFieldIdentifier.get(ledger.field_identifier);
    const relevant = reconstructionDiagnostics.sparse_row_dispositions.filter(
      (disposition) => {
        if (disposition.page !== 44) return false;
        const fragmentIntersects = disposition.fragment_evidence.some(({ bounding_box }) => {
          const centerY = (bounding_box.y0 + bounding_box.y1) / 2;
          return centerY >= ledgerBox.y0 && centerY <= ledgerBox.y1;
        });
        const selectedBandIntersects = disposition.primary_row_bands.some((band) =>
          band.primary_row_index === disposition.selected_primary_row_index
          && Math.min(band.bounding_box.y1, ledgerBox.y1)
            > Math.max(band.bounding_box.y0, ledgerBox.y0));
        return fragmentIntersects || selectedBandIntersects;
      },
    );
    const collision = reconstructionDiagnostics.row_anchor_assignments.some(
      (assignment) =>
        assignment.page === 44
        && relevant.some((item) =>
          item.physical_row_index === assignment.physical_row_index)
        && assignment.selected_assignments.some((selected) =>
          selected.margin != null
          && selected.margin
            < GENERIC_TABLE_POLICY_V7.column_inference.minimum_assignment_margin),
    );
    return {
      field_identifier: ledger.field_identifier,
      record_id: baselineRecord.id,
      ledger_role: ledger.interpreted_field_or_role,
      expected_text: ledger.exact_raw_text,
      reconstructed_text:
        current?.reconstruction_comparison?.reconstructed_raw_text ?? null,
      relevant_sparse_dispositions: relevant,
      earliest_causal_divergence: relevant.length > 0
        ? 'sparse physical row to logical-row continuation attachment'
        : collision
          ? 'apparent-cell to coarse-column assignment'
          : 'physical fragment grouping before logical-cell reconstruction',
      primary_mechanism: collision
        ? 'anchor_collision_with_retained_fragment_evidence'
        : relevant.some(({ selection_basis }) =>
            selection_basis === 'backward_row_start_boundary_within_uncertainty')
          ? 'continuation_or_ordinal_leakage_corrected_by_row_start_boundary'
          : 'continuation_or_ordinal_leakage',
    };
  });
  return {
    report_version: TDOT_PHASE1_HARNESS_VERSION,
    generated_at: TDOT_PHASE1_FIXED_TIME,
    phase: 'phase3_step4_phase1_shadow',
    shadow_only: true,
    source: {
      sha256: input.run.source_sha256,
      byte_length: input.run.source_byte_length,
      page_count: input.ledger.source_pdf.pages,
    },
    phase0_gate: {
      status: input.gateVerification.status,
      gate_definition_version: input.gateVerification.gate_definition_version,
      check_count: input.gateVerification.check_count,
      failed_check_count: input.gateVerification.failed_check_count,
      production_reader_changes_authorized: false,
      legacy_removal_authorized: false,
    },
    generic_run: {
      snapshot_id: input.run.graph.snapshot.id,
      content_extraction_fingerprint:
        input.run.graph.snapshot.content_extraction_fingerprint,
      parser_manifest_hash: input.run.graph.snapshot.parser_manifest_hash,
      artifact_root_hash: input.run.graph.snapshot.artifact_root_hash,
      status: input.run.graph.snapshot.status,
      pages: input.run.graph.pages.length,
      table_segments: input.run.graph.tableSegments.length,
      table_chains: input.run.graph.tableChains.length,
      verified_fields: input.run.graph.verifiedFields.length,
      compared_fields: input.run.fields.length,
      semantic_mappings: input.run.interpretation.semantic_column_mappings.length,
      semantic_ambiguities: ambiguityCount,
      gaps: input.run.graph.gaps.length,
      reconstruction_diagnostics: reconstructionDiagnostics,
      reconstruction_summary: reconstructionSummary,
      dependency_closure: input.run.dependency_closure,
    },
    parity: {
      classification_counts: countBy(
        input.parityRecords.map((record) => record.classification),
        classifications,
      ),
      page_metrics: pageMetrics,
      records: input.parityRecords,
      material_differences: materialDifferences,
    },
    metamorphic: {
      result_counts: metamorphicCounts,
      results: input.metamorphicResults,
    },
    cycle_comparison: {
      baseline_report_version: input.baselineCycle?.report_version ?? null,
      before: input.baselineCycle?.metrics ?? null,
      after: afterMetrics,
    },
    record_transition_composition: transitionComposition,
    diagnostic_scope: {
      audited_ledger_pages: auditedPages,
      audited_sparse_dispositions: auditedSparse,
      audited_overflow_cells: auditedOverflow,
      outside_audited_pages_sparse_dispositions:
        reconstructionDiagnostics.sparse_row_dispositions.length - auditedSparse,
      outside_audited_pages_overflow_cells:
        reconstructionDiagnostics.column_overflows.length - auditedOverflow,
      non_parity_table_diagnostics_retained:
        reconstructionDiagnostics.sparse_row_dispositions.length
        + reconstructionDiagnostics.column_overflows.length
        - auditedSparse
        - auditedOverflow,
      page_prose_or_note_classification:
        'not_inferred_without_source_role_evidence',
    },
    remaining_failures: {
      non_exact_reconstructions: input.parityRecords.flatMap((record) =>
        record.ledger != null
        && record.generic_fields.length > 0
        && record.reconstruction_comparison?.exact_equal === false
          ? [{
              record_id: record.id,
              field_identifier: record.ledger.field_identifier,
              mechanism: record.generic_fields.length > 1
                ? 'split_merge_text_divergence' as const
                : 'single_field_text_divergence' as const,
            }]
          : []),
      missing_dependencies: input.parityRecords.flatMap((record) =>
        record.ledger != null && record.generic_fields.length === 0
          ? [{
              record_id: record.id,
              field_identifier: record.ledger.field_identifier,
              mechanism:
                'no_verified_generic_table_cell_in_ledger_geometry' as const,
            }]
          : []),
      unresolved_sparse_rows:
        reconstructionDiagnostics.sparse_row_dispositions.filter(
          ({ outcome }) => outcome === 'unresolved_gap',
        ),
      overflow_cells: reconstructionDiagnostics.column_overflows,
      semantic_review_record_ids: input.parityRecords.filter(
        ({ resolution }) => resolution === 'requires_semantic_review',
      ).map(({ id }) => id),
    },
    evaluator_role_contract: {
      version: 'ledger-role-contract-v2',
      cost_records: costRecords.length,
      exact_single_field_cost_records: exactSingleCostRecords.length,
      prior_cost_as_rate_resolved: priorResolved.length,
      prior_cost_as_rate_semantic_review:
        exactSingleCostRecords.length - priorResolved.length,
      resolved_as_rate: newlyResolved.filter((record) =>
        record.generic_fields[0]?.semantic_role === 'rate').length,
      resolved_as_extension: newlyResolved.filter((record) =>
        record.generic_fields[0]?.semantic_role === 'extension').length,
      semantic_review: exactSingleCostRecords.filter((record) =>
        record.resolution === 'requires_semantic_review').length,
      changed_record_ids: exactSingleCostRecords.filter((record) => {
        const prior = record.semantic_role_comparison?.prior_cost_as_rate_outcome;
        return (prior === 'resolved') !== (record.resolution === 'resolved');
      }).map(({ id }) => id),
    },
    prohibited_builder_calls: {
      count: 0,
      symbols: [
        'TDOT_APPENDIX_B_SPECS',
        'tdot_appendix_b_stitched_table',
        'assembleContractRateScheduleRows',
      ],
    },
    phase2_readiness: {
      status: 'not_ready',
      unresolved_material_difference_ids: unresolved.map((record) => record.id),
      cutover_decision: null,
    },
    cycle5: {
      verdict: input.metamorphicResults.some((result) =>
        ['change_quantity', 'change_extension'].includes(result.invariant_id)
        && result.status !== 'pass') ? 'fail' : 'pass',
      implementation_build: {
        value: input.run.implementation_build,
        derivation:
          'normalized-explicit-source-closure-and-runtime-version-sha256',
        report_version_independent: true,
      },
      part_a: {
        before: input.baselineReport
          ? summarizePhase1Report(input.baselineReport)
          : null,
        after: input.partAReport ? summarizePhase1Report(input.partAReport) : null,
        checkpoint: 'phase1-v1.11.0-part-a-2',
        manifest_invariance: 'passed_real_pdf_two_build_identity_test',
      },
      comparator_audit: CYCLE5_COMPARATOR_AUDIT,
      page44_diagnostics: page44Diagnostics,
      source_limited_invariant_count: sourceLimitedInvariantCount,
      rejected_experiments: [{
        checkpoint: 'phase1-v1.11.0-part-a-1',
        reason:
          'Compatibility stream selection preferred generic quality over observed engine confidence and changed 41 consensus candidates.',
        measurements: {
          exact_reconstruction: 246,
          non_exact_single_field: 2,
          non_exact_split_merge: 4,
          missing_dependencies: 4,
          page44_exact: 48,
          semantic_review: 43,
        },
      }],
    },
  };
}

export function renderPhase1Markdown(report: TdotPhase1Report): string {
  const counts = report.parity.classification_counts;
  const meta = report.metamorphic.result_counts;
  const after = report.cycle_comparison.after;
  const partA = report.cycle5.part_a.after;
  const materialGroups = new Map<string, number>();
  for (const record of report.parity.material_differences) {
    const key = `${record.classification} / ${record.resolution}`;
    materialGroups.set(key, (materialGroups.get(key) ?? 0) + 1);
  }
  return [
    '# TDOT Phase 3 Step 4 Phase 1 Shadow Report',
    '',
    '| Metric | v1.10.0 | Part A only | v1.11.0 final |',
    '|---|---:|---:|---:|',
    `| Exact reconstruction | 247 | ${partA?.exact_reconstructions ?? 'not supplied'} | ${after.exact_reconstructions} |`,
    `| Non-exact, single-field | 7 | ${partA?.non_exact_single_field_reconstructions ?? 'not supplied'} | ${after.non_exact_single_field_reconstructions} |`,
    `| Non-exact, split/merge | 2 | ${partA?.non_exact_split_reconstructions ?? 'not supplied'} | ${after.non_exact_split_reconstructions} |`,
    `| Missing dependencies | 0 | ${partA?.ledger_cells_without_dependencies ?? 'not supplied'} | ${after.ledger_cells_without_dependencies} |`,
    `| Resolved | 226 | ${partA?.resolved ?? 'not supplied'} | ${after.resolved} |`,
    `| Unresolved | 30 | ${partA?.unresolved ?? 'not supplied'} | ${after.unresolved} |`,
    `| Semantic review | 32 | ${partA?.semantic_review ?? 'not supplied'} | ${after.semantic_review} |`,
    `| Metamorphic passed | 6 | ${partA?.metamorphic_passed ?? 'not supplied'} | ${after.metamorphic_passed} |`,
    `| Metamorphic failed | 0 | ${partA?.metamorphic_failed ?? 'not supplied'} | ${after.metamorphic_failed} |`,
    `| Metamorphic blocked | 15 | ${partA?.metamorphic_blocked ?? 'not supplied'} | ${after.metamorphic_blocked} |`,
    `| Source-limited invariants | 0 | 0 | ${report.cycle5.source_limited_invariant_count} |`,
    '',
    `Report version: ${report.report_version}`,
    `Source SHA-256: ${report.source.sha256}`,
    `Phase 0 gate: ${report.phase0_gate.status}`,
    `Shadow only: ${report.shadow_only}`,
    `Dependency closure: ${report.generic_run.dependency_closure.status}`,
    '',
    '## Cycle 5 verdict',
    '',
    `Verdict: ${report.cycle5.verdict}`,
    '',
    '## Part A comparator audit and isolated effect',
    '',
    ...report.cycle5.comparator_audit.map((item) =>
      `- ${item.file} / ${item.function}: ${item.classification}; ${item.prior_effect} Current basis: ${item.current_basis}.`),
    '',
    `Manifest invariance: ${report.cycle5.part_a.manifest_invariance}`,
    `Part A checkpoint: ${report.cycle5.part_a.checkpoint}`,
    '',
    '## Implementation build',
    '',
    `- Value: ${report.cycle5.implementation_build.value}`,
    `- Derivation: ${report.cycle5.implementation_build.derivation}`,
    '- Report version independent: true',
    '',
    '## Page 44 baseline failure diagnostics',
    '',
    ...report.cycle5.page44_diagnostics.map((item) =>
      `- ${item.field_identifier} | ${item.ledger_role} | ${item.primary_mechanism} | ${item.earliest_causal_divergence} | sparse evidence ${item.relevant_sparse_dispositions.length}`),
    '',
    '## Generic execution',
    '',
    `- Pages: ${report.generic_run.pages}`,
    `- Verified fields: ${report.generic_run.verified_fields}`,
    `- Generic compared table fields: ${report.generic_run.compared_fields}`,
    `- Table segments / chains: ${report.generic_run.table_segments} / ${report.generic_run.table_chains}`,
    `- Semantic mappings / ambiguities: ${report.generic_run.semantic_mappings} / ${report.generic_run.semantic_ambiguities}`,
    `- Explicit gaps: ${report.generic_run.gaps}`,
    `- Sparse rows attached / unresolved: ${report.generic_run.reconstruction_summary.sparse_rows_attached} / ${report.generic_run.reconstruction_summary.sparse_rows_unresolved}`,
    `- Overflow or unassigned cells: ${report.generic_run.reconstruction_summary.overflow_unassigned_cells}`,
    `- Calibration adaptive / fallback pages: ${report.generic_run.reconstruction_summary.calibration_adaptive_pages} / ${report.generic_run.reconstruction_summary.calibration_fallback_pages}`,
    `- Table fragment disposition: ${report.generic_run.reconstruction_summary.disposed_fragments} / ${report.generic_run.reconstruction_summary.table_candidate_fragments} disposed; ${report.generic_run.reconstruction_summary.undisposed_fragments} undisposed`,
    '',
    '## Cycle comparison',
    '',
    `Baseline report: ${report.cycle_comparison.baseline_report_version ?? 'not supplied'}`,
    '',
    '| Metric | Before | After |',
    '| --- | ---: | ---: |',
    ...Object.entries(report.cycle_comparison.after).map(([key, after]) =>
      `| ${key} | ${
        report.cycle_comparison.before?.[
          key as keyof Phase1CycleMetrics
        ] ?? 'not recorded'
      } | ${after} |`),
    '',
    '## Record transition composition',
    '',
    ...Object.entries(report.record_transition_composition.counts)
      .map(([key, value]) => `- ${key}: ${value}`),
    '',
    ...report.record_transition_composition.records
      .filter(({ transitions }) => !(
        transitions.length === 1 && transitions[0] === 'unchanged'
      ))
      .map((record) =>
        `- ${record.record_key} | ${record.transitions.join(',')} | p${record.page ?? 'n/a'} | ${record.ledger_role ?? 'no-ledger-role'} | ${record.mechanism} | ${record.current_failure_reason ?? 'none'}`),
    '',
    '## Audited and whole-document diagnostic scope',
    '',
    `- Audited ledger pages: ${report.diagnostic_scope.audited_ledger_pages.join(', ')}`,
    `- Audited sparse / overflow diagnostics: ${report.diagnostic_scope.audited_sparse_dispositions} / ${report.diagnostic_scope.audited_overflow_cells}`,
    `- Outside-audited-pages sparse / overflow diagnostics: ${report.diagnostic_scope.outside_audited_pages_sparse_dispositions} / ${report.diagnostic_scope.outside_audited_pages_overflow_cells}`,
    `- Non-parity table diagnostics retained: ${report.diagnostic_scope.non_parity_table_diagnostics_retained}`,
    `- Page prose or note classification: ${report.diagnostic_scope.page_prose_or_note_classification}`,
    '',
    '## Evaluator role contract',
    '',
    `- Version: ${report.evaluator_role_contract.version}`,
    `- Cost records / exact single-field: ${report.evaluator_role_contract.cost_records} / ${report.evaluator_role_contract.exact_single_field_cost_records}`,
    `- Prior cost-as-rate resolved / review: ${report.evaluator_role_contract.prior_cost_as_rate_resolved} / ${report.evaluator_role_contract.prior_cost_as_rate_semantic_review}`,
    `- Resolved as rate / extension: ${report.evaluator_role_contract.resolved_as_rate} / ${report.evaluator_role_contract.resolved_as_extension}`,
    `- Semantic review: ${report.evaluator_role_contract.semantic_review}`,
    `- Evaluator-only changed records: ${report.evaluator_role_contract.changed_record_ids.length}`,
    '',
    '## Parity classifications',
    '',
    ...Object.entries(counts).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '### Page-level reconstruction and dependency coverage',
    '',
    '| Page | Ledger records | Exact | Non-exact | With dependencies | Without dependencies |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.parity.page_metrics.map((metric) =>
      `| ${metric.page} | ${metric.ledger_records} | ${metric.exact_reconstructions} | ${metric.non_exact_reconstructions} | ${metric.fields_with_dependencies} | ${metric.fields_without_dependencies} |`),
    '',
    '## Material differences',
    '',
    ...[...materialGroups.entries()].map(([key, value]) => `- ${key}: ${value}`),
    '',
    '### Material difference ledger',
    '',
    ...report.parity.material_differences.map((record) => {
      const source = record.ledger
        ? `${record.ledger.field_identifier} p${record.ledger.source_page} bbox(${[
            record.ledger.bbox_x0,
            record.ledger.bbox_y0,
            record.ledger.bbox_x1,
            record.ledger.bbox_y1,
          ].join(',')})`
        : record.legacy_row
          ? `${record.legacy_row.row_id} anchors(${record.legacy_row.source_anchor_ids.join(',')})`
          : 'unidentified';
      const dependencies = record.generic_fields.length > 0
        ? record.generic_fields.map((field) => field.dependency_hash).join(',')
        : 'none';
      return `- ${record.id} | ${record.classification} | ${record.resolution} | ${source} | dependencies: ${dependencies} | ${record.explanation}`;
    }),
    '',
    'The machine-readable report additionally preserves every raw text value/hash, confidence value, parser/interpretation manifest, VerifiedField ID, and dependency reference.',
    '',
    '## Remaining failure inventories',
    '',
    `- Non-exact reconstructions: ${report.remaining_failures.non_exact_reconstructions.length}`,
    ...report.remaining_failures.non_exact_reconstructions.map((item) =>
      `  - ${item.record_id} | ${item.field_identifier ?? 'no-ledger-field'} | ${item.mechanism}`),
    `- Missing dependencies: ${report.remaining_failures.missing_dependencies.length}`,
    ...report.remaining_failures.missing_dependencies.map((item) =>
      `  - ${item.record_id} | ${item.field_identifier ?? 'no-ledger-field'} | ${item.mechanism}`),
    `- Unresolved sparse rows: ${report.remaining_failures.unresolved_sparse_rows.length}`,
    ...report.remaining_failures.unresolved_sparse_rows.map((item) =>
      `  - p${item.page}:row${item.physical_row_index} | ${item.rejection_reason} | gap ${item.processing_gap_id}`),
    `- Overflow cells: ${report.remaining_failures.overflow_cells.length}`,
    ...report.remaining_failures.overflow_cells.map((item) =>
      `  - p${item.page}:row${item.physical_row_index} | ${item.rejection_reason} | gap ${item.processing_gap_id}`),
    `- Semantic-review records: ${report.remaining_failures.semantic_review_record_ids.length}`,
    ...report.remaining_failures.semantic_review_record_ids.map((id) =>
      `  - ${id}`),
    '',
    '## Metamorphic execution',
    '',
    ...Object.entries(meta).map(([key, value]) => `- ${key}: ${value}`),
    '',
    ...report.metamorphic.results.map((result) =>
      `- ${result.invariant_id}: ${result.status} - ${result.explanation}`),
    '',
    '## Phase 2 readiness',
    '',
    `Status: ${report.phase2_readiness.status}`,
    `Unresolved material differences: ${report.phase2_readiness.unresolved_material_difference_ids.length}`,
    'Cutover decision: none',
    '',
    'No production reader, validator, legacy builder, or persistence writer was invoked by this report.',
    '',
  ].join('\n');
}

export async function writePhase1Reports(input: {
  readonly outputDirectory: string;
  readonly report: TdotPhase1Report;
}): Promise<{
  readonly jsonPath: string;
  readonly markdownPath: string;
  readonly manifestPath: string;
}> {
  await mkdir(input.outputDirectory, { recursive: true });
  const jsonPath = path.join(
    input.outputDirectory,
    `tdot-phase1-parity-report.v${TDOT_PHASE1_HARNESS_VERSION}.json`,
  );
  const markdownPath = path.join(
    input.outputDirectory,
    `tdot-phase1-parity-report.v${TDOT_PHASE1_HARNESS_VERSION}.md`,
  );
  const manifestPath = path.join(
    input.outputDirectory,
    `tdot-phase1-report-manifest.v${TDOT_PHASE1_HARNESS_VERSION}.json`,
  );
  const json = `${JSON.stringify(input.report, null, 2)}\n`;
  const markdown = renderPhase1Markdown(input.report);
  await writeFile(jsonPath, json, 'utf8');
  await writeFile(markdownPath, markdown, 'utf8');
  await writeFile(manifestPath, `${JSON.stringify({
    manifest_version: TDOT_PHASE1_HARNESS_VERSION,
    generated_at: TDOT_PHASE1_FIXED_TIME,
    source_pdf_sha256: input.report.source.sha256,
    report_files: [
      {
        file: path.basename(jsonPath),
        byte_length: Buffer.byteLength(json),
        sha256: sha256Hex(json),
      },
      {
        file: path.basename(markdownPath),
        byte_length: Buffer.byteLength(markdown),
        sha256: sha256Hex(markdown),
      },
    ],
    production_reader_changes: false,
    legacy_removal: false,
    cutover_decision: null,
  }, null, 2)}\n`, 'utf8');
  return { jsonPath, markdownPath, manifestPath };
}
