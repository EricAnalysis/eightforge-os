import { hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import type {
  BoundingBox,
  ExtractionConfidence,
  ExtractionRun,
  FieldCandidate,
  GridCellArtifact,
  LogicalTableRow,
  NonEmpty,
  PageArtifact,
  ParserIdentity,
  ProcessingGap,
  SourceArtifact,
  SourceFragmentArtifact,
  TableChainArtifact,
  TableContinuationLink,
  TableSectionArtifact,
  TableSegmentArtifact,
  TableValueKind,
} from '@/lib/extraction/domain/types';

export const GENERIC_TABLE_POLICY_V6 = Object.freeze({
  name: 'generic-geometric-table-reconstruction',
  version: 'v7',
  row_center_tolerance: 0.018,
  column_center_tolerance: 0.04,
  geometry_calibration: {
    version: 'observed-gap-distributions-v2',
    minimum_horizontal_samples: 8,
    minimum_vertical_samples: 4,
    minimum_cluster_samples: 3,
    minimum_cluster_ratio: 2,
    minimum_adaptive_confidence: 0.75,
    inline_gap_bounds: { minimum: 0.003, maximum: 0.025 },
    column_tolerance_bounds: { minimum: 0.012, maximum: 0.04 },
    continuation_distance_bounds: { minimum: 0.012, maximum: 0.035 },
    boundary_uncertainty_bounds: { minimum: 0.001, maximum: 0.006 },
  },
  fragment_coalescing: {
    version: 'coarse-band-constrained-v2',
    maximum_inline_gap: 0.025,
    currency_pair_maximum_inline_gap: 0.05,
    minimum_vertical_overlap_ratio: 0.5,
  },
  column_inference: {
    version: 'modal-row-monotone-global-assignment-overflow-recovery-v5',
    anchor_tolerance: 0.04,
    unassigned_cost: 0.78,
    maximum_assignment_cost: 0.72,
    minimum_assignment_margin: 0.04,
  },
  logical_row_assembly: {
    version: 'positional-sequence-open-cell-v6',
    maximum_continuation_center_distance: 0.035,
    minimum_attachment_score: 0.6,
    minimum_score_margin: 0.1,
    minimum_distance_margin: 0.00025,
    distance_tie_tolerance: 0.0001,
    minimum_continuation_shape_margin: 0.15,
  },
  header_detection: {
    version: 'first-row-structural-contrast-v1',
    minimum_columns: 2,
    minimum_kind_contrasts: 1,
  },
  continuation_search_max_page_distance: 3,
  continuation_max_candidates_per_segment: 2,
  continuation_plausibility_minimum: 0.5,
  continuation_near_tie_tolerance: 0.025,
  continuation_link_minimum: 0.76,
  continuation_ambiguity_minimum: 0.6,
  page_distance_penalty_per_skipped_page: 0.15,
  continuation_component_weights: {
    column_bands: 0.25,
    structural_mode: 0.45,
    edge_proximity: 0.1,
    typography: 0.1,
    page_distance: 0.1,
  },
  row_continuation_component_weights: {
    destination_alignment: 0.25,
    occupancy_continuity: 0.3,
    row_height_compatibility: 0.2,
    indentation_compatibility: 0.15,
    baseline_compatibility: 0.1,
  },
});

// Compatibility export for callers migrating from the accepted Cycle 5 symbol.
// Both names reference the same explicitly versioned v7 policy object.
export const GENERIC_TABLE_POLICY_V7 = GENERIC_TABLE_POLICY_V6;

export const GENERIC_TABLE_PARSER: ParserIdentity = Object.freeze({
  stage: 'table_reconstruction',
  name: GENERIC_TABLE_POLICY_V6.name,
  version: GENERIC_TABLE_POLICY_V6.version,
  configuration_hash: hashCanonical(GENERIC_TABLE_POLICY_V6),
});

export interface DistributionSummary {
  readonly sample_count: number;
  readonly minimum: number | null;
  readonly q25: number | null;
  readonly median: number | null;
  readonly q75: number | null;
  readonly maximum: number | null;
}

export interface GeometryThresholdDiagnostic {
  readonly selected: number;
  readonly previous_default: number;
  readonly derived: number | null;
  readonly raw_derived: number | null;
  readonly mode: 'adaptive' | 'fallback';
  readonly confidence: number;
  readonly supporting_measurements: DistributionSummary;
  readonly applied_bound: 'none' | 'floor' | 'ceiling';
  readonly bound_value: number | null;
  readonly bound_reason: string | null;
  readonly fallback_reason: string | null;
}

export interface PageGeometryCalibration {
  readonly page_artifact_id: PageArtifact['id'];
  readonly page: number;
  readonly policy_version: string;
  readonly horizontal_gaps: DistributionSummary;
  readonly horizontal_gap_clusters: {
    readonly lower: DistributionSummary;
    readonly upper: DistributionSummary;
    readonly separation_threshold: number | null;
    readonly confidence: number;
  };
  readonly row_spacings: DistributionSummary;
  readonly row_spacing_clusters: {
    readonly lower: DistributionSummary;
    readonly upper: DistributionSummary;
    readonly separation_threshold: number | null;
    readonly confidence: number;
  };
  readonly baseline_variations: DistributionSummary;
  readonly thresholds: {
    readonly maximum_inline_gap: GeometryThresholdDiagnostic;
    readonly column_center_tolerance: GeometryThresholdDiagnostic;
    readonly continuation_center_distance: GeometryThresholdDiagnostic;
    readonly row_center_tolerance: GeometryThresholdDiagnostic;
    readonly boundary_uncertainty: GeometryThresholdDiagnostic;
  };
}

export interface SparseAttachmentCandidateDiagnostic {
  readonly primary_row_index: number;
  readonly direction: 'backward' | 'forward';
  readonly column_index: number;
  readonly score: number;
  readonly measurements: {
    readonly vertical_distance: number;
    readonly vertical_proximity: number;
    readonly horizontal_overlap: number;
    readonly x_alignment: number;
    readonly value_kind_compatibility: number;
    readonly text_continuation_shape: number;
    readonly target_column_occupied: boolean;
    readonly target_cell_existed: boolean;
    readonly target_cell_complete: boolean;
    readonly row_order_consistency: number;
    readonly vertical_progression: number;
    readonly evolving_edge_distance: number;
    readonly neighboring_row_consistency: number;
    readonly column_occupancy_score: number;
    readonly continuity_with_previous_attachment: number;
    readonly target_cell_opened_from_sparse: boolean;
  };
}

export interface SparseRowDisposition {
  readonly page_artifact_id: PageArtifact['id'];
  readonly page: number;
  readonly physical_row_index: number;
  readonly fragment_ids: NonEmpty<SourceFragmentArtifact['id']>;
  readonly outcome: 'attached' | 'unresolved_gap';
  readonly candidate_rows: readonly SparseAttachmentCandidateDiagnostic[];
  readonly selected_primary_row_index: number | null;
  readonly selected_column_index: number | null;
  readonly confidence: number | null;
  readonly selection_basis:
    | 'vertical_distance'
    | 'continuation_shape_within_boundary_uncertainty'
    | 'backward_row_start_boundary_within_uncertainty'
    | null;
  readonly fragment_evidence: readonly {
    readonly fragment_id: SourceFragmentArtifact['id'];
    readonly raw_text: string;
    readonly bounding_box: BoundingBox;
    readonly reading_order: number;
  }[];
  readonly primary_row_bands: readonly {
    readonly primary_row_index: number;
    readonly bounding_box: BoundingBox;
    readonly anchor_fragment_ids: readonly SourceFragmentArtifact['id'][];
  }[];
  readonly spacing_evidence: {
    readonly continuation_center_distance: number;
    readonly boundary_uncertainty: number;
    readonly calibration_mode: 'adaptive' | 'fallback';
    readonly fallback_reason: string | null;
  };
  readonly open_cell_keys_before: readonly string[];
  readonly policy_version: string;
  readonly rejection_reason: string | null;
  readonly processing_gap_id: string | null;
}

export interface ColumnOverflowDiagnostic {
  readonly page_artifact_id: PageArtifact['id'];
  readonly page: number;
  readonly physical_row_index: number;
  readonly fragment_ids: NonEmpty<SourceFragmentArtifact['id']>;
  readonly candidate_column_indexes: readonly number[];
  readonly rejection_reason:
    | 'column_boundary_uncertain'
    | 'anchor_distance_exceeded'
    | 'anchor_already_occupied';
  readonly processing_gap_id: string;
}

export interface RowAnchorAssignmentDiagnostic {
  readonly page_artifact_id: PageArtifact['id'];
  readonly page: number;
  readonly physical_row_index: number;
  readonly policy_version: string;
  readonly apparent_cell_fragment_ids: readonly (
    readonly SourceFragmentArtifact['id'][]
  )[];
  readonly candidate_matrix: readonly (readonly {
    readonly column_index: number;
    readonly cost: number;
    readonly feasible: boolean;
    readonly rejection_reason: string | null;
  }[])[];
  readonly selected_assignments: readonly {
    readonly apparent_cell_index: number;
    readonly column_index: number | null;
    readonly selected_cost: number;
    readonly alternative_cost: number | null;
    readonly margin: number | null;
    readonly confidence: number;
    readonly structural_signal: 'ordinary' | 'structural_excess_cells';
    readonly processing_gap_id: string | null;
  }[];
}

export interface GenericTableReconstructionDiagnostics {
  readonly calibrations: readonly PageGeometryCalibration[];
  readonly sparse_row_dispositions: readonly SparseRowDisposition[];
  readonly column_overflows: readonly ColumnOverflowDiagnostic[];
  readonly row_anchor_assignments: readonly RowAnchorAssignmentDiagnostic[];
  readonly table_candidate_fragment_count: number;
  readonly disposed_fragment_count: number;
  readonly undisposed_fragment_ids: readonly SourceFragmentArtifact['id'][];
}

export interface ObservedCellPlan {
  readonly token_ids: NonEmpty<SourceFragmentArtifact['id']>;
  readonly column_index?: number;
  readonly structure?: GridCellArtifact['structure'];
  readonly row_span?: number;
  readonly column_span?: number;
  readonly border_evidence?: GridCellArtifact['border_evidence'];
  readonly coalescing_evidence?: {
    readonly reason:
      | 'same_line_without_structural_gutter'
      | 'currency_marker_numeric_pair'
      | 'currency_marker_dash_pair'
      | 'same_inferred_column'
      | 'sparse_line_nearest_column';
    readonly confidence: number;
    readonly maximum_observed_inline_gap: number;
  };
}

export interface ObservedRowPlan {
  readonly cells: NonEmpty<ObservedCellPlan>;
  readonly row_kind?: LogicalTableRow['row_kind'];
  readonly continued_from_row_id?: LogicalTableRow['id'] | null;
}

export interface ObservedTableRegion {
  readonly page_artifact_id: PageArtifact['id'];
  readonly rows: NonEmpty<ObservedRowPlan>;
  readonly detection_evidence: NonEmpty<
    TableSegmentArtifact['detection_evidence'][number]['kind']
  >;
  readonly parent_region_index?: number | null;
}

export interface ObservedSectionPlan {
  readonly region_index: number;
  readonly member_row_indexes: NonEmpty<number>;
  readonly header_row_index?: number | null;
  readonly child_region_indexes?: readonly number[];
}

export interface BuildGenericTableArtifactsInput {
  readonly source_artifact: SourceArtifact;
  readonly run: ExtractionRun;
  readonly pages: readonly PageArtifact[];
  readonly fragments: readonly SourceFragmentArtifact[];
  readonly regions?: readonly ObservedTableRegion[];
  readonly sections?: readonly ObservedSectionPlan[];
}

export interface GenericTableArtifactsResult {
  readonly cells: readonly GridCellArtifact[];
  readonly rows: readonly LogicalTableRow[];
  readonly segments: readonly TableSegmentArtifact[];
  readonly candidates: readonly FieldCandidate[];
  readonly continuation_links: readonly TableContinuationLink[];
  readonly chains: readonly TableChainArtifact[];
  readonly sections: readonly TableSectionArtifact[];
  readonly gaps: readonly ProcessingGap[];
  readonly reconstruction_diagnostics: GenericTableReconstructionDiagnostics;
}

const noBorders: GridCellArtifact['border_evidence'] = Object.freeze({
  top: 'none',
  right: 'none',
  bottom: 'none',
  left: 'none',
});

function nonEmpty<T>(items: readonly T[], detail: string): NonEmpty<T> {
  if (items.length === 0) throw new Error(detail);
  return items as unknown as NonEmpty<T>;
}

function validBox(box: BoundingBox): boolean {
  return box.coordinate_space === 'page_normalized'
    && box.origin === 'top_left'
    && [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite)
    && box.x0 >= 0 && box.y0 >= 0 && box.x1 <= 1 && box.y1 <= 1
    && box.x0 < box.x1 && box.y0 < box.y1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Identity-independent source ordering. Generated artifact IDs deliberately do
 * not participate because their values change with parser-manifest provenance.
 */
export function compareSourceFragmentsBySourceOrder(
  left: SourceFragmentArtifact,
  right: SourceFragmentArtifact,
): number {
  return left.page - right.page
    || left.bounding_box.y0 - right.bounding_box.y0
    || left.bounding_box.x0 - right.bounding_box.x0
    || left.bounding_box.y1 - right.bounding_box.y1
    || left.bounding_box.x1 - right.bounding_box.x1
    || left.reading_order - right.reading_order
    || compareText(left.raw_text, right.raw_text)
    || compareText(left.kind, right.kind)
    || compareText(left.parser.stage, right.parser.stage)
    || compareText(left.parser.name, right.parser.name)
    || compareText(left.parser.version, right.parser.version)
    || (left.recognition_confidence ?? -1) - (right.recognition_confidence ?? -1);
}

function compareCellsBySourceStructure(
  left: GridCellArtifact,
  right: GridCellArtifact,
): number {
  return left.column_start - right.column_start
    || left.row_start - right.row_start
    || left.bounding_box.y0 - right.bounding_box.y0
    || left.bounding_box.x0 - right.bounding_box.x0
    || left.bounding_box.y1 - right.bounding_box.y1
    || left.bounding_box.x1 - right.bounding_box.x1
    || compareText(left.raw_text, right.raw_text)
    || left.row_span - right.row_span
    || left.column_span - right.column_span;
}

function compareSegmentsBySourceStructure(
  left: TableSegmentArtifact,
  right: TableSegmentArtifact,
): number {
  return left.page - right.page
    || left.reading_order - right.reading_order
    || left.bounding_box.y0 - right.bounding_box.y0
    || left.bounding_box.x0 - right.bounding_box.x0
    || left.bounding_box.y1 - right.bounding_box.y1
    || left.bounding_box.x1 - right.bounding_box.x1
    || compareText(
      hashCanonical(left.column_hypotheses.map((column) => ({
        index: column.index,
        x0: column.x0,
        x1: column.x1,
        header: column.header.normalized_label,
      }))),
      hashCanonical(right.column_hypotheses.map((column) => ({
        index: column.index,
        x0: column.x0,
        x1: column.x1,
        header: column.header.normalized_label,
      }))),
    );
}

function unionBox(fragments: NonEmpty<SourceFragmentArtifact>): BoundingBox {
  const first = fragments[0].bounding_box;
  return {
    coordinate_space: 'page_normalized',
    origin: 'top_left',
    x0: Math.min(...fragments.map(({ bounding_box }) => bounding_box.x0)),
    y0: Math.min(...fragments.map(({ bounding_box }) => bounding_box.y0)),
    x1: Math.max(...fragments.map(({ bounding_box }) => bounding_box.x1)),
    y1: Math.max(...fragments.map(({ bounding_box }) => bounding_box.y1)),
    rotation: first.rotation,
  };
}

function orderedLines(fragments: NonEmpty<SourceFragmentArtifact>): {
  readonly text: string;
  readonly lineBreakOffsets: readonly number[];
  readonly ordered: NonEmpty<SourceFragmentArtifact>;
} {
  const ordered = nonEmpty([...fragments].sort((left, right) => {
    const ly = (left.bounding_box.y0 + left.bounding_box.y1) / 2;
    const ry = (right.bounding_box.y0 + right.bounding_box.y1) / 2;
    return ly - ry || left.bounding_box.x0 - right.bounding_box.x0
      || left.reading_order - right.reading_order
      || compareSourceFragmentsBySourceOrder(left, right);
  }), 'Ordered cell content requires at least one source fragment.');
  const lines: SourceFragmentArtifact[][] = [];
  for (const fragment of ordered) {
    const line = lines.find((members) => {
      return members.some((member) =>
        verticalOverlapRatio(fragment, member)
          >= GENERIC_TABLE_POLICY_V6.fragment_coalescing.minimum_vertical_overlap_ratio);
    });
    if (line) line.push(fragment);
    else lines.push([fragment]);
  }
  const text = lines.map((line) => line
    .sort((left, right) => left.bounding_box.x0 - right.bounding_box.x0)
    .map(({ raw_text }) => raw_text)
    .join(' ')).join('\n');
  const lineBreakOffsets: number[] = [];
  let offset = 0;
  for (const line of text.split('\n').slice(0, -1)) {
    offset += [...line].length;
    lineBreakOffsets.push(offset);
    offset += 1;
  }
  return { text, lineBreakOffsets, ordered };
}

function valueKind(text: string): TableValueKind {
  const trimmed = text.trim();
  if (!trimmed) return 'unknown';
  if (/^[+-]?\d+$/.test(trimmed)) return 'integer';
  if (/^[$]\s*[+-]?(?:\d+(?:,\d{3})*|\d*)\.\d{2}$/.test(trimmed)) return 'currency';
  if (/^[+-]?(?:\d+(?:,\d{3})*|\d*)\.\d+$/.test(trimmed)) return 'decimal';
  if (/^\d{1,4}[/-]\d{1,2}[/-]\d{1,4}$/.test(trimmed)) return 'date_like';
  if (/^(?:true|false|yes|no)$/i.test(trimmed)) return 'boolean_like';
  if (/^[A-Za-z]{1,8}$/.test(trimmed)) return 'unit_token';
  if (/^[A-Za-z0-9][A-Za-z0-9_.#/-]*$/.test(trimmed)) return 'identifier';
  return 'free_text';
}

function confidence(
  cellId: GridCellArtifact['id'],
  cellBox: BoundingBox,
  cellText: string,
  sourceTokens: NonEmpty<SourceFragmentArtifact>,
): ExtractionConfidence {
  const ids: NonEmpty<GridCellArtifact['id']> = [cellId];
  const recognitionValues = sourceTokens
    .map(({ recognition_confidence }) => recognition_confidence)
    .filter((value): value is number => value != null);
  const recognitionScore = recognitionValues.length === sourceTokens.length
    ? recognitionValues.reduce((sum, value) => sum + value, 0) / recognitionValues.length
    : null;
  const tokenArea = sourceTokens.reduce((sum, token) =>
    sum + ((token.bounding_box.x1 - token.bounding_box.x0)
      * (token.bounding_box.y1 - token.bounding_box.y0)), 0);
  const coveredArea = sourceTokens.reduce((sum, token) => {
    const width = Math.max(0, Math.min(cellBox.x1, token.bounding_box.x1)
      - Math.max(cellBox.x0, token.bounding_box.x0));
    const height = Math.max(0, Math.min(cellBox.y1, token.bounding_box.y1)
      - Math.max(cellBox.y0, token.bounding_box.y0));
    return sum + (width * height);
  }, 0);
  const geometryScore = tokenArea === 0 ? 0 : coveredArea / tokenArea;
  let searchOffset = 0;
  let preservedCharacters = 0;
  const totalObservedCharacters = sourceTokens.reduce(
    (sum, token) => sum + token.raw_text.length,
    0,
  );
  for (const token of sourceTokens) {
    const foundAt = cellText.indexOf(token.raw_text, searchOffset);
    if (foundAt < 0) continue;
    preservedCharacters += token.raw_text.length;
    searchOffset = foundAt + token.raw_text.length;
  }
  const parseScore = totalObservedCharacters === 0
    ? 0
    : preservedCharacters / totalObservedCharacters;
  const observedScores = [
    ...(recognitionScore == null ? [] : [recognitionScore]),
    geometryScore,
    parseScore,
  ];
  const overall = observedScores.reduce((sum, score) => sum + score, 0)
    / observedScores.length;
  const observed = (score: number, diagnostics: readonly string[]) => ({
    state: 'observed' as const,
    score,
    basis_artifact_ids: ids,
    diagnostics,
  });
  return {
    version: 'extraction-confidence-v1',
    recognition: recognitionScore == null ? {
      state: 'not_available' as const,
      score: null,
      basis_artifact_ids: [] as const,
      diagnostics: ['one or more source tokens have no engine recognition score'],
    } : observed(recognitionScore, ['mean of observed source-token recognition scores']),
    geometry_alignment: observed(
      geometryScore,
      ['measured fraction of source-token area contained by the cell box'],
    ),
    parse_normalization: observed(
      parseScore,
      ['measured ordered source-token characters preserved in cell text'],
    ),
    cross_engine_agreement: {
      state: 'not_applicable',
      score: null,
      basis_artifact_ids: [],
      diagnostics: [],
    },
    overall,
    grade: overall >= 0.85 ? 'high' : overall >= 0.6 ? 'medium' : 'low',
    uncertainties: recognitionScore == null ? ['recognition_score_unavailable'] : [],
  };
}

function assertIdentity(
  input: BuildGenericTableArtifactsInput,
  fragment: SourceFragmentArtifact,
  page: PageArtifact,
): void {
  if (
    fragment.organization_id !== input.source_artifact.organization_id
    || page.organization_id !== input.source_artifact.organization_id
    || fragment.extraction_run_id !== input.run.id
    || page.extraction_run_id !== input.run.id
    || fragment.source_artifact_id !== input.source_artifact.id
    || page.source_artifact_id !== input.source_artifact.id
    || fragment.source_sha256 !== input.source_artifact.source_sha256
    || page.source_sha256 !== input.source_artifact.source_sha256
    || fragment.parser_manifest_hash !== input.run.parser_manifest_hash
    || page.parser_manifest_hash !== input.run.parser_manifest_hash
    || fragment.page_artifact_id !== page.id
    || fragment.page !== page.page
  ) {
    throw new Error('Table artifact input crosses source, run, manifest, or page identity.');
  }
}

function gap(
  input: BuildGenericTableArtifactsInput,
  detail: string,
  fragments: readonly SourceFragmentArtifact[],
  page: number | null,
  box: BoundingBox | null,
): ProcessingGap {
  const id = opaqueIds.processingGap({
    extraction_run_id: input.run.id,
    fragment_ids: fragments.map(({ id: fragmentId }) => fragmentId),
    reason: 'table_structure_unresolved',
    detail,
  });
  return {
    id,
    gap_key: `step3:table_structure_unresolved:${id}`,
    organization_id: input.source_artifact.organization_id,
    source_document_id: input.source_artifact.source_document_id,
    extraction_run_id: input.run.id,
    page,
    bounding_box: box,
    stage: 'table_reconstruction',
    reason: 'table_structure_unresolved',
    retryable: false,
    attempts: 1,
    detail,
    upstream_artifact_ids: fragments.map(({ id: fragmentId }) => fragmentId),
  };
}

function quantile(values: readonly number[], percentile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round((sorted.length - 1) * percentile)),
  );
  return sorted[index] ?? null;
}

function summarize(values: readonly number[]): DistributionSummary {
  return {
    sample_count: values.length,
    minimum: quantile(values, 0),
    q25: quantile(values, 0.25),
    median: quantile(values, 0.5),
    q75: quantile(values, 0.75),
    maximum: quantile(values, 1),
  };
}

function bounded(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function splitGapClusters(values: readonly number[]): {
  readonly lower: readonly number[];
  readonly upper: readonly number[];
  readonly threshold: number | null;
  readonly confidence: number;
} {
  if (
    values.length
      < GENERIC_TABLE_POLICY_V6.geometry_calibration.minimum_horizontal_samples
  ) {
    return { lower: [], upper: [], threshold: null, confidence: 0 };
  }
  let lowerMean = quantile(values, 0.25) ?? 0;
  let upperMean = quantile(values, 0.75) ?? 0;
  let lower: number[] = [];
  let upper: number[] = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    lower = [];
    upper = [];
    for (const value of values) {
      if (Math.abs(value - lowerMean) <= Math.abs(value - upperMean)) {
        lower.push(value);
      } else {
        upper.push(value);
      }
    }
    if (lower.length === 0 || upper.length === 0) break;
    lowerMean = lower.reduce((sum, value) => sum + value, 0) / lower.length;
    upperMean = upper.reduce((sum, value) => sum + value, 0) / upper.length;
  }
  const minimumClusterSamples =
    GENERIC_TABLE_POLICY_V6.geometry_calibration.minimum_cluster_samples;
  const ratio = lowerMean > 0 ? upperMean / lowerMean : Number.POSITIVE_INFINITY;
  if (
    lower.length < minimumClusterSamples
    || upper.length < minimumClusterSamples
    || ratio < GENERIC_TABLE_POLICY_V6.geometry_calibration.minimum_cluster_ratio
  ) {
    return { lower, upper, threshold: null, confidence: 0 };
  }
  const lowerMaximum = Math.max(...lower);
  const upperMinimum = Math.min(...upper);
  if (upperMinimum <= lowerMaximum) {
    return { lower, upper, threshold: null, confidence: 0 };
  }
  return {
    lower,
    upper,
    threshold: (lowerMaximum + upperMinimum) / 2,
    confidence: Number(Math.min(
      1,
      (ratio - 1)
        / GENERIC_TABLE_POLICY_V6.geometry_calibration.minimum_cluster_ratio,
    ).toFixed(6)),
  };
}

function thresholdDiagnostic(input: {
  readonly derived: number | null;
  readonly previousDefault: number;
  readonly measurements: DistributionSummary;
  readonly minimum: number;
  readonly maximum: number;
  readonly confidence: number;
  readonly insufficientReason: string;
}): GeometryThresholdDiagnostic {
  const adaptive = input.derived != null
    && input.confidence
      >= GENERIC_TABLE_POLICY_V6.geometry_calibration.minimum_adaptive_confidence;
  const rawDerived = adaptive ? input.derived! : null;
  const selected = rawDerived == null
    ? bounded(input.previousDefault, input.minimum, input.maximum)
    : bounded(rawDerived, input.minimum, input.maximum);
  const appliedBound = rawDerived == null || selected === rawDerived
    ? 'none' as const
    : selected === input.minimum ? 'floor' as const : 'ceiling' as const;
  return {
    selected,
    previous_default: input.previousDefault,
    derived: input.derived,
    raw_derived: input.derived,
    mode: adaptive ? 'adaptive' : 'fallback',
    confidence: adaptive ? input.confidence : 0,
    supporting_measurements: input.measurements,
    applied_bound: appliedBound,
    bound_value: appliedBound === 'none' ? null : selected,
    bound_reason: appliedBound === 'none'
      ? null
      : `${appliedBound}_safety_bound_applied_to_observed_distribution`,
    fallback_reason: adaptive ? null : input.insufficientReason,
  };
}

function groupInlineCellFragments(
  fragments: NonEmpty<SourceFragmentArtifact>,
  maximumInlineGap =
    GENERIC_TABLE_POLICY_V6.fragment_coalescing.maximum_inline_gap,
): NonEmpty<NonEmpty<SourceFragmentArtifact>> {
  const sorted = nonEmpty(
    [...fragments].sort((left, right) =>
      left.bounding_box.x0 - right.bounding_box.x0
      || left.reading_order - right.reading_order
      || compareSourceFragmentsBySourceOrder(left, right)),
    'Inline cell grouping requires source fragments.',
  );
  const groups: SourceFragmentArtifact[][] = [];
  for (const fragment of sorted) {
    const current = groups.at(-1);
    const previous = current?.at(-1);
    const inlineGap = previous
      ? fragment.bounding_box.x0 - previous.bounding_box.x1
      : Number.POSITIVE_INFINITY;
    const previousText = previous?.raw_text.trim() ?? '';
    const currentText = fragment.raw_text.trim();
    const observedCurrencyPair = /^[\$â‚¬Â£Â¥]$/.test(previousText)
      && /^[+-]?(?:\d+(?:,\d{3})*|\d*)\.\d+$/.test(currentText)
      && inlineGap
        <= GENERIC_TABLE_POLICY_V6.fragment_coalescing.currency_pair_maximum_inline_gap;
    const observedCurrencyDashPair =
      /^(?:\$|\u20ac|\u00a3|\u00a5)$/u.test(previousText)
      && /^(?:-|\u2013|\u2014)$/u.test(currentText)
      && inlineGap
        <= GENERIC_TABLE_POLICY_V6.fragment_coalescing.currency_pair_maximum_inline_gap;
    if (
      current
      && (
        inlineGap < maximumInlineGap
        || observedCurrencyPair
        || observedCurrencyDashPair
      )
    ) {
      current.push(fragment);
    } else {
      groups.push([fragment]);
    }
  }
  return nonEmpty(
    groups.map((group) =>
      nonEmpty(group, 'Inline cell group requires source fragments.')),
    'Inline cell grouping requires at least one cell.',
  );
}

function modalKind(
  rows: readonly NonEmpty<NonEmpty<SourceFragmentArtifact>>[],
  columnIndex: number,
): TableValueKind | null {
  const counts = new Map<TableValueKind, number>();
  for (const row of rows) {
    const cell = row[columnIndex];
    if (!cell) continue;
    const kind = valueKind(orderedLines(cell).text);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0]
    ?? null;
}

function firstRowHasStructuralHeaderContrast(
  rows: readonly NonEmpty<NonEmpty<SourceFragmentArtifact>>[],
): boolean {
  const first = rows[0];
  if (
    !first
    || rows.length < 2
    || first.length < GENERIC_TABLE_POLICY_V6.header_detection.minimum_columns
  ) {
    return false;
  }
  const firstKinds = first.map((cell) => valueKind(orderedLines(cell).text));
  const firstIsNonNumeric = firstKinds.every((kind) =>
    !['integer', 'decimal', 'currency', 'date_like', 'boolean_like'].includes(kind));
  if (!firstIsNonNumeric) return false;
  const laterRows = rows.slice(1);
  const contrasts = firstKinds.filter((kind, columnIndex) => {
    const laterKind = modalKind(laterRows, columnIndex);
    return laterKind != null && laterKind !== kind;
  }).length;
  return contrasts >= GENERIC_TABLE_POLICY_V6.header_detection.minimum_kind_contrasts;
}

function verticalOverlapRatio(
  left: SourceFragmentArtifact,
  right: SourceFragmentArtifact,
): number {
  const overlap = Math.max(
    0,
    Math.min(left.bounding_box.y1, right.bounding_box.y1)
      - Math.max(left.bounding_box.y0, right.bounding_box.y0),
  );
  const minimumHeight = Math.min(
    left.bounding_box.y1 - left.bounding_box.y0,
    right.bounding_box.y1 - right.bounding_box.y0,
  );
  return minimumHeight <= 0 ? 0 : overlap / minimumHeight;
}

function rowCenter(row: NonEmpty<SourceFragmentArtifact>): number {
  return row.reduce(
    (sum, token) => sum + (token.bounding_box.y0 + token.bounding_box.y1) / 2,
    0,
  ) / row.length;
}

function calibratePageGeometry(
  page: PageArtifact,
  rows: readonly NonEmpty<SourceFragmentArtifact>[],
): PageGeometryCalibration {
  const horizontalGaps = rows.flatMap((row) => {
    const ordered = [...row].sort(
      (left, right) => left.bounding_box.x0 - right.bounding_box.x0,
    );
    return ordered.slice(1).flatMap((fragment, index) => {
      const observed = fragment.bounding_box.x0 - ordered[index]!.bounding_box.x1;
      return observed >= 0 ? [observed] : [];
    });
  });
  const centers = rows.map(rowCenter).sort((left, right) => left - right);
  const rowSpacings = centers.slice(1)
    .map((center, index) => center - centers[index]!)
    .filter((value) => value > 0);
  const baselineVariations = rows.flatMap((row) => {
    const rowMedian = quantile(
      row.map((fragment) =>
        (fragment.bounding_box.y0 + fragment.bounding_box.y1) / 2),
      0.5,
    ) ?? 0;
    return row.map((fragment) => Math.abs(
      (fragment.bounding_box.y0 + fragment.bounding_box.y1) / 2 - rowMedian,
    ));
  });
  const horizontalClusters = splitGapClusters(horizontalGaps);
  const verticalClusters = rowSpacings.length
    >= GENERIC_TABLE_POLICY_V6.geometry_calibration.minimum_vertical_samples
    ? splitGapClusters(rowSpacings)
    : { lower: [], upper: [], threshold: null, confidence: 0 };
  const horizontalSummary = summarize(horizontalGaps);
  const rowSpacingSummary = summarize(rowSpacings);
  const baselineSummary = summarize(baselineVariations);
  const calibration = GENERIC_TABLE_POLICY_V6.geometry_calibration;
  const maximumInlineGap = thresholdDiagnostic({
    derived: horizontalClusters.threshold == null
      ? null
      : (quantile(horizontalGaps, 0.25) ?? 0) * 1.35,
    previousDefault: GENERIC_TABLE_POLICY_V6.fragment_coalescing.maximum_inline_gap,
    measurements: horizontalSummary,
    minimum: calibration.inline_gap_bounds.minimum,
    maximum: calibration.inline_gap_bounds.maximum,
    confidence: horizontalClusters.confidence,
    insufficientReason: 'insufficient_supported_horizontal_gap_clusters',
  });
  const continuationCenterDistance = thresholdDiagnostic({
    derived: verticalClusters.threshold == null
      ? null
      : (quantile(rowSpacings, 0.25) ?? 0) * 1.25,
    previousDefault:
      GENERIC_TABLE_POLICY_V6.logical_row_assembly.maximum_continuation_center_distance,
    measurements: rowSpacingSummary,
    minimum: calibration.continuation_distance_bounds.minimum,
    maximum: calibration.continuation_distance_bounds.maximum,
    confidence: verticalClusters.confidence,
    insufficientReason: 'insufficient_supported_row_spacing_clusters',
  });
  const columnCenterTolerance = thresholdDiagnostic({
    derived: horizontalClusters.threshold != null && horizontalClusters.lower.length
      ? (quantile(horizontalGaps, 0.25) ?? 0) * 1.75
      : null,
    previousDefault: GENERIC_TABLE_POLICY_V6.column_center_tolerance,
    measurements: horizontalSummary,
    minimum: calibration.column_tolerance_bounds.minimum,
    maximum: calibration.column_tolerance_bounds.maximum,
    confidence: horizontalClusters.confidence,
    insufficientReason: 'insufficient_supported_inter_column_gap_measurements',
  });
  const boundaryUncertainty = thresholdDiagnostic({
    derived: horizontalClusters.threshold != null && horizontalClusters.lower.length
      ? (quantile(horizontalClusters.lower, 0.5) ?? 0) / 2
      : null,
    previousDefault: calibration.boundary_uncertainty_bounds.maximum,
    measurements: horizontalSummary,
    minimum: calibration.boundary_uncertainty_bounds.minimum,
    maximum: calibration.boundary_uncertainty_bounds.maximum,
    confidence: horizontalClusters.confidence,
    insufficientReason: 'insufficient_supported_intra_cell_gap_measurements',
  });
  const measuredRowCenterTolerance =
    baselineVariations.length >= calibration.minimum_vertical_samples
      ? (quantile(baselineVariations, 0.75) ?? 0) * 2
      : null;
  const derivedRowCenterTolerance = measuredRowCenterTolerance != null
      && measuredRowCenterTolerance > 0.0001
    ? measuredRowCenterTolerance
    : null;
  const rowCenterTolerance = thresholdDiagnostic({
    derived: derivedRowCenterTolerance,
    previousDefault: GENERIC_TABLE_POLICY_V6.row_center_tolerance,
    measurements: baselineSummary,
    minimum: 0.004,
    maximum: GENERIC_TABLE_POLICY_V6.row_center_tolerance,
    confidence: derivedRowCenterTolerance == null ? 0 : 0.75,
    insufficientReason: 'insufficient_supported_baseline_variation_measurements',
  });
  return {
    page_artifact_id: page.id,
    page: page.page,
    policy_version: calibration.version,
    horizontal_gaps: horizontalSummary,
    horizontal_gap_clusters: {
      lower: summarize(horizontalClusters.lower),
      upper: summarize(horizontalClusters.upper),
      separation_threshold: horizontalClusters.threshold,
      confidence: horizontalClusters.confidence,
    },
    row_spacings: rowSpacingSummary,
    row_spacing_clusters: {
      lower: summarize(verticalClusters.lower),
      upper: summarize(verticalClusters.upper),
      separation_threshold: verticalClusters.threshold,
      confidence: verticalClusters.confidence,
    },
    baseline_variations: baselineSummary,
    thresholds: {
      maximum_inline_gap: maximumInlineGap,
      column_center_tolerance: columnCenterTolerance,
      continuation_center_distance: continuationCenterDistance,
      row_center_tolerance: rowCenterTolerance,
      boundary_uncertainty: boundaryUncertainty,
    },
  };
}

interface CoarseColumnBand {
  readonly index: number;
  readonly anchor: number;
  readonly x0: number;
  readonly x1: number;
}

interface IndexedRowCell {
  fragments: NonEmpty<SourceFragmentArtifact>;
  readonly columnIndex: number;
}

interface IndexedPhysicalRow {
  readonly physicalRowIndex: number;
  readonly cells: readonly IndexedRowCell[];
  readonly anchorFragments: NonEmpty<SourceFragmentArtifact>;
}

function inferCoarseColumnBands(
  provisionalRows: readonly NonEmpty<NonEmpty<SourceFragmentArtifact>>[],
): readonly CoarseColumnBand[] {
  const rowLengthCounts = new Map<number, number>();
  for (const row of provisionalRows.filter((candidate) => candidate.length > 1)) {
    rowLengthCounts.set(row.length, (rowLengthCounts.get(row.length) ?? 0) + 1);
  }
  const modalColumnCount = [...rowLengthCounts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0] ?? 1;
  if (modalColumnCount < 2) return [];
  const referenceRows = provisionalRows.filter((row) => row.length === modalColumnCount);
  const anchors = Array.from({ length: modalColumnCount }, (_, columnIndex) => {
    const positions = referenceRows
      .map((row) => row[columnIndex])
      .filter((cell): cell is NonEmpty<SourceFragmentArtifact> => cell != null)
      .map((cell) => Math.min(...cell.map(({ bounding_box }) => bounding_box.x0)))
      .sort((left, right) => left - right);
    return positions[Math.floor(positions.length / 2)] ?? 0;
  }).sort((left, right) => left - right);
  return anchors.map((anchor, index) => ({
    index,
    anchor,
    x0: index === 0 ? 0 : (anchors[index - 1]! + anchor) / 2,
    x1: index === anchors.length - 1 ? 1 : (anchor + anchors[index + 1]!) / 2,
  }));
}

interface ApparentCellAssignment {
  readonly cellIndex: number;
  readonly columnIndex: number | null;
  readonly selectedCost: number;
  readonly alternativeCost: number | null;
  readonly margin: number | null;
  readonly confidence: number;
}

function assignApparentCells(
  cells: readonly NonEmpty<SourceFragmentArtifact>[],
  bands: readonly CoarseColumnBand[],
  calibration: PageGeometryCalibration,
): {
  readonly assignments: readonly ApparentCellAssignment[];
  readonly candidateMatrix: RowAnchorAssignmentDiagnostic['candidate_matrix'];
} {
  const orderedCells = [...cells].sort((left, right) =>
    unionBox(left).x0 - unionBox(right).x0
    || compareSourceFragmentsBySourceOrder(left[0], right[0]));
  const candidateMatrix = orderedCells.map((cell) => {
    const cellBox = unionBox(cell);
    const x = cellBox.x0;
    const centers = cell.map((fragment) =>
      (fragment.bounding_box.y0 + fragment.bounding_box.y1) / 2);
    const verticalDispersion = Math.max(...centers) - Math.min(...centers);
    return bands.map((band) => {
      const width = Math.max(0.001, band.x1 - band.x0);
      const distance = Math.abs(x - band.anchor);
      const contained = x >= band.x0 && x <= band.x1;
      const overlap = intervalOverlap(cellBox, band);
      const boundaryDistance = Math.min(
        Math.abs(x - band.x0),
        Math.abs(x - band.x1),
      );
      const boundaryPenalty = boundaryDistance
          <= calibration.thresholds.boundary_uncertainty.selected
        ? 0.12 : 0;
      const feasible = (
        contained
        || distance
          <= calibration.thresholds.column_center_tolerance.selected * 2
        || overlap >= 0.25
      ) && verticalDispersion
        <= calibration.thresholds.row_center_tolerance.selected * 2;
      const cost = Number(Math.min(1, (
        distance / Math.max(
          calibration.thresholds.column_center_tolerance.selected,
          width,
        ) * 0.5
        + (1 - overlap) * 0.25
        + (contained ? 0 : 0.15)
        + boundaryPenalty
        + Math.min(
          1,
          verticalDispersion
            / calibration.thresholds.row_center_tolerance.selected,
        ) * 0.1
      )).toFixed(6));
      return {
        column_index: band.index,
        cost,
        feasible,
        rejection_reason: feasible ? null : 'geometry_outside_measured_tolerance',
      };
    });
  });
  const rows = orderedCells.length + 1;
  const columns = bands.length + 1;
  const costs = Array.from({ length: rows }, () =>
    Array.from({ length: columns }, () => Number.POSITIVE_INFINITY));
  const previous = new Map<string, {
    readonly i: number;
    readonly j: number;
    readonly action: 'assign' | 'skip_cell' | 'skip_anchor';
  }>();
  costs[0]![0] = 0;
  for (let i = 0; i <= orderedCells.length; i += 1) {
    for (let j = 0; j <= bands.length; j += 1) {
      const current = costs[i]![j]!;
      if (!Number.isFinite(current)) continue;
      if (j < bands.length && current < costs[i]![j + 1]!) {
        costs[i]![j + 1] = current;
        previous.set(`${i}:${j + 1}`, { i, j, action: 'skip_anchor' });
      }
      if (
        i < orderedCells.length
        && current + GENERIC_TABLE_POLICY_V6.column_inference.unassigned_cost
          < costs[i + 1]![j]!
      ) {
        costs[i + 1]![j] =
          current + GENERIC_TABLE_POLICY_V6.column_inference.unassigned_cost;
        previous.set(`${i + 1}:${j}`, { i, j, action: 'skip_cell' });
      }
      const candidate = candidateMatrix[i]?.[j];
      if (
        i < orderedCells.length
        && j < bands.length
        && candidate?.feasible
        && candidate.cost
          <= GENERIC_TABLE_POLICY_V6.column_inference.maximum_assignment_cost
        && current + candidate.cost < costs[i + 1]![j + 1]!
      ) {
        costs[i + 1]![j + 1] = current + candidate.cost;
        previous.set(`${i + 1}:${j + 1}`, { i, j, action: 'assign' });
      }
    }
  }
  let i = orderedCells.length;
  let j = bands.length;
  const selectedColumns = new Map<number, number>();
  while (i > 0 || j > 0) {
    const step = previous.get(`${i}:${j}`);
    if (!step) break;
    if (step.action === 'assign') selectedColumns.set(i - 1, j - 1);
    i = step.i;
    j = step.j;
  }
  return {
    candidateMatrix,
    assignments: orderedCells.map((cell, cellIndex) => {
      const columnIndex = selectedColumns.get(cellIndex) ?? null;
      const candidates = candidateMatrix[cellIndex]!
        .filter(({ feasible }) => feasible)
        .sort((left, right) =>
          left.cost - right.cost || left.column_index - right.column_index);
      const selectedCost = columnIndex == null
        ? GENERIC_TABLE_POLICY_V6.column_inference.unassigned_cost
        : candidateMatrix[cellIndex]![columnIndex]!.cost;
      const alternative = candidates.find(({ column_index }) =>
        column_index !== columnIndex)?.cost ?? null;
      const margin = alternative == null
        ? null : Number((alternative - selectedCost).toFixed(6));
      const sufficientlyDistinct = margin == null
        || margin >= GENERIC_TABLE_POLICY_V6.column_inference.minimum_assignment_margin;
      return {
        cellIndex,
        columnIndex: sufficientlyDistinct ? columnIndex : null,
        selectedCost,
        alternativeCost: alternative,
        margin,
        confidence: sufficientlyDistinct
          ? Number(Math.max(0, 1 - selectedCost).toFixed(6))
          : 0,
      };
    }),
  };
}

function intervalOverlap(
  left: { readonly x0: number; readonly x1: number },
  right: { readonly x0: number; readonly x1: number },
): number {
  const overlap = Math.max(0, Math.min(left.x1, right.x1) - Math.max(left.x0, right.x0));
  const minimumWidth = Math.min(left.x1 - left.x0, right.x1 - right.x0);
  return minimumWidth <= 0 ? 0 : overlap / minimumWidth;
}

function textContinuationShape(
  sparseText: string,
  targetText: string,
  direction: 'backward' | 'forward',
): number {
  const before = direction === 'backward' ? targetText.trim() : sparseText.trim();
  const after = direction === 'backward' ? sparseText.trim() : targetText.trim();
  let score = 0.35;
  if (/[,;:/(\-]$/u.test(before)) score += 0.35;
  if (/^[a-z)\],]/u.test(after)) score += 0.2;
  if (before && after && !/[.!?]$/u.test(before)) score += 0.1;
  return Math.min(1, score);
}

function valueKindCompatibility(left: string, right: string): number {
  const leftKind = valueKind(left);
  const rightKind = valueKind(right);
  if (leftKind === rightKind) return 1;
  const textKinds: readonly TableValueKind[] = [
    'free_text',
    'identifier',
    'unit_token',
  ];
  return textKinds.includes(leftKind) && textKinds.includes(rightKind) ? 0.75 : 0.25;
}

function attachSparseContinuationRows(input: {
  readonly source: BuildGenericTableArtifactsInput;
  readonly page: PageArtifact;
  readonly rows: readonly IndexedPhysicalRow[];
  readonly bands: readonly CoarseColumnBand[];
  readonly calibration: PageGeometryCalibration;
}): {
  readonly rows: readonly NonEmpty<IndexedRowCell>[];
  readonly dispositions: readonly SparseRowDisposition[];
  readonly gaps: readonly ProcessingGap[];
} {
  const primaryIndexes = input.rows.flatMap((row) =>
    row.cells.length > 1 ? [row.physicalRowIndex] : []);
  const primaryAnchors = new Map(
    input.rows.filter((row) => row.cells.length > 1)
      .map((row) => [row.physicalRowIndex, row.anchorFragments] as const),
  );
  const primary = new Map<number, IndexedRowCell[]>(
    input.rows.filter((row) => row.cells.length > 1)
      .map((row) => [row.physicalRowIndex, row.cells.map((cell) => ({
        columnIndex: cell.columnIndex,
        fragments: nonEmpty([...cell.fragments], 'Primary cell requires fragments.'),
      }))]),
  );
  const openedSparseCells = new Set<string>();
  const dispositions: SparseRowDisposition[] = [];
  const gaps: ProcessingGap[] = [];
  for (const sparseRow of input.rows.filter((row) => row.cells.length === 1)) {
    const openCellKeysBefore = [...openedSparseCells].sort();
    const sparse = sparseRow.cells[0]!;
    const nearestAbove = primaryIndexes.filter((index) =>
      index < sparseRow.physicalRowIndex).at(-1);
    const nearestBelow = primaryIndexes.find((index) =>
      index > sparseRow.physicalRowIndex);
    const candidateIndexes = [nearestAbove, nearestBelow]
      .filter((index): index is number => index != null);
    const continuationLimit =
      input.calibration.thresholds.continuation_center_distance.selected;
    const sparseBox = unionBox(sparse.fragments);
    const sparseText = orderedLines(sparse.fragments).text;
    const band = input.bands[sparse.columnIndex];
    const candidates: SparseAttachmentCandidateDiagnostic[] =
      candidateIndexes.flatMap((primaryIndex) => {
        const targetRow = primary.get(primaryIndex);
        const anchorFragments = primaryAnchors.get(primaryIndex);
        const targetCell = targetRow?.find((cell) =>
          cell.columnIndex === sparse.columnIndex);
        if (!targetRow || !anchorFragments || !band) return [];
        const targetRowFragments = nonEmpty(
          targetRow.flatMap(({ fragments }) => fragments),
          'Primary target row requires fragments.',
        );
        const targetFragments = targetCell?.fragments ?? targetRowFragments;
        const targetBox = targetCell
          ? unionBox(targetCell.fragments)
          : {
              ...unionBox(targetRowFragments),
              x0: band.x0,
              x1: band.x1,
            };
        const targetText = targetCell
          ? orderedLines(targetCell.fragments).text : '';
        const sparseCenter = rowCenter(sparse.fragments);
        const targetCellKey = `${primaryIndex}:${sparse.columnIndex}`;
        const targetOpenedFromSparse = openedSparseCells.has(targetCellKey);
        const targetCenters = (
          targetOpenedFromSparse ? anchorFragments : targetFragments
        ).map((fragment) =>
          (fragment.bounding_box.y0 + fragment.bounding_box.y1) / 2);
        const verticalDistance = Math.min(...targetCenters.map((center) =>
          Math.abs(sparseCenter - center)));
        if (verticalDistance > continuationLimit) return [];
        const direction = primaryIndex < sparseRow.physicalRowIndex
          ? 'backward' as const : 'forward' as const;
        const verticalProximity = Math.max(0, 1 - verticalDistance / continuationLimit);
        const horizontalOverlap = intervalOverlap(sparseBox, targetBox);
        const xAlignment = Math.max(
          0,
          1 - Math.abs(sparseBox.x0 - targetBox.x0)
            / Math.max(0.001, band.x1 - band.x0),
        );
        const kindCompatibility = valueKindCompatibility(sparseText, targetText);
        const continuationShape = textContinuationShape(
          sparseText,
          targetText,
          direction,
        );
        const occupiedRows = [...primary.values()].filter((row) =>
          row.some((cell) => cell.columnIndex === sparse.columnIndex)).length;
        const columnOccupancy = Math.min(1, occupiedRows / 2);
        const rowOrderConsistency = (
          direction === 'backward'
            ? sparseRow.physicalRowIndex > primaryIndex
            : sparseRow.physicalRowIndex < primaryIndex
        ) ? 1 : 0;
        const targetEdge = direction === 'backward'
          ? Math.max(...targetFragments.map(({ bounding_box }) => bounding_box.y1))
          : Math.min(...targetFragments.map(({ bounding_box }) => bounding_box.y0));
        const sparseEdge = direction === 'backward' ? sparseBox.y0 : sparseBox.y1;
        const evolvingEdgeDistance = Math.abs(sparseEdge - targetEdge);
        const verticalProgression = Math.max(
          0,
          1 - evolvingEdgeDistance / continuationLimit,
        );
        const neighboringRowConsistency = candidateIndexes.length === 1
          ? 1 : verticalProximity;
        const targetComplete = targetCell != null
          && /[.!?]$/u.test(targetText.trim());
        const continuityWithPrevious = targetCell != null
          && targetCell.fragments.length > 1 ? verticalProgression : 0.5;
        const score = Number((
          verticalProgression * 0.3
          + rowOrderConsistency * 0.2
          + neighboringRowConsistency * 0.15
          + columnOccupancy * 0.1
          + horizontalOverlap * 0.15
          + xAlignment * 0.05
          + (targetComplete ? 0 : 0.025)
          + continuityWithPrevious * 0.025
        ).toFixed(6));
        return [{
          primary_row_index: primaryIndex,
          direction,
          column_index: sparse.columnIndex,
          score,
          measurements: {
            vertical_distance: verticalDistance,
            vertical_proximity: verticalProximity,
            horizontal_overlap: horizontalOverlap,
            x_alignment: xAlignment,
            value_kind_compatibility: kindCompatibility,
            text_continuation_shape: continuationShape,
            target_column_occupied: targetCell != null,
            target_cell_existed: targetCell != null,
            target_cell_complete: targetComplete,
            row_order_consistency: rowOrderConsistency,
            vertical_progression: verticalProgression,
            evolving_edge_distance: evolvingEdgeDistance,
            neighboring_row_consistency: neighboringRowConsistency,
            column_occupancy_score: columnOccupancy,
            continuity_with_previous_attachment: continuityWithPrevious,
            target_cell_opened_from_sparse: targetOpenedFromSparse,
          },
        }];
      });
    const boundaryUncertainty =
      input.calibration.thresholds.boundary_uncertainty.selected;
    candidates.sort((left, right) => {
      const distanceDifference = Math.abs(
        left.measurements.vertical_distance
          - right.measurements.vertical_distance,
      );
      const shapeDifference = Math.abs(
        left.measurements.text_continuation_shape
          - right.measurements.text_continuation_shape,
      );
      if (
        distanceDifference <= boundaryUncertainty
        && shapeDifference
          >= GENERIC_TABLE_POLICY_V6.logical_row_assembly
            .minimum_continuation_shape_margin
      ) {
        return right.measurements.text_continuation_shape
          - left.measurements.text_continuation_shape
          || left.measurements.vertical_distance
            - right.measurements.vertical_distance
          || right.score - left.score
          || left.primary_row_index - right.primary_row_index;
      }
      if (
        distanceDifference <= boundaryUncertainty
        && distanceDifference
          > GENERIC_TABLE_POLICY_V6.logical_row_assembly.distance_tie_tolerance
        && shapeDifference
          < GENERIC_TABLE_POLICY_V6.logical_row_assembly
            .minimum_continuation_shape_margin
        && left.direction !== right.direction
      ) {
        return Number(right.direction === 'backward')
          - Number(left.direction === 'backward')
          || left.measurements.vertical_distance
            - right.measurements.vertical_distance
          || right.score - left.score
          || left.primary_row_index - right.primary_row_index;
      }
      return left.measurements.vertical_distance
        - right.measurements.vertical_distance
        || right.score - left.score
        || left.primary_row_index - right.primary_row_index;
    });
    const selected = candidates[0];
    const runnerUp = candidates[1];
    const scoreMargin = selected ? selected.score - (runnerUp?.score ?? 0) : 0;
    const distanceMargin = selected
      ? (runnerUp?.measurements.vertical_distance ?? continuationLimit)
        - selected.measurements.vertical_distance
      : 0;
    const tied = selected != null && runnerUp != null
      && Math.abs(
        selected.measurements.vertical_distance
          - runnerUp.measurements.vertical_distance,
      ) <= GENERIC_TABLE_POLICY_V6.logical_row_assembly.distance_tie_tolerance;
    const shapeSelected = selected != null && runnerUp != null
      && Math.abs(
        selected.measurements.vertical_distance
          - runnerUp.measurements.vertical_distance,
      ) <= boundaryUncertainty
      && selected.measurements.text_continuation_shape
        - runnerUp.measurements.text_continuation_shape
          >= GENERIC_TABLE_POLICY_V6.logical_row_assembly
            .minimum_continuation_shape_margin;
    const backwardBoundarySelected = selected != null && runnerUp != null
      && selected.direction === 'backward'
      && runnerUp.direction === 'forward'
      && Math.abs(
        selected.measurements.vertical_distance
          - runnerUp.measurements.vertical_distance,
      ) <= boundaryUncertainty
      && Math.abs(
        selected.measurements.vertical_distance
          - runnerUp.measurements.vertical_distance,
      ) > GENERIC_TABLE_POLICY_V6.logical_row_assembly.distance_tie_tolerance
      && Math.abs(
        selected.measurements.text_continuation_shape
          - runnerUp.measurements.text_continuation_shape,
      ) < GENERIC_TABLE_POLICY_V6.logical_row_assembly
        .minimum_continuation_shape_margin;
    const selectionBasis = selected == null
      ? null
      : shapeSelected
        ? 'continuation_shape_within_boundary_uncertainty' as const
        : backwardBoundarySelected
          ? 'backward_row_start_boundary_within_uncertainty' as const
        : 'vertical_distance' as const;
    const accepted = selected != null
      && selected.score
        >= GENERIC_TABLE_POLICY_V6.logical_row_assembly.minimum_attachment_score
      && (
        runnerUp == null
        || shapeSelected
        || backwardBoundarySelected
        || distanceMargin
          >= GENERIC_TABLE_POLICY_V6.logical_row_assembly.minimum_distance_margin
        || scoreMargin
          >= GENERIC_TABLE_POLICY_V6.logical_row_assembly.minimum_score_margin
      )
      && !tied;
    const dispositionEvidence = {
      selection_basis: selectionBasis,
      fragment_evidence: sparse.fragments.map((fragment) => ({
        fragment_id: fragment.id,
        raw_text: fragment.raw_text,
        bounding_box: fragment.bounding_box,
        reading_order: fragment.reading_order,
      })),
      primary_row_bands: candidateIndexes.flatMap((primaryRowIndex) => {
        const anchors = primaryAnchors.get(primaryRowIndex);
        return anchors ? [{
          primary_row_index: primaryRowIndex,
          bounding_box: unionBox(anchors),
          anchor_fragment_ids: anchors.map(({ id }) => id),
        }] : [];
      }),
      spacing_evidence: {
        continuation_center_distance: continuationLimit,
        boundary_uncertainty: boundaryUncertainty,
        calibration_mode:
          input.calibration.thresholds.continuation_center_distance.mode,
        fallback_reason:
          input.calibration.thresholds.continuation_center_distance
            .fallback_reason,
      },
      open_cell_keys_before: openCellKeysBefore,
    } as const;
    if (accepted) {
      const target = primary.get(selected.primary_row_index)?.find((cell) =>
        cell.columnIndex === selected.column_index);
      if (target) {
        target.fragments = nonEmpty(
          [...target.fragments, ...sparse.fragments],
          'Attached sparse cell requires fragments.',
        );
      } else {
        primary.get(selected.primary_row_index)?.push({
          columnIndex: selected.column_index,
          fragments: nonEmpty(
            [...sparse.fragments],
            'Created sparse cell requires fragments.',
          ),
        });
        openedSparseCells.add(
          `${selected.primary_row_index}:${selected.column_index}`,
        );
      }
      dispositions.push({
        page_artifact_id: input.page.id,
        page: input.page.page,
        physical_row_index: sparseRow.physicalRowIndex,
        fragment_ids: nonEmpty(
          sparse.fragments.map(({ id }) => id),
          'Sparse disposition requires fragments.',
        ),
        outcome: 'attached',
        candidate_rows: candidates,
        selected_primary_row_index: selected.primary_row_index,
        selected_column_index: selected.column_index,
        confidence: selected.score,
        ...dispositionEvidence,
        policy_version: GENERIC_TABLE_POLICY_V6.logical_row_assembly.version,
        rejection_reason: null,
        processing_gap_id: null,
      });
      continue;
    }
    const rejectionReason = candidates.length === 0
      ? 'no_compatible_primary_row'
      : tied ? 'candidate_scores_tied'
        : selected!.score
            < GENERIC_TABLE_POLICY_V6.logical_row_assembly.minimum_attachment_score
          ? 'attachment_score_below_minimum'
          : 'attachment_evidence_margin_below_minimum';
    const unresolvedGap = gap(
      input.source,
      `Sparse table row remains unresolved (${rejectionReason}); candidates=${JSON.stringify(
        candidates,
      )}.`,
      sparse.fragments,
      input.page.page,
      sparseBox,
    );
    gaps.push(unresolvedGap);
    dispositions.push({
      page_artifact_id: input.page.id,
      page: input.page.page,
      physical_row_index: sparseRow.physicalRowIndex,
      fragment_ids: nonEmpty(
        sparse.fragments.map(({ id }) => id),
        'Sparse disposition requires fragments.',
      ),
      outcome: 'unresolved_gap',
      candidate_rows: candidates,
      selected_primary_row_index: null,
      selected_column_index: null,
      confidence: selected?.score ?? null,
      ...dispositionEvidence,
      policy_version: GENERIC_TABLE_POLICY_V6.logical_row_assembly.version,
      rejection_reason: rejectionReason,
      processing_gap_id: unresolvedGap.id,
    });
  }
  return {
    rows: primaryIndexes.map((index) =>
      nonEmpty(
        primary.get(index) ?? [],
        'Primary table row requires resolved cells.',
      )),
    dispositions,
    gaps,
  };
}

function measureCoalescingEvidence(
  fragments: NonEmpty<SourceFragmentArtifact>,
): NonNullable<ObservedCellPlan['coalescing_evidence']> {
  const ordered = [...fragments].sort((left, right) =>
    left.bounding_box.y0 - right.bounding_box.y0
      || left.bounding_box.x0 - right.bounding_box.x0);
  const lineGroups: SourceFragmentArtifact[][] = [];
  for (const fragment of ordered) {
    const line = lineGroups.find((members) => members.some((member) =>
      verticalOverlapRatio(fragment, member)
        >= GENERIC_TABLE_POLICY_V6.fragment_coalescing.minimum_vertical_overlap_ratio));
    if (line) line.push(fragment);
    else lineGroups.push([fragment]);
  }
  const inlineGaps = lineGroups.flatMap((line) => {
    const orderedLine = [...line].sort(
      (left, right) => left.bounding_box.x0 - right.bounding_box.x0,
    );
    return orderedLine.slice(1).map((fragment, index) =>
      Math.max(
        0,
        fragment.bounding_box.x0 - orderedLine[index]!.bounding_box.x1,
      ));
  });
  const maximumObservedInlineGap = Math.max(0, ...inlineGaps);
  const hasCurrencyMarker = fragments.some((fragment) =>
    /^[\$â‚¬Â£Â¥]$/u.test(fragment.raw_text.trim()));
  const hasNumericValue = fragments.some((fragment) =>
    /^[-+]?\d[\d,.]*$/u.test(fragment.raw_text.trim()));
  const hasCurrencyMarkerUnicode = fragments.some((fragment) =>
    /^(?:\$|\u20ac|\u00a3|\u00a5)$/u.test(fragment.raw_text.trim()));
  const hasDashValue = fragments.some((fragment) =>
    /^(?:-|\u2013|\u2014)$/u.test(fragment.raw_text.trim()));

  if (hasCurrencyMarkerUnicode && hasDashValue) {
    return {
      reason: 'currency_marker_dash_pair',
      confidence: Number(Math.max(
        0,
        1 - maximumObservedInlineGap
          / GENERIC_TABLE_POLICY_V6.fragment_coalescing
            .currency_pair_maximum_inline_gap,
      ).toFixed(6)),
      maximum_observed_inline_gap: maximumObservedInlineGap,
    };
  }
  if (hasCurrencyMarker && hasNumericValue) {
    return {
      reason: 'currency_marker_numeric_pair',
      confidence: Number(Math.max(
        0,
        1 - maximumObservedInlineGap
          / GENERIC_TABLE_POLICY_V6.fragment_coalescing
            .currency_pair_maximum_inline_gap,
      ).toFixed(6)),
      maximum_observed_inline_gap: maximumObservedInlineGap,
    };
  }
  if (lineGroups.length > 1) {
    const centers = lineGroups.map((line) =>
      line.reduce(
        (sum, fragment) =>
          sum + (fragment.bounding_box.y0 + fragment.bounding_box.y1) / 2,
        0,
      ) / line.length);
    const maximumLineDistance = Math.max(
      0,
      ...centers.slice(1).map((center, index) => center - centers[index]!),
    );
    return {
      reason: 'sparse_line_nearest_column',
      confidence: Number(Math.max(
        0,
        1 - maximumLineDistance
          / GENERIC_TABLE_POLICY_V6.logical_row_assembly
            .maximum_continuation_center_distance,
      ).toFixed(6)),
      maximum_observed_inline_gap: maximumObservedInlineGap,
    };
  }
  if (fragments.length > 1) {
    return {
      reason: 'same_line_without_structural_gutter',
      confidence: Number(Math.max(
        0,
        1 - maximumObservedInlineGap
          / GENERIC_TABLE_POLICY_V6.fragment_coalescing.maximum_inline_gap,
      ).toFixed(6)),
      maximum_observed_inline_gap: maximumObservedInlineGap,
    };
  }
  return {
    reason: 'same_inferred_column',
    confidence: 1,
    maximum_observed_inline_gap: 0,
  };
}

function autoRegions(
  input: BuildGenericTableArtifactsInput,
): {
  readonly regions: readonly ObservedTableRegion[];
  readonly gaps: readonly ProcessingGap[];
  readonly diagnostics: GenericTableReconstructionDiagnostics;
} {
  const regions: ObservedTableRegion[] = [];
  const gaps: ProcessingGap[] = [];
  const calibrations: PageGeometryCalibration[] = [];
  const sparseDispositions: SparseRowDisposition[] = [];
  const overflowDiagnostics: ColumnOverflowDiagnostic[] = [];
  const rowAnchorAssignments: RowAnchorAssignmentDiagnostic[] = [];
  const tableCandidateFragmentIds = new Set<SourceFragmentArtifact['id']>();
  for (const page of input.pages) {
    const tokens = input.fragments.filter((fragment) =>
      fragment.kind === 'token' && fragment.page_artifact_id === page.id);
    const rows: SourceFragmentArtifact[][] = [];
    for (const token of [...tokens].sort((a, b) =>
      a.bounding_box.y0 - b.bounding_box.y0 || a.bounding_box.x0 - b.bounding_box.x0)) {
      const row = rows.find((members) => {
        return members.some((member) =>
          verticalOverlapRatio(token, member)
            >= GENERIC_TABLE_POLICY_V6.fragment_coalescing.minimum_vertical_overlap_ratio);
      });
      if (row) row.push(token);
      else rows.push([token]);
    }
    const physicalRows = rows.map((row) =>
      nonEmpty(row, 'Detected row requires source fragments.'));
    if (physicalRows.length === 0) continue;
    const calibration = calibratePageGeometry(page, physicalRows);
    const provisionalRows = physicalRows.map((row) =>
      groupInlineCellFragments(
        row,
        calibration.thresholds.maximum_inline_gap.selected,
      ));
    const primaryIndexes = provisionalRows.flatMap((row, index) =>
      row.length > 1 ? [index] : []);
    if (primaryIndexes.length === 0) continue;
    const continuationLimit =
      calibration.thresholds.continuation_center_distance.selected;
    const scopedPhysicalRows = physicalRows.flatMap((row, physicalRowIndex) => {
      const isPrimary = primaryIndexes.includes(physicalRowIndex);
      const nearestPrimaryDistance = Math.min(...primaryIndexes.map((index) =>
        Math.abs(rowCenter(row) - rowCenter(physicalRows[index]!))));
      return isPrimary || nearestPrimaryDistance <= continuationLimit
        ? [{ physicalRowIndex, row }] : [];
    });
    const scopedProvisionalRows = primaryIndexes.map((physicalRowIndex) =>
      provisionalRows[physicalRowIndex]!);
    const bands = inferCoarseColumnBands(scopedProvisionalRows);
    if (bands.length < 2) continue;
    calibrations.push(calibration);
    for (const { row } of scopedPhysicalRows) {
      for (const fragment of row) tableCandidateFragmentIds.add(fragment.id);
    }
    const indexedRows: IndexedPhysicalRow[] = [];
    for (const { physicalRowIndex } of scopedPhysicalRows) {
      const apparentCells = [...provisionalRows[physicalRowIndex]!]
        .sort((left, right) =>
          unionBox(left).x0 - unionBox(right).x0
          || compareSourceFragmentsBySourceOrder(left[0], right[0]));
      const assignment = assignApparentCells(
        apparentCells,
        bands,
        calibration,
      );
      const recoveredColumns = new Map<number, number>();
      for (const selected of assignment.assignments.filter(
        ({ columnIndex }) => columnIndex == null,
      )) {
        const feasibleColumns = assignment.candidateMatrix[selected.cellIndex]!
          .filter(({ feasible }) => feasible)
          .map(({ column_index }) => column_index);
        const onlyColumn = feasibleColumns.length === 1 ? feasibleColumns[0] : null;
        if (onlyColumn == null) continue;
        const anchor = assignment.assignments.find(
          ({ columnIndex }) => columnIndex === onlyColumn,
        );
        if (!anchor) continue;
        const lower = Math.min(selected.cellIndex, anchor.cellIndex);
        const upper = Math.max(selected.cellIndex, anchor.cellIndex);
        const interveningAssignedElsewhere = assignment.assignments
          .slice(lower + 1, upper)
          .some(({ columnIndex }) =>
            columnIndex != null && columnIndex !== onlyColumn);
        if (interveningAssignedElsewhere) continue;
        const combined = nonEmpty(
          [
            ...apparentCells[anchor.cellIndex]!,
            ...apparentCells[selected.cellIndex]!,
          ].sort(compareSourceFragmentsBySourceOrder),
          'Overflow recovery requires source fragments.',
        );
        const coalescing = measureCoalescingEvidence(combined);
        if (coalescing.confidence <= 0) continue;
        recoveredColumns.set(selected.cellIndex, onlyColumn);
      }
      const groupedCells = new Map<number, SourceFragmentArtifact[]>();
      for (const selected of assignment.assignments) {
        const columnIndex = selected.columnIndex
          ?? recoveredColumns.get(selected.cellIndex)
          ?? null;
        if (columnIndex == null) continue;
        groupedCells.set(columnIndex, [
          ...(groupedCells.get(columnIndex) ?? []),
          ...apparentCells[selected.cellIndex]!,
        ]);
      }
      const cells: IndexedRowCell[] = [...groupedCells.entries()]
        .sort((left, right) => left[0] - right[0])
        .map(([columnIndex, fragments]) => ({
          columnIndex,
          fragments: nonEmpty(
            [...fragments].sort(compareSourceFragmentsBySourceOrder),
            'Assigned table cell requires source fragments.',
          ),
        }));
      const assignmentDiagnostics: RowAnchorAssignmentDiagnostic[
        'selected_assignments'
      ][number][] = [];
      for (const selected of assignment.assignments) {
        const apparentCell = apparentCells[selected.cellIndex]!;
        const effectiveColumn = selected.columnIndex
          ?? recoveredColumns.get(selected.cellIndex)
          ?? null;
        if (effectiveColumn != null) {
          assignmentDiagnostics.push({
            apparent_cell_index: selected.cellIndex,
            column_index: effectiveColumn,
            selected_cost: selected.selectedCost,
            alternative_cost: selected.alternativeCost,
            margin: selected.margin,
            confidence: selected.confidence,
            structural_signal: apparentCells.length > bands.length
              ? 'structural_excess_cells' : 'ordinary',
            processing_gap_id: null,
          });
        } else {
          const unresolvedGap = gap(
            input,
            'Apparent table cell remains unassigned after global row-anchor optimization.',
            apparentCell,
            page.page,
            unionBox(apparentCell),
          );
          gaps.push(unresolvedGap);
          const feasibleColumns = assignment.candidateMatrix[
            selected.cellIndex
          ]!.filter(({ feasible }) => feasible)
            .map(({ column_index }) => column_index);
          overflowDiagnostics.push({
            page_artifact_id: page.id,
            page: page.page,
            physical_row_index: physicalRowIndex,
            fragment_ids: nonEmpty(
              apparentCell.map(({ id }) => id),
              'Column overflow requires fragments.',
            ),
            candidate_column_indexes: feasibleColumns,
            rejection_reason: feasibleColumns.length > 0
              ? 'anchor_already_occupied' : 'anchor_distance_exceeded',
            processing_gap_id: unresolvedGap.id,
          });
          assignmentDiagnostics.push({
            apparent_cell_index: selected.cellIndex,
            column_index: null,
            selected_cost: selected.selectedCost,
            alternative_cost: selected.alternativeCost,
            margin: selected.margin,
            confidence: 0,
            structural_signal: apparentCells.length > bands.length
              ? 'structural_excess_cells' : 'ordinary',
            processing_gap_id: unresolvedGap.id,
          });
        }
      }
      rowAnchorAssignments.push({
        page_artifact_id: page.id,
        page: page.page,
        physical_row_index: physicalRowIndex,
        policy_version: GENERIC_TABLE_POLICY_V6.column_inference.version,
        apparent_cell_fragment_ids: apparentCells.map((cell) =>
          cell.map(({ id }) => id)),
        candidate_matrix: assignment.candidateMatrix,
        selected_assignments: assignmentDiagnostics,
      });
      indexedRows.push({
        physicalRowIndex,
        cells,
        anchorFragments: physicalRows[physicalRowIndex]!,
      });
    }
    const attachment = attachSparseContinuationRows({
      source: input,
      page,
      rows: indexedRows,
      bands,
      calibration,
    });
    gaps.push(...attachment.gaps);
    sparseDispositions.push(...attachment.dispositions);
    if (attachment.rows.length === 0) continue;
    const rowFragments = attachment.rows.map((row) =>
      nonEmpty(
        [...row]
          .sort((left, right) => left.columnIndex - right.columnIndex)
          .map(({ fragments }) => fragments),
        'Detected table row requires cells.',
      ));
    const firstIsObservedHeader = firstRowHasStructuralHeaderContrast(rowFragments);
    regions.push({
      page_artifact_id: page.id,
      rows: nonEmpty(attachment.rows.map((row, rowIndex) => ({
        cells: nonEmpty(row
          .map((cell) => ({
            token_ids: cell.fragments.map(({ id }) => id) as unknown as
              NonEmpty<SourceFragmentArtifact['id']>,
            column_index: cell.columnIndex,
            coalescing_evidence: measureCoalescingEvidence(cell.fragments),
          })),
        'Detected table row requires at least one cell.'),
        row_kind: rowIndex === 0 && firstIsObservedHeader ? 'header' : 'unknown',
      })), 'Detected table requires at least one row.'),
      detection_evidence: ['x_alignment', 'whitespace_gutters'],
    });
  }
  const disposedFragmentIds = new Set<SourceFragmentArtifact['id']>([
    ...regions.flatMap((region) => region.rows.flatMap((row) =>
      row.cells.flatMap((cell) => cell.token_ids))),
    ...gaps.flatMap((item) => item.upstream_artifact_ids),
  ]);
  return {
    regions,
    gaps,
    diagnostics: {
      calibrations,
      sparse_row_dispositions: sparseDispositions,
      column_overflows: overflowDiagnostics,
      row_anchor_assignments: rowAnchorAssignments,
      table_candidate_fragment_count: tableCandidateFragmentIds.size,
      disposed_fragment_count: [...tableCandidateFragmentIds]
        .filter((id) => disposedFragmentIds.has(id)).length,
      undisposed_fragment_ids: [...tableCandidateFragmentIds]
        .filter((id) => !disposedFragmentIds.has(id))
        .sort((left, right) => left.localeCompare(right)),
    },
  };
}

export function buildGenericTableArtifacts(
  input: BuildGenericTableArtifactsInput,
): GenericTableArtifactsResult {
  if (input.run.source_artifact_id !== input.source_artifact.id) {
    throw new Error('Extraction run does not belong to the supplied source artifact.');
  }
  const pageById = new Map(input.pages.map((page) => [page.id, page]));
  const fragmentById = new Map(input.fragments.map((fragment) => [fragment.id, fragment]));
  for (const fragment of input.fragments) {
    const page = pageById.get(fragment.page_artifact_id);
    if (!page) throw new Error('Fragment page artifact is missing.');
    assertIdentity(input, fragment, page);
  }
  const automatic = input.regions
    ? {
        regions: input.regions,
        gaps: [] as readonly ProcessingGap[],
        diagnostics: {
          calibrations: [],
          sparse_row_dispositions: [],
          column_overflows: [],
          row_anchor_assignments: [],
          table_candidate_fragment_count: 0,
          disposed_fragment_count: 0,
          undisposed_fragment_ids: [],
        } satisfies GenericTableReconstructionDiagnostics,
      }
    : autoRegions(input);
  const regions = automatic.regions;
  const cells: GridCellArtifact[] = [];
  const rows: LogicalTableRow[] = [];
  const segments: TableSegmentArtifact[] = [];
  const candidates: FieldCandidate[] = [];
  const gaps: ProcessingGap[] = [...automatic.gaps];
  const segmentRows: LogicalTableRow[][] = [];

  for (const [regionIndex, region] of regions.entries()) {
    const page = pageById.get(region.page_artifact_id);
    if (!page) {
      gaps.push(gap(input, 'Observed table region references a missing page.', [], null, null));
      continue;
    }
    const plannedFragments = region.rows.flatMap((row) =>
      row.cells.flatMap((cell) => cell.token_ids.map((id) => fragmentById.get(id))))
      .filter((item): item is SourceFragmentArtifact => item != null);
    const uniquePlanIds = region.rows.flatMap((row) =>
      row.cells.flatMap((cell) => cell.token_ids));
    if (
      plannedFragments.length !== uniquePlanIds.length
      || plannedFragments.some((fragment) =>
        fragment.kind !== 'token'
        || fragment.page_artifact_id !== region.page_artifact_id
        || !validBox(fragment.bounding_box)
        || !fragment.raw_text)
    ) {
      gaps.push(gap(
        input,
        'Table region has a missing token, raw span, or complete source geometry.',
        plannedFragments,
        page.page,
        plannedFragments.length
          ? unionBox(nonEmpty(plannedFragments, 'Expected planned fragments.')) : null,
      ));
      continue;
    }

    const segmentIdentity = {
      source_sha256: input.source_artifact.source_sha256,
      parser_manifest_hash: input.run.parser_manifest_hash,
      page_artifact_id: page.id,
      region_index: regionIndex,
      rows: region.rows,
      parser: GENERIC_TABLE_PARSER,
    };
    const segmentId = opaqueIds.fragmentArtifact({
      kind: 'table_segment',
      ...segmentIdentity,
    });
    const localRows: LogicalTableRow[] = [];
    const localCells: GridCellArtifact[] = [];
    for (const [rowIndex, rowPlan] of region.rows.entries()) {
      const rowCells: GridCellArtifact[] = [];
      for (const [ordinalColumnIndex, cellPlan] of rowPlan.cells.entries()) {
        const columnIndex = cellPlan.column_index ?? ordinalColumnIndex;
        const tokenFragments = cellPlan.token_ids.map((id) =>
          fragmentById.get(id)) as Array<SourceFragmentArtifact | undefined>;
        if (tokenFragments.some((fragment) => !fragment)) continue;
        const sourceTokens = tokenFragments as unknown as NonEmpty<SourceFragmentArtifact>;
        const content = orderedLines(sourceTokens);
        const rowSpan = cellPlan.row_span ?? 1;
        const columnSpan = cellPlan.column_span ?? 1;
        if (
          !Number.isInteger(rowSpan) || rowSpan < 1
          || !Number.isInteger(columnSpan) || columnSpan < 1
        ) {
          gaps.push(gap(input, 'Cell span must be a positive integer.', sourceTokens, page.page,
            unionBox(sourceTokens)));
          continue;
        }
        const inferredStructure: GridCellArtifact['structure'] =
          rowSpan > 1 && columnSpan > 1 ? 'merged'
            : rowSpan > 1 ? 'row_spanning'
              : columnSpan > 1 ? 'column_spanning'
                : 'ordinary';
        const cellId = opaqueIds.fragmentArtifact({
          kind: 'table_cell',
          segment_id: segmentId,
          row_index: rowIndex,
          column_index: columnIndex,
          token_ids: content.ordered.map(({ id }) => id),
          row_span: rowSpan,
          column_span: columnSpan,
          parser: GENERIC_TABLE_PARSER,
        });
        const cell: GridCellArtifact = {
          id: cellId,
          organization_id: input.source_artifact.organization_id,
          kind: 'cell',
          extraction_run_id: input.run.id,
          source_artifact_id: input.source_artifact.id,
          page_artifact_id: page.id,
          source_document_id: input.source_artifact.source_document_id,
          source_sha256: input.source_artifact.source_sha256,
          parser_manifest_hash: input.run.parser_manifest_hash,
          page: page.page,
          bounding_box: unionBox(sourceTokens),
          raw_text: content.text,
          parser: GENERIC_TABLE_PARSER,
          recognition_confidence: null,
          reading_order: rowIndex * 10_000 + columnIndex + 1,
          content_token_ids: content.ordered.map(({ id }) => id),
          structural_evidence_ids: nonEmpty(
            content.ordered.map(({ id }) => id),
            'Cell requires structural evidence.',
          ),
          table_segment_id: segmentId,
          row_start: rowIndex,
          row_span: rowSpan,
          column_start: columnIndex,
          column_span: columnSpan,
          line_break_offsets: content.lineBreakOffsets,
          structure: cellPlan.structure ?? inferredStructure,
          border_evidence: cellPlan.border_evidence ?? noBorders,
          artifact_data: {
            table_value_kind: valueKind(content.text),
            content_token_ids: content.ordered.map(({ id }) => id),
            line_break_offsets: content.lineBreakOffsets,
            fragment_coalescing: {
              applied: content.ordered.length > 1,
              policy: GENERIC_TABLE_POLICY_V6.fragment_coalescing,
              reason: cellPlan.coalescing_evidence?.reason
                ?? 'explicit_observed_cell_plan',
              confidence: cellPlan.coalescing_evidence?.confidence ?? 1,
              maximum_observed_inline_gap:
                cellPlan.coalescing_evidence?.maximum_observed_inline_gap ?? null,
              basis_fragment_ids: content.ordered.map(({ id }) => id),
            },
            reconstruction_policy: {
              name: GENERIC_TABLE_POLICY_V6.name,
              version: GENERIC_TABLE_POLICY_V6.version,
              row_center_tolerance: GENERIC_TABLE_POLICY_V6.row_center_tolerance,
            },
          },
        };
        const candidate: FieldCandidate = {
          id: opaqueIds.fieldCandidate({
            extraction_run_id: input.run.id,
            source_fragment_ids: [cellId],
            primitive_kind: 'text',
            proposed_value: content.text,
          }),
          organization_id: input.source_artifact.organization_id,
          extraction_run_id: input.run.id,
          source_artifact_id: input.source_artifact.id,
          source_document_id: input.source_artifact.source_document_id,
          source_sha256: input.source_artifact.source_sha256,
          parser_manifest_hash: input.run.parser_manifest_hash,
          source_fragment_ids: [cellId],
          source_fragment_dependencies: [{
            fragment_artifact_id: cellId,
            dependency_role: 'content',
          }],
          raw_text: content.text,
          primitive_kind: 'text',
          proposed_value: { type: 'text', value: content.text },
          transformations: [],
          parser: GENERIC_TABLE_PARSER,
          confidence: confidence(cellId, cell.bounding_box, content.text, sourceTokens),
          status: 'candidate',
        };
        rowCells.push(cell);
        localCells.push(cell);
        candidates.push(candidate);
      }
      if (rowCells.length === 0) continue;
      const rowSourceFragments = nonEmpty(rowCells.flatMap((cell) =>
        cell.content_token_ids.map((id) => fragmentById.get(id)))
        .filter((item): item is SourceFragmentArtifact => item != null)
        .sort((a, b) => a.bounding_box.x0 - b.bounding_box.x0),
      'Table row requires source fragments.');
      const rowId = opaqueIds.fragmentArtifact({
        kind: 'table_row',
        segment_id: segmentId,
        row_index: rowIndex,
        cell_ids: rowCells.map(({ id }) => id),
        parser: GENERIC_TABLE_PARSER,
      });
      const row: LogicalTableRow = {
        id: rowId,
        organization_id: input.source_artifact.organization_id,
        kind: 'region',
        extraction_run_id: input.run.id,
        source_artifact_id: input.source_artifact.id,
        page_artifact_id: page.id,
        source_document_id: input.source_artifact.source_document_id,
        source_sha256: input.source_artifact.source_sha256,
        parser_manifest_hash: input.run.parser_manifest_hash,
        page: page.page,
        bounding_box: unionBox(rowSourceFragments),
        raw_text: rowCells.map(({ raw_text }) => raw_text).join('\t'),
        parser: GENERIC_TABLE_PARSER,
        recognition_confidence: null,
        reading_order: rowIndex + 1,
        region_role: 'table_row',
        child_fragment_ids: nonEmpty(
          rowCells.map(({ id }) => id),
          'Table row requires child cells.',
        ),
        cell_ids: rowCells.map(({ id }) => id),
        row_kind: rowPlan.row_kind ?? 'unknown',
        continued_from_row_id: rowPlan.continued_from_row_id ?? null,
        fragment_ids: nonEmpty(
          rowSourceFragments.map(({ id }) => id),
          'Table row requires source fragment IDs.',
        ),
      };
      localRows.push(row);
      rows.push(row);
    }
    if (localRows.length === 0) {
      gaps.push(gap(input, 'Table region could not be resolved into rows and cells.',
        plannedFragments,
        page.page,
        unionBox(nonEmpty(plannedFragments, 'Expected planned table fragments.'))));
      continue;
    }
    const columnIndexes = [...new Set(localCells.map(({ column_start }) => column_start))]
      .sort((left, right) => left - right);
    const segment: TableSegmentArtifact = {
      id: segmentId,
      organization_id: input.source_artifact.organization_id,
      kind: 'region',
      extraction_run_id: input.run.id,
      source_artifact_id: input.source_artifact.id,
      page_artifact_id: page.id,
      source_document_id: input.source_artifact.source_document_id,
      source_sha256: input.source_artifact.source_sha256,
      parser_manifest_hash: input.run.parser_manifest_hash,
      page: page.page,
      bounding_box: unionBox(nonEmpty(
        plannedFragments,
        'Table segment requires source fragments.',
      )),
      raw_text: localRows.map(({ raw_text }) => raw_text).join('\n'),
      parser: GENERIC_TABLE_PARSER,
      recognition_confidence: null,
      reading_order: regionIndex + 1,
      region_role: 'table',
      child_fragment_ids: nonEmpty([
        ...localRows.map(({ id }) => id),
        ...localCells.map(({ id }) => id),
      ], 'Table segment requires child fragments.'),
      column_hypotheses: columnIndexes.map((index) => {
        const columnCells = localCells.filter((cell) =>
          index >= cell.column_start && index < cell.column_start + cell.column_span);
        const headerCellIds = new Set(localRows
          .filter(({ row_kind }) => row_kind === 'header')
          .flatMap((row) => row.cell_ids));
        const valueCells = columnCells.filter((cell) => !headerCellIds.has(cell.id));
        const measuredCells = valueCells.length > 0 ? valueCells : columnCells;
        const observedKinds = measuredCells.map(({ raw_text }) => valueKind(raw_text));
        const kindCounts = new Map<TableValueKind, GridCellArtifact[]>();
        for (const cell of measuredCells) {
          const kind = valueKind(cell.raw_text);
          kindCounts.set(kind, [...(kindCounts.get(kind) ?? []), cell]);
        }
        const headerCell = localRows
          .filter(({ row_kind }) => row_kind === 'header')
          .flatMap((row) => row.cell_ids)
          .map((id) => localCells.find((cell) => cell.id === id))
          .find((cell) =>
            cell != null
            && index >= cell.column_start
            && index < cell.column_start + cell.column_span);
        return {
          index,
          x0: Math.min(...columnCells.map(({ bounding_box }) => bounding_box.x0)),
          x1: Math.max(...columnCells.map(({ bounding_box }) => bounding_box.x1)),
          header: headerCell ? {
            observed_text: headerCell.raw_text,
            normalized_label: headerCell.raw_text.normalize('NFKC').trim().replace(/\s+/g, ' '),
            fragment_ids: [headerCell.id],
            transformations: [],
          } : {
            observed_text: null,
            normalized_label: null,
            fragment_ids: [],
            transformations: [],
          },
          value_kind_hypotheses: nonEmpty(
            [...kindCounts.entries()]
              .sort((left, right) =>
                right[1].length - left[1].length || left[0].localeCompare(right[0]))
              .map(([kind, kindCells]) => ({
                kind,
                measurement: {
                  value: kindCells.length / observedKinds.length,
                  calculator: GENERIC_TABLE_PARSER,
                  basis_artifact_ids: nonEmpty(
                    kindCells.map(({ id }) => id),
                    'Column kind hypothesis requires cells.',
                  ),
                  diagnostics: [
                    'Observed frequency of primitive value kind across column cells.',
                  ],
                },
              })),
            'Column hypothesis requires a measured value kind.',
          ),
        };
      }),
      row_ids: nonEmpty(
        localRows.map(({ id }) => id),
        'Table segment requires rows.',
      ),
      repeated_header_row_ids: localRows
        .filter(({ row_kind }) => row_kind === 'header')
        .slice(1).map(({ id }) => id),
      parent_segment_id: region.parent_region_index == null
        ? null : segments[region.parent_region_index]?.id ?? null,
      detection_evidence: nonEmpty(region.detection_evidence.map((kind) => ({
        kind,
        basis_artifact_ids: nonEmpty(
          plannedFragments.map(({ id }) => id),
          'Detection evidence requires source fragments.',
        ),
        calculator: GENERIC_TABLE_PARSER,
      })), 'Table segment requires detection evidence.'),
    };
    cells.push(...localCells);
    segments.push(segment);
    segmentRows.push(localRows);
  }

  const continuationLinks = buildContinuationLinks(segments, rows, cells);
  for (const link of continuationLinks.filter(({ decision }) => decision === 'ambiguous')) {
    const from = segments.find(({ id }) => id === link.from_segment_id);
    const to = segments.find(({ id }) => id === link.to_segment_id);
    const competitionReason = link.score.measurements?.competition_reason;
    gaps.push(gap(
      input,
      typeof competitionReason === 'string'
        ? `Measured cross-page table continuation remains ambiguous: ${competitionReason}.`
        : 'Measured cross-page table continuation remains ambiguous.',
      [from, to].filter((segment): segment is TableSegmentArtifact => segment != null),
      null,
      null,
    ));
  }
  const connected: TableSegmentArtifact[][] = [];
  for (const segment of segments) {
    const previous = connected.find((group) => group.some((member) =>
      continuationLinks.some((link) =>
        link.decision === 'linked'
        && ((link.from_segment_id === member.id && link.to_segment_id === segment.id)
          || (link.to_segment_id === member.id && link.from_segment_id === segment.id)))));
    if (previous) previous.push(segment);
    else connected.push([segment]);
  }
  const chains: TableChainArtifact[] = connected.map((members) => {
    const ids = nonEmpty(
      members.map(({ id }) => id),
      'Table chain requires segments.',
    );
    const links = continuationLinks.filter((link) =>
      ids.includes(link.from_segment_id) && ids.includes(link.to_segment_id));
    const ambiguous = continuationLinks.some((link) =>
      link.decision === 'ambiguous'
      && (ids.includes(link.from_segment_id) || ids.includes(link.to_segment_id)));
    const chainGaps = gaps.filter((item) =>
      item.upstream_artifact_ids.some((id) => ids.includes(id)));
    return {
      id: opaqueIds.fragmentArtifact({
        kind: 'table_chain',
        source_sha256: input.source_artifact.source_sha256,
        parser_manifest_hash: input.run.parser_manifest_hash,
        segment_ids: ids,
        links: links.map(({ id, decision }) => ({ id, decision })),
      }),
      organization_id: input.source_artifact.organization_id,
      extraction_run_id: input.run.id,
      source_artifact_id: input.source_artifact.id,
      source_document_id: input.source_artifact.source_document_id,
      source_sha256: input.source_artifact.source_sha256,
      parser_manifest_hash: input.run.parser_manifest_hash,
      parser: GENERIC_TABLE_PARSER,
      segment_ids: ids,
      continuation_links: links,
      section_ids: [],
      completeness: ambiguous ? 'ambiguous' : chainGaps.length ? 'partial' : 'complete',
      gap_ids: chainGaps.map(({ id }) => id),
    };
  });
  const chainBySegmentId = new Map(chains.flatMap((chain) =>
    chain.segment_ids.map((id) => [id, chain] as const)));
  const sections: TableSectionArtifact[] = (input.sections ?? []).flatMap((plan) => {
    const segment = segments[plan.region_index];
    const localRows = segmentRows[plan.region_index];
    const chain = segment && chainBySegmentId.get(segment.id);
    if (!segment || !localRows || !chain) return [];
    const members = plan.member_row_indexes.map((index) => localRows[index])
      .filter((row): row is LogicalTableRow => row != null);
    if (members.length === 0) return [];
    const childChainIds = (plan.child_region_indexes ?? []).flatMap((index) => {
      const child = segments[index];
      const childChain = child && chainBySegmentId.get(child.id);
      return childChain ? [childChain.id] : [];
    });
    const sectionId = opaqueIds.fragmentArtifact({
      kind: 'table_section',
      chain_id: chain.id,
      member_row_ids: members.map(({ id }) => id),
      child_table_chain_ids: childChainIds,
    });
    return [{
      id: sectionId,
      organization_id: input.source_artifact.organization_id,
      extraction_run_id: input.run.id,
      source_artifact_id: input.source_artifact.id,
      source_document_id: input.source_artifact.source_document_id,
      source_sha256: input.source_artifact.source_sha256,
      parser_manifest_hash: input.run.parser_manifest_hash,
      parser: GENERIC_TABLE_PARSER,
      table_chain_id: chain.id,
      header_row_id: plan.header_row_index == null
        ? null : localRows[plan.header_row_index]?.id ?? null,
      member_row_ids: nonEmpty(
        members.map(({ id }) => id),
        'Table section requires member rows.',
      ),
      child_table_chain_ids: childChainIds,
    }];
  });
  const sectionIdsByChain = new Map<string, string[]>();
  for (const section of sections) {
    sectionIdsByChain.set(section.table_chain_id, [
      ...(sectionIdsByChain.get(section.table_chain_id) ?? []),
      section.id,
    ]);
  }
  const completedChains = chains.map((chain) => ({
    ...chain,
    section_ids: sectionIdsByChain.get(chain.id) ?? [],
  }));
  return {
    cells,
    rows,
    segments,
    candidates,
    continuation_links: continuationLinks,
    chains: completedChains,
    sections,
    gaps,
    reconstruction_diagnostics: automatic.diagnostics,
  };
}

function similarity(left: number, right: number): number {
  return Math.max(0, 1 - Math.abs(left - right));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function columnBandSimilarity(
  from: TableSegmentArtifact,
  to: TableSegmentArtifact,
): number {
  const bands = Math.min(from.column_hypotheses.length, to.column_hypotheses.length);
  if (bands === 0) return 0;
  const pairs = from.column_hypotheses.flatMap((left) =>
    to.column_hypotheses.map((right) => ({
      left: left.index,
      right: right.index,
      score: (similarity(left.x0, right.x0) + similarity(left.x1, right.x1)) / 2,
    }))).sort((left, right) =>
    right.score - left.score || left.left - right.left || left.right - right.right);
  const usedLeft = new Set<number>();
  const usedRight = new Set<number>();
  const matched: number[] = [];
  for (const pair of pairs) {
    if (usedLeft.has(pair.left) || usedRight.has(pair.right)) continue;
    usedLeft.add(pair.left);
    usedRight.add(pair.right);
    matched.push(pair.score);
    if (matched.length === bands) break;
  }
  const cardinalityCoverage = bands
    / Math.max(from.column_hypotheses.length, to.column_hypotheses.length);
  return (matched.reduce((sum, value) => sum + value, 0) / bands)
    * cardinalityCoverage;
}

function rowCells(
  row: LogicalTableRow | undefined,
  cellsById: ReadonlyMap<string, GridCellArtifact>,
): readonly GridCellArtifact[] {
  return row?.cell_ids
    .map((id) => cellsById.get(id))
    .filter((cell): cell is GridCellArtifact => cell != null)
    .sort(compareCellsBySourceStructure) ?? [];
}

function occupiedSourceBands(
  cells: readonly GridCellArtifact[],
  source: TableSegmentArtifact,
): ReadonlySet<number> {
  return new Set(cells.flatMap((cell) =>
    source.column_hypotheses
      .filter((band) =>
        Math.min(cell.bounding_box.x1, band.x1)
          - Math.max(cell.bounding_box.x0, band.x0) > 0)
      .map(({ index }) => index)));
}

function baselineSpread(cells: readonly GridCellArtifact[]): number {
  if (cells.length < 2) return 0;
  const baselines = cells.map((cell) => cell.bounding_box.y1);
  return Math.max(...baselines) - Math.min(...baselines);
}

function normalizedHeaders(segment: TableSegmentArtifact): readonly string[] | null {
  const headers = segment.column_hypotheses.map((column) => column.header.normalized_label);
  return headers.every((header): header is string => header != null) ? headers : null;
}

function measureRowContinuation(
  from: TableSegmentArtifact,
  to: TableSegmentArtifact,
  rowsById: ReadonlyMap<string, LogicalTableRow>,
  cellsById: ReadonlyMap<string, GridCellArtifact>,
): {
  readonly score: number;
  readonly measurements: Readonly<Record<string, number | boolean | string | null>>;
} {
  const sourceRows = from.row_ids.map((id) => rowsById.get(id))
    .filter((row): row is LogicalTableRow => row != null);
  const destinationRows = to.row_ids.map((id) => rowsById.get(id))
    .filter((row): row is LogicalTableRow => row != null);
  const finalRow = sourceRows.at(-1);
  const firstRow = destinationRows[0];
  const finalCells = rowCells(finalRow, cellsById);
  const firstCells = rowCells(firstRow, cellsById);
  const finalOccupied = occupiedSourceBands(finalCells, from);
  const firstOccupied = occupiedSourceBands(firstCells, from);
  const bandCount = Math.max(1, from.column_hypotheses.length);
  const priorOccupancies = sourceRows.slice(0, -1)
    .filter((row) => row.row_kind !== 'header')
    .map((row) => occupiedSourceBands(rowCells(row, cellsById), from).size);
  const expectedOccupancy = Math.max(
    finalOccupied.size,
    priorOccupancies.length > 0 ? Math.max(...priorOccupancies) : bandCount,
  );
  const occupancyDeficit = clamp(
    (expectedOccupancy - finalOccupied.size) / Math.max(1, expectedOccupancy),
  );
  const sourceBottomProximity = finalRow
    ? clamp((finalRow.bounding_box.y1 - 0.75) / 0.25) : 0;
  const destinationTopProximity = firstRow
    ? clamp((0.25 - firstRow.bounding_box.y0) / 0.25) : 0;
  const finalRowIncomplete = occupancyDeficit > 0
    ? (1 + sourceBottomProximity) / 2 : 0;
  const destinationAlignment = firstCells.length === 0 ? 0
    : firstCells.filter((cell) => {
      const center = (cell.bounding_box.x0 + cell.bounding_box.x1) / 2;
      return from.column_hypotheses.some((band) =>
        center >= band.x0 - GENERIC_TABLE_POLICY_V6.column_center_tolerance
        && center <= band.x1 + GENERIC_TABLE_POLICY_V6.column_center_tolerance);
    }).length / firstCells.length;
  const missingBands = Array.from({ length: bandCount }, (_, index) => index)
    .filter((index) => !finalOccupied.has(index));
  const filledMissing = missingBands.filter((index) => firstOccupied.has(index)).length;
  const overlapping = [...firstOccupied].filter((index) => finalOccupied.has(index)).length;
  const occupancyContinuity = missingBands.length === 0 ? 0
    : (filledMissing / missingBands.length)
      * (1 - 0.5 * overlapping / Math.max(1, firstOccupied.size));
  const finalHeight = finalRow
    ? finalRow.bounding_box.y1 - finalRow.bounding_box.y0 : 0;
  const firstHeight = firstRow
    ? firstRow.bounding_box.y1 - firstRow.bounding_box.y0 : 0;
  const rowHeightCompatibility = Math.max(finalHeight, firstHeight) === 0 ? 0
    : clamp(1 - Math.abs(finalHeight - firstHeight) / Math.max(finalHeight, firstHeight));
  const firstDestinationCell = firstCells[0];
  const firstDestinationCenter = firstDestinationCell
    ? (firstDestinationCell.bounding_box.x0 + firstDestinationCell.bounding_box.x1) / 2
    : null;
  const destinationBand = firstDestinationCenter == null ? undefined
    : from.column_hypotheses.find((band) =>
      firstDestinationCenter >= band.x0 - GENERIC_TABLE_POLICY_V6.column_center_tolerance
      && firstDestinationCenter <= band.x1 + GENERIC_TABLE_POLICY_V6.column_center_tolerance);
  const indentationCompatibility = firstDestinationCell && destinationBand
    ? clamp(1 - Math.abs(firstDestinationCell.bounding_box.x0 - destinationBand.x0)
      / Math.max(GENERIC_TABLE_POLICY_V6.column_center_tolerance, 0.001))
    : 0;
  const baselineCompatibility = clamp(
    1 - Math.abs(baselineSpread(finalCells) - baselineSpread(firstCells))
      / Math.max(GENERIC_TABLE_POLICY_V6.row_center_tolerance, 0.001),
  );
  const repeatedHeader = firstRow?.row_kind === 'header';
  const weights = GENERIC_TABLE_POLICY_V6.row_continuation_component_weights;
  const compatibility = destinationAlignment * weights.destination_alignment
    + occupancyContinuity * weights.occupancy_continuity
    + rowHeightCompatibility * weights.row_height_compatibility
    + indentationCompatibility * weights.indentation_compatibility
    + baselineCompatibility * weights.baseline_compatibility;
  const score = repeatedHeader ? 0
    : finalRowIncomplete * destinationTopProximity * compatibility;
  return {
    score,
    measurements: {
      final_row_incomplete: finalRowIncomplete,
      source_bottom_proximity: sourceBottomProximity,
      destination_top_proximity: destinationTopProximity,
      destination_column_alignment: destinationAlignment,
      occupancy_continuity: occupancyContinuity,
      row_height_compatibility: rowHeightCompatibility,
      indentation_compatibility: indentationCompatibility,
      baseline_compatibility: baselineCompatibility,
      repeated_header_present: repeatedHeader,
      source_populated_band_count: finalOccupied.size,
      destination_populated_band_count: firstOccupied.size,
      expected_source_band_count: expectedOccupancy,
    },
  };
}

function buildContinuationLinks(
  segments: readonly TableSegmentArtifact[],
  rows: readonly LogicalTableRow[],
  cells: readonly GridCellArtifact[],
): readonly TableContinuationLink[] {
  const ordered = [...segments].sort(compareSegmentsBySourceStructure);
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
  const links: TableContinuationLink[] = [];
  for (const from of ordered) {
    const plausible = ordered
      .filter((to) =>
        to.page > from.page
        && to.page - from.page <= GENERIC_TABLE_POLICY_V6
          .continuation_search_max_page_distance)
      .map((to) => ({ to, plausibility: columnBandSimilarity(from, to) }))
      .filter(({ plausibility }) =>
        plausibility >= GENERIC_TABLE_POLICY_V6.continuation_plausibility_minimum);
    const nearestPage = plausible.reduce<number | null>(
      (nearest, { to }) => nearest == null ? to.page : Math.min(nearest, to.page),
      null,
    );
    if (nearestPage == null) continue;
    const candidates = plausible.filter(({ to }) => to.page === nearestPage)
      .sort((left, right) =>
        right.plausibility - left.plausibility
        || left.to.reading_order - right.to.reading_order
        || compareSegmentsBySourceStructure(left.to, right.to))
      .slice(0, GENERIC_TABLE_POLICY_V6.continuation_max_candidates_per_segment);
    for (const { to, plausibility: columnScore } of candidates) {
    const basisIds: NonEmpty<TableSegmentArtifact['id']> = [from.id, to.id];
    const fromHeaders = normalizedHeaders(from);
    const toHeaders = normalizedHeaders(to);
    const headerScore = fromHeaders && toHeaders
      ? Number(fromHeaders.length === toHeaders.length
        && fromHeaders.every((header, index) => header === toHeaders[index]))
      : null;
    const edgeScore = (from.bounding_box.y1 + (1 - to.bounding_box.y0)) / 2;
    const fromRowId = from.row_ids.at(-1);
    const toRowId = to.row_ids[0];
    const fromRow = fromRowId ? rowsById.get(fromRowId) : undefined;
    const toRow = toRowId ? rowsById.get(toRowId) : undefined;
    const fromHeight = fromRow
      ? fromRow.bounding_box.y1 - fromRow.bounding_box.y0 : 0;
    const toHeight = toRow ? toRow.bounding_box.y1 - toRow.bounding_box.y0 : 0;
    const typographyScore = Math.max(fromHeight, toHeight) === 0 ? 0
      : clamp(1 - Math.abs(fromHeight - toHeight) / Math.max(fromHeight, toHeight));
    const rowContinuation = measureRowContinuation(from, to, rowsById, cellsById);
    const skippedPages = to.page - from.page - 1;
    const pageDistancePenalty = clamp(
      1 - skippedPages * GENERIC_TABLE_POLICY_V6.page_distance_penalty_per_skipped_page,
    );
    const structuralMode = Math.max(headerScore ?? 0, rowContinuation.score);
    const weights = GENERIC_TABLE_POLICY_V6.continuation_component_weights;
    const scoreValue = columnScore * weights.column_bands
      + structuralMode * weights.structural_mode
      + edgeScore * weights.edge_proximity
      + typographyScore * weights.typography
      + pageDistancePenalty * weights.page_distance;
    const measured = (
      value: number,
      diagnostic: string,
      measurements?: Readonly<Record<string, number | boolean | string | null>>,
    ) => ({
      value,
      calculator: GENERIC_TABLE_PARSER,
      basis_artifact_ids: basisIds,
      diagnostics: [diagnostic],
      ...(measurements ? { measurements } : {}),
    });
    const decision: TableContinuationLink['decision'] =
      scoreValue >= GENERIC_TABLE_POLICY_V6.continuation_link_minimum ? 'linked'
        : scoreValue >= GENERIC_TABLE_POLICY_V6.continuation_ambiguity_minimum
          ? 'ambiguous' : 'rejected';
    links.push({
      id: opaqueIds.fragmentArtifact({
        kind: 'table_continuation_link',
        from_segment_id: from.id,
        to_segment_id: to.id,
        score: scoreValue,
        decision,
        parser: GENERIC_TABLE_PARSER,
      }),
      organization_id: from.organization_id,
      extraction_run_id: from.extraction_run_id,
      source_artifact_id: from.source_artifact_id,
      source_document_id: from.source_document_id,
      source_sha256: from.source_sha256,
      parser_manifest_hash: from.parser_manifest_hash,
      parser: GENERIC_TABLE_PARSER,
      from_segment_id: from.id,
      to_segment_id: to.id,
      basis: {
        column_band_similarity: measured(columnScore, 'Column-band similarity.'),
        header_similarity: headerScore == null
          ? null : measured(headerScore, 'Exact observed-header similarity.'),
        edge_proximity: measured(edgeScore, 'Bottom/top page-edge proximity.'),
        typography_similarity: measured(
          typographyScore,
          'Boundary-row height compatibility.',
          { source_row_height: fromHeight, destination_row_height: toHeight },
        ),
        row_continuation_score: measured(
          rowContinuation.score,
          'Versioned incomplete-row, alignment, occupancy, height, indentation, baseline, and repeated-header evidence.',
          rowContinuation.measurements,
        ),
        page_distance_penalty: measured(
          pageDistancePenalty,
          'Versioned penalty for intervening pages.',
          { page_distance: to.page - from.page, skipped_page_count: skippedPages },
        ),
      },
      score: measured(scoreValue, 'Versioned weighted continuation composite.', {
        structural_mode_score: structuralMode,
      }),
      decision,
    });
    }
  }
  const segmentById = new Map(ordered.map((segment) => [segment.id, segment]));
  let normalized = [...links];
  const resolveCompetingLinks = (
    key: 'from_segment_id' | 'to_segment_id',
  ): void => {
    const keys = [...new Set(normalized.map((link) => link[key]))].sort(
      (left, right) => {
        const leftSegment = segmentById.get(left);
        const rightSegment = segmentById.get(right);
        if (!leftSegment || !rightSegment) return 0;
        return compareSegmentsBySourceStructure(leftSegment, rightSegment);
      },
    );
    for (const id of keys) {
      const linked = normalized.filter((link) =>
        link[key] === id && link.decision === 'linked')
        .sort((left, right) => {
          const leftTo = segmentById.get(left.to_segment_id);
          const rightTo = segmentById.get(right.to_segment_id);
          return right.score.value - left.score.value
            || (leftTo?.page ?? 0) - (rightTo?.page ?? 0)
            || (leftTo?.reading_order ?? 0) - (rightTo?.reading_order ?? 0)
            || (
              leftTo && rightTo
                ? compareSegmentsBySourceStructure(leftTo, rightTo)
                : 0
            );
        });
      if (linked.length < 2) continue;
      const unresolvedTie = linked[0].score.value - linked[1].score.value
        <= GENERIC_TABLE_POLICY_V6.continuation_near_tie_tolerance;
      const keepId = unresolvedTie ? null : linked[0].id;
      const competingIds = new Set(linked.map(({ id: linkId }) => linkId));
      const scoreMargin = linked[0].score.value - linked[1].score.value;
      const axis = key === 'from_segment_id' ? 'outgoing' : 'incoming';
      const competingPairs = linked
        .map((link) => `${link.from_segment_id}->${link.to_segment_id}`)
        .sort((left, right) => {
          const leftLink = linked.find((link) =>
            `${link.from_segment_id}->${link.to_segment_id}` === left);
          const rightLink = linked.find((link) =>
            `${link.from_segment_id}->${link.to_segment_id}` === right);
          if (!leftLink || !rightLink) return 0;
          const leftFrom = segmentById.get(leftLink.from_segment_id);
          const rightFrom = segmentById.get(rightLink.from_segment_id);
          const leftTo = segmentById.get(leftLink.to_segment_id);
          const rightTo = segmentById.get(rightLink.to_segment_id);
          return (
            leftFrom && rightFrom
              ? compareSegmentsBySourceStructure(leftFrom, rightFrom)
              : 0
          ) || (
            leftTo && rightTo
              ? compareSegmentsBySourceStructure(leftTo, rightTo)
              : 0
          );
        });
      const retainedPair = keepId == null ? null : linked
        .find(({ id: linkId }) => linkId === keepId);
      const competitionReason = unresolvedTie
        ? `competing ${axis} candidates are within the V2 near-tie tolerance`
        : `a stronger competing ${axis} candidate was retained`;
      const competitionBasisIds = nonEmpty(
        [...new Set(linked.flatMap((link) =>
          [link.from_segment_id, link.to_segment_id]))].sort((left, right) => {
          const leftSegment = segmentById.get(left);
          const rightSegment = segmentById.get(right);
          if (!leftSegment || !rightSegment) return 0;
          return compareSegmentsBySourceStructure(leftSegment, rightSegment);
        }),
        'Competing continuation evidence requires segments.',
      );
      normalized = normalized.map((link) => {
        if (!competingIds.has(link.id) || link.id === keepId) return link;
        return {
          ...link,
          score: {
            ...link.score,
            basis_artifact_ids: competitionBasisIds,
            diagnostics: [
              ...link.score.diagnostics,
              `Competing ${axis} continuation policy applied.`,
            ],
            measurements: {
              ...link.score.measurements,
              competition_axis: axis,
              competing_candidate_count: linked.length,
              competing_candidate_pairs: competingPairs.join(','),
              competing_best_score: linked[0].score.value,
              competing_second_score: linked[1].score.value,
              competing_score_margin: scoreMargin,
              competition_near_tie_tolerance:
                GENERIC_TABLE_POLICY_V6.continuation_near_tie_tolerance,
              competition_resolution: unresolvedTie
                ? 'all_ambiguous_near_tie' : 'lower_rank_ambiguous',
              competition_retained_pair: retainedPair == null ? null
                : `${retainedPair.from_segment_id}->${retainedPair.to_segment_id}`,
              competition_reason: competitionReason,
            },
          },
          decision: 'ambiguous' as const,
        };
      });
    }
  };
  resolveCompetingLinks('from_segment_id');
  resolveCompetingLinks('to_segment_id');
  return normalized.map((link) => {
    const id = opaqueIds.fragmentArtifact({
      kind: 'table_continuation_link',
      from_segment_id: link.from_segment_id,
      to_segment_id: link.to_segment_id,
      score: link.score.value,
      decision: link.decision,
      parser: GENERIC_TABLE_PARSER,
    });
    return id === link.id ? link : { ...link, id };
  });
}
