export type DocumentFactReviewStatus =
  | 'confirmed'
  | 'corrected'
  | 'needs_followup'
  | 'missing_confirmed';

export type DocumentFactReviewRow = {
  id: string;
  organization_id: string;
  document_id: string;
  field_key: string;
  review_status: DocumentFactReviewStatus;
  reviewed_value_json: unknown;
  reviewed_by: string;
  reviewed_at: string;
  notes: string | null;
};

export type DocumentFactReviewRecord = {
  id: string;
  organizationId: string;
  documentId: string;
  fieldKey: string;
  reviewStatus: DocumentFactReviewStatus;
  reviewedValueJson: unknown;
  reviewedBy: string;
  reviewedAt: string;
  notes: string | null;
};

export const DOCUMENT_FACT_REVIEW_STATUSES = [
  'confirmed',
  'corrected',
  'needs_followup',
  'missing_confirmed',
] as const;

export function isDocumentFactReviewStatus(
  value: unknown,
): value is DocumentFactReviewStatus {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FACT_REVIEW_STATUSES as readonly string[]).includes(value)
  );
}

export function mapDocumentFactReviewRow(
  row: DocumentFactReviewRow,
): DocumentFactReviewRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    documentId: row.document_id,
    fieldKey: row.field_key,
    reviewStatus: row.review_status,
    reviewedValueJson: row.reviewed_value_json,
    reviewedBy: row.reviewed_by,
    reviewedAt: row.reviewed_at,
    notes: row.notes,
  };
}

/** Postgres undefined_table / PostgREST table missing from schema cache (PGRST205). */
export function isDocumentFactReviewsTableUnavailableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();

  if (code === 'PGRST205') return true;

  if (code === '42P01' && msg.includes('document_fact_reviews')) return true;

  if (!msg.includes('document_fact_reviews')) return false;

  return (
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table')
  );
}
