import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

type TableError = {
  code?: string | null;
  message?: string | null;
} | null | undefined;

type PersistableTransactionData = {
  rowCount: number;
  totalExtendedCost: number;
  totalTransactionQuantity: number;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  summaryJson: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
};

export type PersistTransactionDataResult = {
  persisted: boolean;
  skipped: boolean;
  reason?: 'missing_admin' | 'missing_project_id' | 'not_transaction_data' | 'missing_table';
  rowCount: number;
};

export type PersistedTransactionDataDataset = {
  id: string;
  document_id: string;
  project_id: string;
  row_count: number;
  total_extended_cost: number;
  total_transaction_quantity: number;
  date_range_start: string | null;
  date_range_end: string | null;
  summary_json: Record<string, unknown>;
  created_at: string;
};

export type PersistedTransactionDataRow = {
  id: string;
  document_id: string;
  project_id: string;
  invoice_number: string | null;
  transaction_number: string | null;
  rate_code: string | null;
  billing_rate_key: string | null;
  description_match_key: string | null;
  site_material_key: string | null;
  invoice_rate_key: string | null;
  transaction_quantity: number | null;
  extended_cost: number | null;
  invoice_date: string | null;
  source_sheet_name: string;
  source_row_number: number;
  record_json: Record<string, unknown>;
  raw_row_json: Record<string, unknown>;
  created_at: string;
};

