export type GeometrySourceType =
  | 'pdfjs'
  | 'ocr_fallback'
  | 'vision'
  | 'unstructured'
  | string;

export type GeometryTextBox = {
  page_number: number | null;
  x_min?: number | null;
  x_max?: number | null;
  y_min?: number | null;
  y_max?: number | null;
  width?: number | null;
  height?: number | null;
};

export type GeometryProvenance = {
  source_type?: GeometrySourceType | null;
  source_document_id?: string | null;
  table_id?: string | null;
  row_id?: string | null;
  row_index?: number | null;
  cell_index?: number | null;
  anchor_id?: string | null;
  diagnostics?: string[];
};

export type TableCellGeometry = GeometryTextBox & GeometryProvenance & {
  text?: string;
};

export type GeometryCellRef = {
  text: string;
  geometry: TableCellGeometry;
};

export type ReconstructedTableRowCandidate = {
  page_number: number | null;
  row_index?: number | null;
  cells: GeometryCellRef[];
  confidence: number;
  diagnostics: string[];
};

export type SamePageRowCandidateResult = {
  candidate: boolean;
  confidence: number;
  diagnostics: string[];
};

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function uniqueDiagnostics(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

export function hasHorizontalGeometry(geometry: Pick<TableCellGeometry, 'x_min' | 'x_max'>): boolean {
  return finiteNumber(geometry.x_min) != null && finiteNumber(geometry.x_max) != null;
}

export function hasVerticalGeometry(geometry: Pick<TableCellGeometry, 'y_min' | 'y_max'>): boolean {
  return finiteNumber(geometry.y_min) != null && finiteNumber(geometry.y_max) != null;
}

export function geometryDiagnostics(geometry: TableCellGeometry): string[] {
  return uniqueDiagnostics([
    hasHorizontalGeometry(geometry) ? null : 'missing_x_bounds',
    hasVerticalGeometry(geometry) ? null : 'missing_y_bounds',
    hasHorizontalGeometry(geometry) && hasVerticalGeometry(geometry)
      ? null
      : 'insufficient_geometry_for_same_cell',
    ...(geometry.diagnostics ?? []),
  ]);
}

export function buildTableCellGeometry(params: {
  page_number: number | null;
  text?: string | null;
  x_min?: number | null;
  x_max?: number | null;
  y_min?: number | null;
  y_max?: number | null;
  source_type?: GeometrySourceType | null;
  source_document_id?: string | null;
  table_id?: string | null;
  row_id?: string | null;
  row_index?: number | null;
  cell_index?: number | null;
  anchor_id?: string | null;
  diagnostics?: string[];
}): TableCellGeometry {
  const xMin = finiteNumber(params.x_min);
  const xMax = finiteNumber(params.x_max);
  const yMin = finiteNumber(params.y_min);
  const yMax = finiteNumber(params.y_max);
  const width = xMin != null && xMax != null ? Math.max(0, xMax - xMin) : null;
  const height = yMin != null && yMax != null ? Math.max(0, yMax - yMin) : null;
  const geometry: TableCellGeometry = {
    page_number: finiteNumber(params.page_number),
    text: params.text ?? undefined,
    x_min: xMin,
    x_max: xMax,
    y_min: yMin,
    y_max: yMax,
    width,
    height,
    source_type: params.source_type ?? null,
    source_document_id: params.source_document_id ?? null,
    table_id: params.table_id ?? null,
    row_id: params.row_id ?? null,
    row_index: finiteNumber(params.row_index),
    cell_index: finiteNumber(params.cell_index),
    anchor_id: params.anchor_id ?? null,
  };
  geometry.diagnostics = geometryDiagnostics({
    ...geometry,
    diagnostics: params.diagnostics,
  });
  return geometry;
}

function sameRowIdentity(left: TableCellGeometry, right: TableCellGeometry): boolean {
  return left.page_number != null
    && right.page_number != null
    && left.page_number === right.page_number
    && (left.table_id == null || right.table_id == null || left.table_id === right.table_id)
    && left.row_index != null
    && right.row_index != null
    && left.row_index === right.row_index;
}

function horizontalRangesTouch(left: TableCellGeometry, right: TableCellGeometry, tolerance = 2): boolean {
  if (!hasHorizontalGeometry(left) || !hasHorizontalGeometry(right)) return false;
  return (left.x_min ?? 0) <= (right.x_max ?? 0) + tolerance
    && (right.x_min ?? 0) <= (left.x_max ?? 0) + tolerance;
}

export function samePageRowCandidate(
  left: TableCellGeometry,
  right: TableCellGeometry,
): SamePageRowCandidateResult {
  const diagnostics = new Set<string>([
    ...geometryDiagnostics(left),
    ...geometryDiagnostics(right),
  ]);

  if (!sameRowIdentity(left, right)) {
    diagnostics.add('different_page_table_or_row');
    return { candidate: false, confidence: 0, diagnostics: [...diagnostics] };
  }

  if (!hasVerticalGeometry(left) || !hasVerticalGeometry(right)) {
    diagnostics.add('row_index_only_match');
  }

  if (!horizontalRangesTouch(left, right)) {
    diagnostics.add(hasHorizontalGeometry(left) && hasHorizontalGeometry(right)
      ? 'non_overlapping_x_bounds'
      : 'missing_x_bounds');
  }

  const candidate = !diagnostics.has('non_overlapping_x_bounds') && !diagnostics.has('missing_x_bounds');
  return {
    candidate,
    confidence: hasVerticalGeometry(left) && hasVerticalGeometry(right) && candidate ? 0.9 : candidate ? 0.45 : 0,
    diagnostics: [...diagnostics],
  };
}

export function groupCellsByPageAndRow(cells: readonly GeometryCellRef[]): ReconstructedTableRowCandidate[] {
  const groups = new Map<string, GeometryCellRef[]>();
  for (const cell of cells) {
    const key = [
      cell.geometry.page_number ?? 'unknown-page',
      cell.geometry.table_id ?? 'unknown-table',
      cell.geometry.row_index ?? 'unknown-row',
    ].join('|');
    groups.set(key, [...(groups.get(key) ?? []), cell]);
  }

  return [...groups.values()].map((group) => {
    const ordered = [...group].sort((left, right) =>
      (left.geometry.cell_index ?? Number.MAX_SAFE_INTEGER)
      - (right.geometry.cell_index ?? Number.MAX_SAFE_INTEGER));
    const diagnostics = uniqueDiagnostics(ordered.flatMap((cell) => geometryDiagnostics(cell.geometry)));
    if (ordered.some((cell) => !hasVerticalGeometry(cell.geometry))) {
      diagnostics.push('row_index_only_match');
    }
    return {
      page_number: ordered[0]?.geometry.page_number ?? null,
      row_index: ordered[0]?.geometry.row_index ?? null,
      cells: ordered,
      confidence: diagnostics.includes('missing_y_bounds') ? 0.45 : 0.9,
      diagnostics: uniqueDiagnostics(diagnostics),
    };
  });
}
