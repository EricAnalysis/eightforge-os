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

export const GENERIC_TABLE_POLICY_V3 = Object.freeze({
  name: 'generic-geometric-table-reconstruction',
  version: 'v3',
  row_center_tolerance: 0.018,
  column_center_tolerance: 0.04,
  fragment_coalescing: {
    version: 'same-line-structural-gutter-v1',
    maximum_inline_gap: 0.025,
    currency_pair_maximum_inline_gap: 0.05,
    minimum_vertical_overlap_ratio: 0.5,
  },
  column_inference: {
    version: 'modal-row-x0-median-unique-assignment-v2',
    anchor_tolerance: 0.04,
  },
  logical_row_assembly: {
    version: 'preceding-primary-contained-band-v2',
    maximum_continuation_center_distance: 0.035,
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

export const GENERIC_TABLE_PARSER: ParserIdentity = Object.freeze({
  stage: 'table_reconstruction',
  name: GENERIC_TABLE_POLICY_V3.name,
  version: GENERIC_TABLE_POLICY_V3.version,
  configuration_hash: hashCanonical(GENERIC_TABLE_POLICY_V3),
});

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
      || left.reading_order - right.reading_order || left.id.localeCompare(right.id);
  }), 'Ordered cell content requires at least one source fragment.');
  const lines: SourceFragmentArtifact[][] = [];
  for (const fragment of ordered) {
    const line = lines.find((members) => {
      return members.some((member) =>
        verticalOverlapRatio(fragment, member)
          >= GENERIC_TABLE_POLICY_V3.fragment_coalescing.minimum_vertical_overlap_ratio);
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

function groupInlineCellFragments(
  fragments: NonEmpty<SourceFragmentArtifact>,
): NonEmpty<NonEmpty<SourceFragmentArtifact>> {
  const sorted = nonEmpty(
    [...fragments].sort((left, right) =>
      left.bounding_box.x0 - right.bounding_box.x0
      || left.reading_order - right.reading_order
      || left.id.localeCompare(right.id)),
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
    const observedCurrencyPair = /^[\$€£¥]$/.test(previousText)
      && /^[+-]?(?:\d+(?:,\d{3})*|\d*)\.\d+$/.test(currentText)
      && inlineGap
        <= GENERIC_TABLE_POLICY_V3.fragment_coalescing.currency_pair_maximum_inline_gap;
    if (
      current
      && (
        inlineGap < GENERIC_TABLE_POLICY_V3.fragment_coalescing.maximum_inline_gap
        || observedCurrencyPair
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
    || first.length < GENERIC_TABLE_POLICY_V3.header_detection.minimum_columns
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
  return contrasts >= GENERIC_TABLE_POLICY_V3.header_detection.minimum_kind_contrasts;
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

function cellBandAt(
  cells: readonly (readonly SourceFragmentArtifact[])[],
  columnIndex: number,
): { readonly x0: number; readonly x1: number } {
  const extents = cells.map((cell) => ({
    x0: Math.min(...cell.map(({ bounding_box }) => bounding_box.x0)),
    x1: Math.max(...cell.map(({ bounding_box }) => bounding_box.x1)),
  }));
  const current = extents[columnIndex]!;
  const previous = extents[columnIndex - 1];
  const next = extents[columnIndex + 1];
  return {
    x0: previous ? (previous.x1 + current.x0) / 2 : current.x0,
    x1: next ? (current.x1 + next.x0) / 2 : current.x1,
  };
}

function attachSparseContinuationRows(
  physicalRows: readonly NonEmpty<SourceFragmentArtifact>[],
  groupedRows: readonly NonEmpty<NonEmpty<SourceFragmentArtifact>>[],
): readonly NonEmpty<NonEmpty<SourceFragmentArtifact>>[] {
  const primaryIndexes = groupedRows.flatMap((row, index) =>
    row.length > 1 ? [index] : []);
  const primary = new Map<number, SourceFragmentArtifact[][]>(
    primaryIndexes.map((index) => [index, groupedRows[index]!.map((cell) => [...cell])]),
  );
  for (const [rowIndex, sparse] of groupedRows.entries()) {
    if (sparse.length !== 1 || primary.has(rowIndex)) continue;
    if (
      rowIndex < (primaryIndexes[0] ?? Number.POSITIVE_INFINITY)
      || rowIndex > (primaryIndexes.at(-1) ?? Number.NEGATIVE_INFINITY)
    ) {
      continue;
    }
    const fragments = sparse[0];
    const centerX = (
      Math.min(...fragments.map(({ bounding_box }) => bounding_box.x0))
      + Math.max(...fragments.map(({ bounding_box }) => bounding_box.x1))
    ) / 2;
    const sparseX0 = Math.min(
      ...fragments.map(({ bounding_box }) => bounding_box.x0),
    );
    const sparseX1 = Math.max(
      ...fragments.map(({ bounding_box }) => bounding_box.x1),
    );
    const candidates = primaryIndexes
      .filter((primaryIndex) => primaryIndex < rowIndex)
      .flatMap((primaryIndex) => {
      const primaryRow = primary.get(primaryIndex);
      const primaryFragments = physicalRows[primaryIndex];
      const sparseFragments = physicalRows[rowIndex];
      if (!primaryRow || !primaryFragments || !sparseFragments) return [];
      const verticalDistance = Math.abs(
        rowCenter(sparseFragments) - rowCenter(primaryFragments),
      );
      if (
        verticalDistance
          > GENERIC_TABLE_POLICY_V3.logical_row_assembly
            .maximum_continuation_center_distance
      ) {
        return [];
      }
      const columnIndex = primaryRow.findIndex((_, index) => {
        const band = cellBandAt(primaryRow, index);
        return centerX >= band.x0 - GENERIC_TABLE_POLICY_V3.column_center_tolerance
          && centerX <= band.x1 + GENERIC_TABLE_POLICY_V3.column_center_tolerance
          && sparseX0 >= band.x0 - GENERIC_TABLE_POLICY_V3.column_center_tolerance
          && sparseX1 <= band.x1 + GENERIC_TABLE_POLICY_V3.column_center_tolerance;
      });
      return columnIndex < 0 ? [] : [{ primaryIndex, columnIndex, verticalDistance }];
    }).sort((left, right) =>
      left.verticalDistance - right.verticalDistance
      || right.primaryIndex - left.primaryIndex
      || left.columnIndex - right.columnIndex);
    const selected = candidates[0];
    if (!selected) continue;
    primary.get(selected.primaryIndex)?.[selected.columnIndex]?.push(...fragments);
  }
  return primaryIndexes.map((index) =>
    nonEmpty(
      primary.get(index)!.map((cell) =>
        nonEmpty(cell, 'Attached logical cell requires source fragments.')),
      'Attached logical row requires cells.',
    ));
}

function assignStableColumnIndexes(
  rows: readonly NonEmpty<NonEmpty<SourceFragmentArtifact>>[],
): readonly NonEmpty<{
  readonly fragments: NonEmpty<SourceFragmentArtifact>;
  readonly columnIndex: number;
}>[] {
  const locallyMergedRows = rows;
  const rowLengthCounts = new Map<number, number>();
  for (const row of locallyMergedRows) {
    rowLengthCounts.set(row.length, (rowLengthCounts.get(row.length) ?? 0) + 1);
  }
  const modalColumnCount = [...rowLengthCounts.entries()]
    .sort((left, right) => right[1] - left[1] || right[0] - left[0])[0]?.[0] ?? 1;
  const referenceRows = locallyMergedRows.filter((row) => row.length === modalColumnCount);
  const anchors = Array.from({ length: modalColumnCount }, (_, columnIndex) => {
    const positions = referenceRows
      .map((row) => row[columnIndex])
      .filter((cell): cell is NonEmpty<SourceFragmentArtifact> => cell != null)
      .map((cell) => Math.min(...cell.map(({ bounding_box }) => bounding_box.x0)))
      .sort((left, right) => left - right);
    return positions[Math.floor(positions.length / 2)] ?? 0;
  });
  return locallyMergedRows.map((row) => {
    const assignedColumns = new Set<number>();
    const assignedCells: {
      readonly columnIndex: number;
      readonly fragments: NonEmpty<SourceFragmentArtifact>;
    }[] = [];
    for (const cell of row) {
      const x0 = Math.min(...cell.map(({ bounding_box }) => bounding_box.x0));
      const availableAnchors = anchors.map((anchor, index) => ({
          index,
          distance: Math.abs(anchor - x0),
        }))
        .filter(({ index }) => !assignedColumns.has(index))
        .sort((left, right) =>
          left.distance - right.distance || left.index - right.index);
      const columnIndex = availableAnchors[0]?.index
        ?? anchors.length + assignedCells.length;
      assignedColumns.add(columnIndex);
      assignedCells.push({ columnIndex, fragments: cell });
    }
    return nonEmpty(
      assignedCells.sort((left, right) => left.columnIndex - right.columnIndex),
      'Stable column assignment requires cells.',
    );
  });
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
        >= GENERIC_TABLE_POLICY_V3.fragment_coalescing.minimum_vertical_overlap_ratio));
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
    /^[\$€£¥]$/u.test(fragment.raw_text.trim()));
  const hasNumericValue = fragments.some((fragment) =>
    /^[-+]?\d[\d,.]*$/u.test(fragment.raw_text.trim()));

  if (hasCurrencyMarker && hasNumericValue) {
    return {
      reason: 'currency_marker_numeric_pair',
      confidence: Number(Math.max(
        0,
        1 - maximumObservedInlineGap
          / GENERIC_TABLE_POLICY_V3.fragment_coalescing
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
          / GENERIC_TABLE_POLICY_V3.logical_row_assembly
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
          / GENERIC_TABLE_POLICY_V3.fragment_coalescing.maximum_inline_gap,
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
  pages: readonly PageArtifact[],
  fragments: readonly SourceFragmentArtifact[],
): readonly ObservedTableRegion[] {
  return pages.flatMap((page): ObservedTableRegion[] => {
    const tokens = fragments.filter((fragment) =>
      fragment.kind === 'token' && fragment.page_artifact_id === page.id);
    const rows: SourceFragmentArtifact[][] = [];
    for (const token of [...tokens].sort((a, b) =>
      a.bounding_box.y0 - b.bounding_box.y0 || a.bounding_box.x0 - b.bounding_box.x0)) {
      const row = rows.find((members) => {
        return members.some((member) =>
          verticalOverlapRatio(token, member)
            >= GENERIC_TABLE_POLICY_V3.fragment_coalescing.minimum_vertical_overlap_ratio);
      });
      if (row) row.push(token);
      else rows.push([token]);
    }
    const physicalRows = rows.map((row) =>
      nonEmpty(row, 'Detected row requires source fragments.'));
    const groupedRows = physicalRows.map(groupInlineCellFragments);
    const qualifying = attachSparseContinuationRows(physicalRows, groupedRows);
    if (qualifying.length === 0) return [];
    const firstIsObservedHeader = firstRowHasStructuralHeaderContrast(qualifying);
    const indexedRows = assignStableColumnIndexes(qualifying);
    return [{
      page_artifact_id: page.id,
      rows: nonEmpty(indexedRows.map((row, rowIndex) => ({
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
    }];
  });
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
  const regions = input.regions ?? autoRegions(input.pages, input.fragments);
  const cells: GridCellArtifact[] = [];
  const rows: LogicalTableRow[] = [];
  const segments: TableSegmentArtifact[] = [];
  const candidates: FieldCandidate[] = [];
  const gaps: ProcessingGap[] = [];
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
              policy: GENERIC_TABLE_POLICY_V3.fragment_coalescing,
              reason: cellPlan.coalescing_evidence?.reason
                ?? 'explicit_observed_cell_plan',
              confidence: cellPlan.coalescing_evidence?.confidence ?? 1,
              maximum_observed_inline_gap:
                cellPlan.coalescing_evidence?.maximum_observed_inline_gap ?? null,
              basis_fragment_ids: content.ordered.map(({ id }) => id),
            },
            reconstruction_policy: {
              name: GENERIC_TABLE_POLICY_V3.name,
              version: GENERIC_TABLE_POLICY_V3.version,
              row_center_tolerance: GENERIC_TABLE_POLICY_V3.row_center_tolerance,
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
    .sort((left, right) =>
      left.column_start - right.column_start || left.id.localeCompare(right.id)) ?? [];
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
        center >= band.x0 - GENERIC_TABLE_POLICY_V3.column_center_tolerance
        && center <= band.x1 + GENERIC_TABLE_POLICY_V3.column_center_tolerance);
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
      firstDestinationCenter >= band.x0 - GENERIC_TABLE_POLICY_V3.column_center_tolerance
      && firstDestinationCenter <= band.x1 + GENERIC_TABLE_POLICY_V3.column_center_tolerance);
  const indentationCompatibility = firstDestinationCell && destinationBand
    ? clamp(1 - Math.abs(firstDestinationCell.bounding_box.x0 - destinationBand.x0)
      / Math.max(GENERIC_TABLE_POLICY_V3.column_center_tolerance, 0.001))
    : 0;
  const baselineCompatibility = clamp(
    1 - Math.abs(baselineSpread(finalCells) - baselineSpread(firstCells))
      / Math.max(GENERIC_TABLE_POLICY_V3.row_center_tolerance, 0.001),
  );
  const repeatedHeader = firstRow?.row_kind === 'header';
  const weights = GENERIC_TABLE_POLICY_V3.row_continuation_component_weights;
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
  const ordered = [...segments].sort((left, right) =>
    left.page - right.page || left.reading_order - right.reading_order
      || left.id.localeCompare(right.id));
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const cellsById = new Map(cells.map((cell) => [cell.id, cell]));
  const links: TableContinuationLink[] = [];
  for (const from of ordered) {
    const plausible = ordered
      .filter((to) =>
        to.page > from.page
        && to.page - from.page <= GENERIC_TABLE_POLICY_V3
          .continuation_search_max_page_distance)
      .map((to) => ({ to, plausibility: columnBandSimilarity(from, to) }))
      .filter(({ plausibility }) =>
        plausibility >= GENERIC_TABLE_POLICY_V3.continuation_plausibility_minimum);
    const nearestPage = plausible.reduce<number | null>(
      (nearest, { to }) => nearest == null ? to.page : Math.min(nearest, to.page),
      null,
    );
    if (nearestPage == null) continue;
    const candidates = plausible.filter(({ to }) => to.page === nearestPage)
      .sort((left, right) =>
        right.plausibility - left.plausibility
        || left.to.reading_order - right.to.reading_order
        || left.to.id.localeCompare(right.to.id))
      .slice(0, GENERIC_TABLE_POLICY_V3.continuation_max_candidates_per_segment);
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
      1 - skippedPages * GENERIC_TABLE_POLICY_V3.page_distance_penalty_per_skipped_page,
    );
    const structuralMode = Math.max(headerScore ?? 0, rowContinuation.score);
    const weights = GENERIC_TABLE_POLICY_V3.continuation_component_weights;
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
      scoreValue >= GENERIC_TABLE_POLICY_V3.continuation_link_minimum ? 'linked'
        : scoreValue >= GENERIC_TABLE_POLICY_V3.continuation_ambiguity_minimum
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
    const keys = [...new Set(normalized.map((link) => link[key]))].sort();
    for (const id of keys) {
      const linked = normalized.filter((link) =>
        link[key] === id && link.decision === 'linked')
        .sort((left, right) => {
          const leftTo = segmentById.get(left.to_segment_id);
          const rightTo = segmentById.get(right.to_segment_id);
          return right.score.value - left.score.value
            || (leftTo?.page ?? 0) - (rightTo?.page ?? 0)
            || (leftTo?.reading_order ?? 0) - (rightTo?.reading_order ?? 0)
            || left.to_segment_id.localeCompare(right.to_segment_id);
        });
      if (linked.length < 2) continue;
      const unresolvedTie = linked[0].score.value - linked[1].score.value
        <= GENERIC_TABLE_POLICY_V3.continuation_near_tie_tolerance;
      const keepId = unresolvedTie ? null : linked[0].id;
      const competingIds = new Set(linked.map(({ id: linkId }) => linkId));
      const scoreMargin = linked[0].score.value - linked[1].score.value;
      const axis = key === 'from_segment_id' ? 'outgoing' : 'incoming';
      const competingPairs = linked
        .map((link) => `${link.from_segment_id}->${link.to_segment_id}`)
        .sort();
      const retainedPair = keepId == null ? null : linked
        .find(({ id: linkId }) => linkId === keepId);
      const competitionReason = unresolvedTie
        ? `competing ${axis} candidates are within the V2 near-tie tolerance`
        : `a stronger competing ${axis} candidate was retained`;
      const competitionBasisIds = nonEmpty(
        [...new Set(linked.flatMap((link) =>
          [link.from_segment_id, link.to_segment_id]))].sort(),
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
                GENERIC_TABLE_POLICY_V3.continuation_near_tie_tolerance,
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
