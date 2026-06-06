import type { SupabaseClient } from '@supabase/supabase-js';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { withStageTimeout } from '@/lib/server/stageTimeout';

const TRANSACTION_DATA_DELETE_TIMEOUT_MS = 60_000;
const TRANSACTION_DATA_DATASET_INSERT_TIMEOUT_MS = 60_000;
const TRANSACTION_DATA_ROW_BATCH_TIMEOUT_MS = 60_000;
const TRANSACTION_DATA_ROW_INSERT_BATCH_SIZE = 150;

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

const TRANSACTION_DATASET_SELECT =
  'id, document_id, project_id, row_count, total_extended_cost, total_transaction_quantity, date_range_start, date_range_end, summary_json, created_at';
const TRANSACTION_DATA_ROW_SELECT =
  'id, document_id, project_id, invoice_number, transaction_number, rate_code, billing_rate_key, description_match_key, site_material_key, invoice_rate_key, transaction_quantity, extended_cost, invoice_date, source_sheet_name, source_row_number, record_json, raw_row_json, created_at';

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

export function isTransactionDataTableUnavailableError(error: TableError): boolean {
  if (!error) return false;

  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205') {
    return true;
  }

  return (
    message.includes('could not find the table') ||
    /(?:relation|table)\s+"?(?:public\.)?(transaction_data_datasets|transaction_data_rows)"?\s+does not exist/.test(message)
  );
}

