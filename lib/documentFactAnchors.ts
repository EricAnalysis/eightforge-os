export type DocumentFactAnchorType =
  | 'text'
  | 'region'
  | 'page_range'
  | 'table_region';

export type DocumentAnchorCaptureMode = 'text' | 'region' | 'rate_schedule';

export type RateScheduleAnchorType = 'page_range' | 'table_region';

export type DocumentFactAnchorRect = {
  x: number;
  y: number;
  width: number;
  height: number;
  layoutWidth?: number | null;
  layoutHeight?: number | null;
};

export type DocumentFactAnchorRow = {
  id: string;
  organization_id: string;
  document_id: string;
  field_key: string;
  override_id: string | null;
  anchor_type: DocumentFactAnchorType;
  page_number: number;
  start_page?: number | null;
  end_page?: number | null;
  snippet: string | null;
  quote_text: string | null;
  rect_json: unknown;
  anchor_json: unknown;
  created_by: string;
  created_at: string;
  is_primary: boolean;
};

export type DocumentFactAnchorRecord = {
  id: string;
  organizationId: string;
  documentId: string;
  fieldKey: string;
  overrideId: string | null;
  anchorType: DocumentFactAnchorType;
  pageNumber: number;
  startPage: number;
  endPage: number;
  snippet: string | null;
  quoteText: string | null;
  rectJson: unknown;
  anchorJson: unknown;
  createdBy: string;
  createdAt: string;
  isPrimary: boolean;
};

export const DOCUMENT_FACT_ANCHOR_TYPES = [
  'text',
  'region',
  'page_range',
  'table_region',
] as const;

export function isDocumentFactAnchorType(
  value: unknown,
): value is DocumentFactAnchorType {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FACT_ANCHOR_TYPES as readonly string[]).includes(value)
  );
}

function normalizeNullableUuid(value: string | null | undefined): string | null {
  if (value == null) return null;
  const t = String(value).trim();
  if (t.length === 0) return null;
  if (t.toLowerCase() === 'null' || t.toLowerCase() === 'undefined') return null;
  return t;
}

export function mapDocumentFactAnchorRow(
  row: DocumentFactAnchorRow,
): DocumentFactAnchorRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    documentId: row.document_id,
    fieldKey: row.field_key,
    overrideId: normalizeNullableUuid(row.override_id),
    anchorType: row.anchor_type,
    pageNumber: row.page_number,
    startPage:
      typeof row.start_page === 'number' ? row.start_page : row.page_number,
    endPage:
      typeof row.end_page === 'number' ? row.end_page : row.page_number,
    snippet: row.snippet,
    quoteText: row.quote_text,
    rectJson: row.rect_json,
    anchorJson: row.anchor_json,
    createdBy: row.created_by,
    createdAt: row.created_at,
    isPrimary: row.is_primary,
  };
}

/** Postgres undefined_table / PostgREST table missing from schema cache (PGRST205). */
export function isDocumentFactAnchorsTableUnavailableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();

  if (code === 'PGRST205') return true;

  if (code === '42P01' && msg.includes('document_fact_anchors')) return true;

  if (!msg.includes('document_fact_anchors')) return false;

  return (
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table')
  );
}
