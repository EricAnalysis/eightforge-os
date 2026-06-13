export type DocumentFactOverrideActionType = 'add' | 'correct';

export type DocumentFactDisplaySource =
  | 'auto'
  | 'human_added'
  | 'human_corrected';

export type DocumentFactOverrideRow = {
  id: string;
  organization_id: string;
  document_id: string;
  field_key: string;
  value_json: unknown;
  raw_value: string | null;
  action_type: DocumentFactOverrideActionType;
  reason: string | null;
  created_by: string;
  created_at: string;
  is_active: boolean;
  supersedes_override_id: string | null;
};

export type DocumentFactOverrideRecord = {
  id: string;
  organizationId: string;
  documentId: string;
  fieldKey: string;
  valueJson: unknown;
  rawValue: string | null;
  actionType: DocumentFactOverrideActionType;
  reason: string | null;
  createdBy: string;
  createdAt: string;
  isActive: boolean;
  supersedesOverrideId: string | null;
};

export const DOCUMENT_FACT_OVERRIDE_ACTION_TYPES = ['add', 'correct'] as const;

export function isDocumentFactOverrideActionType(
  value: unknown,
): value is DocumentFactOverrideActionType {
  return (
    typeof value === 'string' &&
    (DOCUMENT_FACT_OVERRIDE_ACTION_TYPES as readonly string[]).includes(value)
  );
}

export function displaySourceFromActionType(
  actionType: DocumentFactOverrideActionType,
): Exclude<DocumentFactDisplaySource, 'auto'> {
  return actionType === 'add' ? 'human_added' : 'human_corrected';
}

export function mapDocumentFactOverrideRow(
  row: DocumentFactOverrideRow,
): DocumentFactOverrideRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    documentId: row.document_id,
    fieldKey: row.field_key,
    valueJson: row.value_json,
    rawValue: row.raw_value,
    actionType: row.action_type,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    isActive: row.is_active,
    supersedesOverrideId: row.supersedes_override_id,
  };
}

/** Postgres undefined_table / PostgREST table missing from schema cache (PGRST205). */
export function isDocumentFactOverridesTableUnavailableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  const msg = (error.message ?? '').toLowerCase();

  if (code === 'PGRST205') return true;

  if (code === '42P01' && msg.includes('document_fact_overrides')) return true;

  if (!msg.includes('document_fact_overrides')) return false;

  return (
    msg.includes('schema cache') ||
    msg.includes('does not exist') ||
    msg.includes('could not find the table')
  );
}