export type ProjectTransactionData = {
  datasets: PersistedTransactionDataDataset[];
  rows: PersistedTransactionDataRow[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry != null)
    : [];
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asInteger(value: unknown): number | null {
  const parsed = asNumber(value);
  return parsed != null ? Math.trunc(parsed) : null;
}

function asDateString(value: unknown): string | null {
  const text = asString(value);
  return text && /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asNumber(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function firstInteger(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = asInteger(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function firstDate(...values: unknown[]): string | null {
  for (const value of values) {
    const parsed = asDateString(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function isTransactionDataTableUnavailableError(error: TableError): boolean {
  if (!error) return false;

  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205' || code === '42703' || code === 'PGRST204') {
    return true;
  }

  return (
    message.includes('transaction_data_datasets') ||
    message.includes('transaction_data_rows') ||
    message.includes('could not find the table') ||
    message.includes('schema cache') ||
    message.includes('does not exist')
  );
}

function chunk<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    out.push(values.slice(index, index + size));
  }
  return out;
}

function coercePersistableTransactionData(
  value: Record<string, unknown> | null | undefined,
): PersistableTransactionData | null {
  const extracted = asRecord(value);
  if (!extracted) return null;

  const sourceType = asString(extracted.sourceType) ?? asString(extracted.source_type);
  if (sourceType !== 'transaction_data') return null;

  const summary = asRecord(extracted.summary) ?? {};
  const rollups = asRecord(extracted.rollups) ?? {};
  const inferredDateRange =
    asRecord(extracted.inferredDateRange) ??
    asRecord(extracted.inferred_date_range);
  const records = asRecordArray(extracted.records);

  return {
    rowCount:
      firstInteger(extracted.rowCount, extracted.row_count, summary.row_count) ?? records.length,
    totalExtendedCost:
      firstNumber(summary.total_extended_cost, rollups.totalExtendedCost, rollups.total_extended_cost) ?? 0,
    totalTransactionQuantity:
      firstNumber(summary.total_transaction_quantity, rollups.totalTransactionQuantity, rollups.total_transaction_quantity) ?? 0,
    dateRangeStart: firstDate(summary.inferred_date_range_start, inferredDateRange?.start),
    dateRangeEnd: firstDate(summary.inferred_date_range_end, inferredDateRange?.end),
    summaryJson: summary,
    records,
  };
}

function mapDatasetInsert(
  documentId: string,
  projectId: string,
  data: PersistableTransactionData,
): Record<string, unknown> {
  return {
    document_id: documentId,
    project_id: projectId,
    row_count: data.rowCount,
    total_extended_cost: data.totalExtendedCost,
    total_transaction_quantity: data.totalTransactionQuantity,
    date_range_start: data.dateRangeStart,
    date_range_end: data.dateRangeEnd,
    summary_json: data.summaryJson,
  };
}

function mapRowInsert(
  documentId: string,
  projectId: string,
  record: Record<string, unknown>,
): Record<string, unknown> {
  return {
    document_id: documentId,
    project_id: projectId,
    invoice_number: asString(record.invoice_number),
    transaction_number: asString(record.transaction_number),
    rate_code: asString(record.rate_code),
    billing_rate_key: asString(record.billing_rate_key),
    description_match_key: asString(record.description_match_key),
    site_material_key: asString(record.site_material_key),
    invoice_rate_key: asString(record.invoice_rate_key),
    transaction_quantity: asNumber(record.transaction_quantity),
    extended_cost: asNumber(record.extended_cost),
    invoice_date: asDateString(record.invoice_date),
    source_sheet_name: asString(record.source_sheet_name) ?? 'unknown',
    source_row_number: firstInteger(record.source_row_number) ?? 0,
    record_json: record,
    raw_row_json: asRecord(record.raw_row) ?? {},
  };
}

async function deleteExistingTransactionData(
  admin: SupabaseClient,
  documentId: string,
): Promise<{ skipped: boolean }> {
  const { error: rowsDeleteError } = await admin
    .from('transaction_data_rows')
    .delete()
    .eq('document_id', documentId);

  if (isTransactionDataTableUnavailableError(rowsDeleteError)) {
    return { skipped: true };
  }
  if (rowsDeleteError) {
    throw new Error(`Failed to delete transaction_data_rows for ${documentId}: ${rowsDeleteError.message}`);
  }

  const { error: datasetsDeleteError } = await admin
    .from('transaction_data_datasets')
    .delete()
    .eq('document_id', documentId);

  if (isTransactionDataTableUnavailableError(datasetsDeleteError)) {
    return { skipped: true };
  }
  if (datasetsDeleteError) {
    throw new Error(`Failed to delete transaction_data_datasets for ${documentId}: ${datasetsDeleteError.message}`);
  }

  return { skipped: false };
}

async function cleanupOnInsertFailure(
  admin: SupabaseClient,
  documentId: string,
): Promise<void> {
  await admin.from('transaction_data_rows').delete().eq('document_id', documentId);
  await admin.from('transaction_data_datasets').delete().eq('document_id', documentId);
}

export async function persistTransactionDataForDocument(params: {
  admin?: SupabaseClient | null;
  documentId: string;
  projectId?: string | null;
  extracted: Record<string, unknown> | null | undefined;
}): Promise<PersistTransactionDataResult> {
  const admin = params.admin ?? getSupabaseAdmin();
  if (!admin) {
    return { persisted: false, skipped: true, reason: 'missing_admin', rowCount: 0 };
  }

  if (!params.projectId) {
    return { persisted: false, skipped: true, reason: 'missing_project_id', rowCount: 0 };
  }

  const persistable = coercePersistableTransactionData(params.extracted);
  if (!persistable) {
    return { persisted: false, skipped: true, reason: 'not_transaction_data', rowCount: 0 };
  }

  const deleted = await deleteExistingTransactionData(admin, params.documentId);
  if (deleted.skipped) {
    return { persisted: false, skipped: true, reason: 'missing_table', rowCount: 0 };
  }

  const { error: datasetInsertError } = await admin
    .from('transaction_data_datasets')
    .insert(mapDatasetInsert(params.documentId, params.projectId, persistable));

  if (isTransactionDataTableUnavailableError(datasetInsertError)) {
    return { persisted: false, skipped: true, reason: 'missing_table', rowCount: 0 };
  }
  if (datasetInsertError) {
    throw new Error(`Failed to insert transaction_data_datasets for ${params.documentId}: ${datasetInsertError.message}`);
  }

  const rowInserts = persistable.records.map((record) =>
    mapRowInsert(params.documentId, params.projectId as string, record),
  );

  try {
    for (const batch of chunk(rowInserts, 500)) {
      if (batch.length === 0) continue;
      const { error } = await admin
        .from('transaction_data_rows')
        .insert(batch);

      if (isTransactionDataTableUnavailableError(error)) {
        await cleanupOnInsertFailure(admin, params.documentId);
        return { persisted: false, skipped: true, reason: 'missing_table', rowCount: 0 };
      }
      if (error) {
        throw new Error(`Failed to insert transaction_data_rows for ${params.documentId}: ${error.message}`);
      }
    }
  } catch (error) {
    await cleanupOnInsertFailure(admin, params.documentId);
    throw error;
  }

  return {
    persisted: true,
    skipped: false,
    rowCount: rowInserts.length,
  };
}

function mapPersistedDataset(row: Record<string, unknown>): PersistedTransactionDataDataset {
  return {
    id: asString(row.id) ?? '',
    document_id: asString(row.document_id) ?? '',
    project_id: asString(row.project_id) ?? '',
    row_count: firstInteger(row.row_count) ?? 0,
    total_extended_cost: firstNumber(row.total_extended_cost) ?? 0,
    total_transaction_quantity: firstNumber(row.total_transaction_quantity) ?? 0,
    date_range_start: firstDate(row.date_range_start),
    date_range_end: firstDate(row.date_range_end),
    summary_json: asRecord(row.summary_json) ?? {},
    created_at: asString(row.created_at) ?? '',
  };
}

function mapPersistedRow(row: Record<string, unknown>): PersistedTransactionDataRow {
  return {
    id: asString(row.id) ?? '',
    document_id: asString(row.document_id) ?? '',
    project_id: asString(row.project_id) ?? '',
    invoice_number: asString(row.invoice_number),
    transaction_number: asString(row.transaction_number),
    rate_code: asString(row.rate_code),
    billing_rate_key: asString(row.billing_rate_key),
    description_match_key: asString(row.description_match_key),
    site_material_key: asString(row.site_material_key),
    invoice_rate_key: asString(row.invoice_rate_key),
    transaction_quantity: asNumber(row.transaction_quantity),
    extended_cost: asNumber(row.extended_cost),
    invoice_date: asDateString(row.invoice_date),
    source_sheet_name: asString(row.source_sheet_name) ?? 'unknown',
    source_row_number: firstInteger(row.source_row_number) ?? 0,
    record_json: asRecord(row.record_json) ?? {},
    raw_row_json: asRecord(row.raw_row_json) ?? {},
    created_at: asString(row.created_at) ?? '',
  };
}

export async function getTransactionDataForProject(
  projectId: string,
  adminParam?: SupabaseClient | null,
): Promise<ProjectTransactionData> {
  const admin = adminParam ?? getSupabaseAdmin();
  if (!admin) {
    return { datasets: [], rows: [] };
  }

  const [datasetsResult, rowsResult] = await Promise.all([
    admin
      .from('transaction_data_datasets')
      .select('id, document_id, project_id, row_count, total_extended_cost, total_transaction_quantity, date_range_start, date_range_end, summary_json, created_at')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    admin
      .from('transaction_data_rows')
      .select('id, document_id, project_id, invoice_number, transaction_number, rate_code, billing_rate_key, description_match_key, site_material_key, invoice_rate_key, transaction_quantity, extended_cost, invoice_date, source_sheet_name, source_row_number, record_json, raw_row_json, created_at')
      .eq('project_id', projectId)
      .order('invoice_date', { ascending: true })
      .order('source_sheet_name', { ascending: true })
      .order('source_row_number', { ascending: true }),
  ]);

  if (
    isTransactionDataTableUnavailableError(datasetsResult.error) ||
    isTransactionDataTableUnavailableError(rowsResult.error)
  ) {
    return { datasets: [], rows: [] };
  }

  if (datasetsResult.error) {
    throw new Error(`Failed to load transaction_data_datasets for ${projectId}: ${datasetsResult.error.message}`);
  }
  if (rowsResult.error) {
    throw new Error(`Failed to load transaction_data_rows for ${projectId}: ${rowsResult.error.message}`);
  }

  return {
    datasets: asRecordArray(datasetsResult.data).map(mapPersistedDataset),
    rows: asRecordArray(rowsResult.data).map(mapPersistedRow),
  };
}