function isMissingColumnError(error: TableError, columnName: string): boolean {
  if (!error) return false;

  const message = (error.message ?? '').toLowerCase();
  const normalizedColumn = columnName.toLowerCase();

  return (
    error.code === '42703' ||
    error.code === 'PGRST204' ||
    message.includes(`'${normalizedColumn}'`) ||
    message.includes(normalizedColumn)
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
  organizationId: string | null | undefined,
  record: Record<string, unknown>,
): Record<string, unknown> {
  const row: Record<string, unknown> = {
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

  if (organizationId) {
    row.organization_id = organizationId;
  }

  return row;
}

async function deleteExistingTransactionData(
  admin: SupabaseClient,
  documentId: string,
): Promise<{ skipped: boolean }> {
  const { error: rowsDeleteError } = await withStageTimeout(
    admin
      .from('transaction_data_rows')
      .delete()
      .eq('document_id', documentId),
    'transaction_data_rows delete',
    TRANSACTION_DATA_DELETE_TIMEOUT_MS,
  );

  if (isTransactionDataTableUnavailableError(rowsDeleteError)) {
    return { skipped: true };
  }
  if (rowsDeleteError) {
    throw new Error(`Failed to delete transaction_data_rows for ${documentId}: ${rowsDeleteError.message}`);
  }

  const { error: datasetsDeleteError } = await withStageTimeout(
    admin
      .from('transaction_data_datasets')
      .delete()
      .eq('document_id', documentId),
    'transaction_data_datasets delete',
    TRANSACTION_DATA_DELETE_TIMEOUT_MS,
  );

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
  try {
    await withStageTimeout(
      admin.from('transaction_data_rows').delete().eq('document_id', documentId),
      'transaction_data_rows cleanup',
      TRANSACTION_DATA_DELETE_TIMEOUT_MS,
    );
  } catch (err) {
    console.error('[documents/process][spreadsheet] transaction_data_rows cleanup failed', {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await withStageTimeout(
      admin.from('transaction_data_datasets').delete().eq('document_id', documentId),
      'transaction_data_datasets cleanup',
      TRANSACTION_DATA_DELETE_TIMEOUT_MS,
    );
  } catch (err) {
    console.error('[documents/process][spreadsheet] transaction_data_datasets cleanup failed', {
      documentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function persistTransactionDataForDocument(params: {
  admin?: SupabaseClient | null;
  documentId: string;
  projectId?: string | null;
  organizationId?: string | null;
  extracted: Record<string, unknown> | null | undefined;
}): Promise<PersistTransactionDataResult> {
  console.log('[documents/process][spreadsheet] transaction_data persistence start', {
    documentId: params.documentId,
    projectId: params.projectId ?? null,
  });
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

  console.log('[documents/process][spreadsheet] transaction_data_datasets persistence start', {
    documentId: params.documentId,
    projectId: params.projectId ?? null,
    rowCount: persistable.rowCount,
  });
  const { error: datasetInsertError } = await withStageTimeout(
    admin
      .from('transaction_data_datasets')
      .insert(mapDatasetInsert(params.documentId, params.projectId, persistable)),
    'transaction_data_datasets insert',
    TRANSACTION_DATA_DATASET_INSERT_TIMEOUT_MS,
  );

  if (isTransactionDataTableUnavailableError(datasetInsertError)) {
    return { persisted: false, skipped: true, reason: 'missing_table', rowCount: 0 };
  }
  if (datasetInsertError) {
    throw new Error(`Failed to insert transaction_data_datasets for ${params.documentId}: ${datasetInsertError.message}`);
  }
  console.log('[documents/process][spreadsheet] transaction_data_datasets persistence complete', {
    documentId: params.documentId,
    projectId: params.projectId ?? null,
  });

  const rowInserts = persistable.records.map((record) =>
    mapRowInsert(params.documentId, params.projectId as string, params.organizationId, record),
  );
  const rowInsertBatches = chunk(rowInserts, TRANSACTION_DATA_ROW_INSERT_BATCH_SIZE);

  console.log('[documents/process][spreadsheet] transaction_data_rows persistence start', {
    documentId: params.documentId,
    projectId: params.projectId ?? null,
    rowInsertCount: rowInserts.length,
    batchSize: TRANSACTION_DATA_ROW_INSERT_BATCH_SIZE,
    batchCount: rowInsertBatches.length,
  });
  try {
    let batchIndex = 0;
    for (const batch of rowInsertBatches) {
      if (batch.length === 0) continue;
      console.log('[documents/process][spreadsheet] transaction_data_rows batch insert start', {
        documentId: params.documentId,
        projectId: params.projectId ?? null,
        batchIndex,
        batchNumber: batchIndex + 1,
        batchCount: rowInsertBatches.length,
        batchSize: batch.length,
      });
      const { error } = await withStageTimeout(
        admin
          .from('transaction_data_rows')
          .insert(batch),
        `transaction_data_rows insert batch ${batchIndex}`,
        TRANSACTION_DATA_ROW_BATCH_TIMEOUT_MS,
      );

      if (isTransactionDataTableUnavailableError(error)) {
        await cleanupOnInsertFailure(admin, params.documentId);
        return { persisted: false, skipped: true, reason: 'missing_table', rowCount: 0 };
      }
      if (error) {
        throw new Error(`Failed to insert transaction_data_rows for ${params.documentId}: ${error.message}`);
      }
      console.log('[documents/process][spreadsheet] transaction_data_rows batch insert complete', {
        documentId: params.documentId,
        projectId: params.projectId ?? null,
        batchIndex,
        batchNumber: batchIndex + 1,
        batchCount: rowInsertBatches.length,
        batchSize: batch.length,
      });
      batchIndex += 1;
    }
  } catch (error) {
    await cleanupOnInsertFailure(admin, params.documentId);
    throw error;
  }
  console.log('[documents/process][spreadsheet] transaction_data_rows persistence complete', {
    documentId: params.documentId,
    projectId: params.projectId ?? null,
    rowInsertCount: rowInserts.length,
  });

  console.log('[documents/process][spreadsheet] transaction_data persistence complete', {
    documentId: params.documentId,
    projectId: params.projectId ?? null,
    rowCount: rowInserts.length,
  });

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

async function loadDatasetsByDocumentIds(
  admin: SupabaseClient,
  documentIds: readonly string[],
): Promise<{ data: unknown; error: TableError }> {
  if (documentIds.length === 0) {
    return { data: [], error: null };
  }

  return admin
    .from('transaction_data_datasets')
    .select(TRANSACTION_DATASET_SELECT)
    .in('document_id', [...documentIds])
    .order('created_at', { ascending: false });
}

const TRANSACTION_DATA_ROW_PAGE_SIZE = 1000;

async function loadTransactionRowsPaginated(
  fetchPage: (from: number, to: number) => Promise<{ data: unknown; error: TableError }>,
): Promise<{ data: Record<string, unknown>[]; error: TableError }> {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await fetchPage(
      offset,
      offset + TRANSACTION_DATA_ROW_PAGE_SIZE - 1,
    );
    if (error) {
      return { data: rows, error };
    }

    const batch = asRecordArray(data);
    rows.push(...batch);
    if (batch.length < TRANSACTION_DATA_ROW_PAGE_SIZE) {
      break;
    }
    offset += TRANSACTION_DATA_ROW_PAGE_SIZE;
  }

  return { data: rows, error: null };
}

async function loadTransactionRowsForProject(
  admin: SupabaseClient,
  projectId: string,
): Promise<{ data: Record<string, unknown>[]; error: TableError }> {
  return loadTransactionRowsPaginated(async (from, to) =>
    await admin
      .from('transaction_data_rows')
      .select(TRANSACTION_DATA_ROW_SELECT)
      .eq('project_id', projectId)
      .order('invoice_date', { ascending: true })
      .order('source_sheet_name', { ascending: true })
      .order('source_row_number', { ascending: true })
      .range(from, to),
  );
}

async function loadRowsByDocumentIds(
  admin: SupabaseClient,
  documentIds: readonly string[],
): Promise<{ data: Record<string, unknown>[]; error: TableError }> {
  if (documentIds.length === 0) {
    return { data: [], error: null };
  }

  return loadTransactionRowsPaginated(async (from, to) =>
    await admin
      .from('transaction_data_rows')
      .select(TRANSACTION_DATA_ROW_SELECT)
      .in('document_id', [...documentIds])
      .order('invoice_date', { ascending: true })
      .order('source_sheet_name', { ascending: true })
      .order('source_row_number', { ascending: true })
      .range(from, to),
  );
}

export async function getCanonicalTransactionDataForProject(params: {
  projectId: string;
  documentIds?: readonly string[];
  admin?: SupabaseClient | null;
}): Promise<ProjectTransactionData> {
  const admin = params.admin ?? getSupabaseAdmin();
  if (!admin) {
    return { datasets: [], rows: [] };
  }

  const documentIds = params.documentIds ?? [];

  const [projectDatasetsResult, projectRowsResult] = await Promise.all([
    admin
      .from('transaction_data_datasets')
      .select(TRANSACTION_DATASET_SELECT)
      .eq('project_id', params.projectId)
      .order('created_at', { ascending: false }),
    loadTransactionRowsForProject(admin, params.projectId),
  ]);

  if (
    isTransactionDataTableUnavailableError(projectDatasetsResult.error) ||
    isTransactionDataTableUnavailableError(projectRowsResult.error)
  ) {
    return { datasets: [], rows: [] };
  }

  const shouldFallbackDatasets =
    documentIds.length > 0 &&
    (
      (
        projectDatasetsResult.error != null &&
        isMissingColumnError(projectDatasetsResult.error, 'project_id')
      ) ||
      (
        projectDatasetsResult.error == null &&
        asRecordArray(projectDatasetsResult.data).length === 0
      )
    );
  const shouldFallbackRows =
    documentIds.length > 0 &&
    (
      (
        projectRowsResult.error != null &&
        isMissingColumnError(projectRowsResult.error, 'project_id')
      ) ||
      (
        projectRowsResult.error == null &&
        projectRowsResult.data.length === 0
      )
    );

  const [datasetsResult, rowsResult] = await Promise.all([
    shouldFallbackDatasets
      ? loadDatasetsByDocumentIds(admin, documentIds)
      : Promise.resolve(projectDatasetsResult),
    shouldFallbackRows
      ? loadRowsByDocumentIds(admin, documentIds)
      : Promise.resolve(projectRowsResult),
  ]);

  if (datasetsResult.error && isTransactionDataTableUnavailableError(datasetsResult.error)) {
    return { datasets: [], rows: [] };
  }
  if (rowsResult.error && isTransactionDataTableUnavailableError(rowsResult.error)) {
    return { datasets: [], rows: [] };
  }

  if (datasetsResult.error) {
    throw new Error(`Failed to load transaction_data_datasets for ${params.projectId}: ${datasetsResult.error.message}`);
  }
  if (rowsResult.error) {
    throw new Error(`Failed to load transaction_data_rows for ${params.projectId}: ${rowsResult.error.message}`);
  }

  return {
    datasets: asRecordArray(datasetsResult.data).map(mapPersistedDataset),
    rows: rowsResult.data.map(mapPersistedRow),
  };
}

export async function getTransactionDataForProject(
  projectId: string,
  adminParam?: SupabaseClient | null,
): Promise<ProjectTransactionData> {
  return getCanonicalTransactionDataForProject({
    projectId,
    admin: adminParam,
  });
}
