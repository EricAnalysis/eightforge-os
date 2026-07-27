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

export const GENERIC_TABLE_POLICY_V1 = Object.freeze({
  name: 'generic-geometric-table-reconstruction',
  version: 'v1',
  row_center_tolerance: 0.018,
  multiline_vertical_gap_maximum: 0.035,
  column_center_tolerance: 0.04,
  whitespace_gutter_minimum: 0.025,
  continuation_link_minimum: 0.75,
  continuation_ambiguity_minimum: 0.55,
});

export const GENERIC_TABLE_PARSER: ParserIdentity = Object.freeze({
  stage: 'table_reconstruction',
  name: GENERIC_TABLE_POLICY_V1.name,
  version: GENERIC_TABLE_POLICY_V1.version,
  configuration_hash: hashCanonical(GENERIC_TABLE_POLICY_V1),
});

export interface ObservedCellPlan {
  readonly token_ids: NonEmpty<SourceFragmentArtifact['id']>;
  readonly structure?: GridCellArtifact['structure'];
  readonly row_span?: number;
  readonly column_span?: number;
  readonly border_evidence?: GridCellArtifact['border_evidence'];
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
    const center = (fragment.bounding_box.y0 + fragment.bounding_box.y1) / 2;
    const line = lines.find((members) => {
      const first = members[0];
      const existingCenter = (first.bounding_box.y0 + first.bounding_box.y1) / 2;
      return Math.abs(center - existingCenter) <= GENERIC_TABLE_POLICY_V1.row_center_tolerance;
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
    offset += line.length;
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
      const center = (token.bounding_box.y0 + token.bounding_box.y1) / 2;
      const row = rows.find((members) => {
        const first = members[0];
        return Math.abs(center - (first.bounding_box.y0 + first.bounding_box.y1) / 2)
          <= GENERIC_TABLE_POLICY_V1.row_center_tolerance;
      });
      if (row) row.push(token);
      else rows.push([token]);
    }
    const qualifying = rows.filter((row) => {
      const sorted = [...row].sort((a, b) => a.bounding_box.x0 - b.bounding_box.x0);
      return sorted.length > 1 && sorted.some((token, index) => {
        const next = sorted[index + 1];
        return next
          ? next.bounding_box.x0 - token.bounding_box.x1
            >= GENERIC_TABLE_POLICY_V1.whitespace_gutter_minimum
          : false;
      });
    });
    if (qualifying.length === 0) return [];
    const firstKinds = qualifying[0]?.map((token) => valueKind(token.raw_text)) ?? [];
    const laterKinds = qualifying.slice(1)
      .flatMap((row) => row.map((token) => valueKind(token.raw_text)));
    const firstIsObservedHeader = qualifying.length > 1
      && firstKinds.every((kind) =>
        ['free_text', 'identifier', 'unit_token', 'unknown'].includes(kind))
      && laterKinds.some((kind) =>
        ['integer', 'decimal', 'currency', 'date_like', 'boolean_like'].includes(kind));
    return [{
      page_artifact_id: page.id,
      rows: nonEmpty(qualifying.map((row, rowIndex) => ({
        cells: nonEmpty([...row]
          .sort((a, b) => a.bounding_box.x0 - b.bounding_box.x0)
          .map((token) => ({ token_ids: [token.id] as NonEmpty<typeof token.id> })),
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
      for (const [columnIndex, cellPlan] of rowPlan.cells.entries()) {
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
          artifact_data: { table_value_kind: valueKind(content.text) },
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
        const kind = observedKinds.every((candidate) => candidate === observedKinds[0])
          ? observedKinds[0] ?? 'unknown'
          : 'unknown';
        const basis = nonEmpty(
          measuredCells.map(({ id }) => id),
          'Column hypothesis requires cells.',
        );
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
          value_kind_hypotheses: [{
            kind,
            measurement: {
              value: 1,
              calculator: GENERIC_TABLE_PARSER,
              basis_artifact_ids: basis,
              diagnostics: ['Primitive value-kind hypothesis from observed cell text.'],
            },
          }],
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

  const continuationLinks = buildContinuationLinks(segments);
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

function buildContinuationLinks(
  segments: readonly TableSegmentArtifact[],
): readonly TableContinuationLink[] {
  const ordered = [...segments].sort((left, right) =>
    left.page - right.page || left.reading_order - right.reading_order);
  const links: TableContinuationLink[] = [];
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const from = ordered[index];
    const to = ordered[index + 1];
    if (to.page !== from.page + 1) continue;
    const basisIds: NonEmpty<TableSegmentArtifact['id']> = [from.id, to.id];
    const bands = Math.min(from.column_hypotheses.length, to.column_hypotheses.length);
    const columnScore = bands === 0 ? 0 : Array.from({ length: bands }, (_, band) =>
      (similarity(from.column_hypotheses[band].x0, to.column_hypotheses[band].x0)
       + similarity(from.column_hypotheses[band].x1, to.column_hypotheses[band].x1)) / 2)
      .reduce((sum, value) => sum + value, 0) / bands;
    const fromHeader = from.raw_text.split('\n')[0]?.trim().toLowerCase() ?? '';
    const toHeader = to.raw_text.split('\n')[0]?.trim().toLowerCase() ?? '';
    const headerScore = fromHeader && toHeader && fromHeader === toHeader ? 1 : 0;
    const edgeScore = (from.bounding_box.y1 + (1 - to.bounding_box.y0)) / 2;
    const fromHeight = (from.bounding_box.y1 - from.bounding_box.y0)
      / Math.max(1, from.row_ids.length);
    const toHeight = (to.bounding_box.y1 - to.bounding_box.y0)
      / Math.max(1, to.row_ids.length);
    const typographyScore = Math.max(0, 1 - Math.abs(fromHeight - toHeight) * 10);
    const rowContinuationScore = to.raw_text.length > 0 ? 0.5 : 0;
    const scoreValue = (
      columnScore + headerScore + edgeScore + typographyScore + rowContinuationScore
    ) / 5;
    const measured = (value: number, diagnostic: string) => ({
      value,
      calculator: GENERIC_TABLE_PARSER,
      basis_artifact_ids: basisIds,
      diagnostics: [diagnostic],
    });
    const decision: TableContinuationLink['decision'] =
      scoreValue >= GENERIC_TABLE_POLICY_V1.continuation_link_minimum ? 'linked'
        : scoreValue >= GENERIC_TABLE_POLICY_V1.continuation_ambiguity_minimum
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
        header_similarity: measured(headerScore, 'Observed-header similarity.'),
        edge_proximity: measured(edgeScore, 'Bottom/top page-edge proximity.'),
        typography_similarity: measured(typographyScore, 'Observed row-height similarity.'),
        row_continuation_score: measured(
          rowContinuationScore,
          'Geometric row-continuation evidence.',
        ),
      },
      score: measured(scoreValue, 'Versioned continuation composite.'),
      decision,
    });
  }
  return links;
}
