import type { SupabaseClient } from '@supabase/supabase-js';

import {
  buildCanonicalInvoiceRowsFromTypedFields,
  normalizeCanonicalInvoiceNumber,
} from '@/lib/invoices/invoiceParser';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { withStageTimeout } from '@/lib/server/stageTimeout';

const INVOICE_DELETE_TIMEOUT_MS = 60_000;
const INVOICE_INSERT_TIMEOUT_MS = 60_000;

type TableError = {
  code?: string | null;
  message?: string | null;
} | null | undefined;

type InsertResult = {
  data: Record<string, unknown> | null;
  error: TableError;
  rows: Array<Record<string, unknown>>;
};

export type PersistCanonicalInvoiceResult = {
  persisted: boolean;
  skipped: boolean;
  reason?:
    | 'missing_admin'
    | 'missing_project_id'
    | 'not_invoice'
    | 'no_invoice_data'
    | 'missing_table'
    | 'schema_mismatch';
  invoiceCount: number;
  lineCount: number;
};

export type CanonicalProjectInvoiceData = {
  invoices: Array<Record<string, unknown>>;
  invoiceLines: Array<Record<string, unknown>>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeInvoiceNumberKey(value: unknown): string | null {
  return normalizeCanonicalInvoiceNumber(asString(value));
}

function enrichCanonicalInvoiceLineRow(
  row: Record<string, unknown>,
): Record<string, unknown> {
  const invoice_number_raw =
    asString(row.invoice_number_raw)
    ?? asString(row.invoice_number);
  const invoice_number_normalized =
    asString(row.invoice_number_normalized)
    ?? normalizeCanonicalInvoiceNumber(invoice_number_raw);
  const line_code = asString(row.line_code);
  const sanitizedLineCode =
    line_code && /[A-Za-z]/.test(line_code)
      ? line_code
      : null;

  return {
    ...row,
    invoice_number_raw,
    invoice_number_normalized,
    invoice_number: invoice_number_normalized ?? invoice_number_raw,
    line_code: sanitizedLineCode,
    rate_code: sanitizedLineCode ?? asString(row.rate_code),
    total_amount: asNumber(row.total_amount) ?? asNumber(row.line_total),
  };
}

function enrichCanonicalInvoiceRow(params: {
  row: Record<string, unknown>;
  invoiceLines: readonly Record<string, unknown>[];
}): Record<string, unknown> {
  const row = params.row;
  const invoice_number_raw =
    asString(row.invoice_number_raw)
    ?? asString(row.invoice_number);
  const invoice_number_normalized =
    asString(row.invoice_number_normalized)
    ?? normalizeCanonicalInvoiceNumber(invoice_number_raw);
  const invoiceId = asString(row.id) ?? asString(row.invoice_id);
  const documentId = asString(row.source_document_id) ?? asString(row.document_id);
  const rowNumberKey = invoice_number_normalized ?? normalizeInvoiceNumberKey(row.invoice_number);
  const line_items = params.invoiceLines.filter((line) => {
    const lineInvoiceId = asString(line.invoice_id);
    if (invoiceId && lineInvoiceId === invoiceId) return true;

    const lineDocumentId = asString(line.source_document_id) ?? asString(line.document_id);
    if (documentId && lineDocumentId === documentId) return true;

    const lineNumberKey =
      asString(line.invoice_number_normalized)
      ?? normalizeInvoiceNumberKey(line.invoice_number);
    return rowNumberKey != null && lineNumberKey === rowNumberKey;
  });

  const service_period_start =
    asString(row.service_period_start)
    ?? asString(row.period_start);
  const service_period_end =
    asString(row.service_period_end)
    ?? asString(row.period_end)
    ?? asString(row.period_through);
  const total_amount =
    asNumber(row.total_amount)
    ?? asNumber(row.billed_amount)
    ?? asNumber(row.subtotal_amount);

  return {
    ...row,
    invoice_number_raw,
    invoice_number_normalized,
    invoice_number: invoice_number_normalized ?? invoice_number_raw,
    service_period_start,
    service_period_end,
    period_start: service_period_start,
    period_end: service_period_end ?? asString(row.period_end),
    total_amount,
    billed_amount: asNumber(row.billed_amount) ?? total_amount,
    line_items,
  };
}

export function isInvoicePersistenceTableUnavailableError(error: TableError): boolean {
  if (!error) return false;

  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205') {
    return true;
  }

  return (
    message.includes('could not find the table') ||
    /(?:relation|table)\s+"?(?:public\.)?(invoices|invoice_lines)"?\s+does not exist/.test(message)
  );
}

function isMissingColumnError(error: TableError, columnName?: string): boolean {
  if (!error) return false;

  const message = (error.message ?? '').toLowerCase();
  if (error.code === '42703' || error.code === 'PGRST204') {
    return true;
  }
  if (!columnName) {
    return message.includes('does not exist') && message.includes('column');
  }
  return (
    message.includes(`'${columnName.toLowerCase()}'`) ||
    message.includes(columnName.toLowerCase())
  );
}

function extractMissingColumnName(error: TableError): string | null {
  const message = error?.message ?? '';
  if (message.length === 0) return null;

  const quotedMatch = message.match(/'([^']+)'/);
  if (quotedMatch?.[1]) {
    return quotedMatch[1].split('.').pop() ?? null;
  }

  const columnMatch = message.match(/column\s+"?([\w.]+)"?\s+does not exist/i);
  if (columnMatch?.[1]) {
    return columnMatch[1].split('.').pop() ?? null;
  }

  return null;
}

async function loadInvoicesByDocumentIds(
  admin: SupabaseClient,
  documentIds: readonly string[],
): Promise<{ data: unknown; error: TableError }> {
  if (documentIds.length === 0) {
    return { data: [], error: null };
  }

  const sourceDocumentResult = await admin
    .from('invoices')
    .select('*')
    .in('source_document_id', [...documentIds]);

  if (!sourceDocumentResult.error || !isMissingColumnError(sourceDocumentResult.error, 'source_document_id')) {
    return sourceDocumentResult;
  }

  return admin
    .from('invoices')
    .select('*')
    .in('document_id', [...documentIds]);
}

async function loadInvoiceLinesByDocumentIds(
  admin: SupabaseClient,
  documentIds: readonly string[],
): Promise<{ data: unknown; error: TableError }> {
  if (documentIds.length === 0) {
    return { data: [], error: null };
  }

  const sourceDocumentResult = await admin
    .from('invoice_lines')
    .select('*')
    .in('source_document_id', [...documentIds]);

  if (!sourceDocumentResult.error || !isMissingColumnError(sourceDocumentResult.error, 'source_document_id')) {
    return sourceDocumentResult;
  }

  return admin
    .from('invoice_lines')
    .select('*')
    .in('document_id', [...documentIds]);
}

async function loadInvoiceLinesByInvoiceIds(
  admin: SupabaseClient,
  invoiceIds: readonly string[],
): Promise<{ data: unknown; error: TableError }> {
  if (invoiceIds.length === 0) {
    return { data: [], error: null };
  }

  return admin
    .from('invoice_lines')
    .select('*')
    .in('invoice_id', [...invoiceIds]);
}

function readTypedFields(
  extractionData: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  const extraction = asRecord(extractionData);
  const fields = asRecord(extraction?.fields);
  const typed = asRecord(fields?.typed_fields);
  if (!typed) return null;

  const schemaType = asString(typed.schema_type);
  return schemaType === 'invoice' ? typed : null;
}

async function deleteDocumentScopedRows(
  admin: SupabaseClient,
  table: 'invoices' | 'invoice_lines',
  documentId: string,
): Promise<{ ok: boolean; reason?: 'missing_table' | 'schema_mismatch' }> {
  let hadScopeColumn = false;

  for (const column of ['source_document_id', 'document_id'] as const) {
    const { error } = await withStageTimeout(
      admin
        .from(table)
        .delete()
        .eq(column, documentId),
      `${table} delete ${column}`,
      INVOICE_DELETE_TIMEOUT_MS,
    );

    if (!error) {
      hadScopeColumn = true;
      continue;
    }

    if (isInvoicePersistenceTableUnavailableError(error)) {
      return { ok: false, reason: 'missing_table' };
    }
    if (isMissingColumnError(error, column)) {
      continue;
    }

    throw new Error(`Failed to delete ${table} rows for ${documentId}: ${error.message}`);
  }

  return hadScopeColumn
    ? { ok: true }
    : { ok: false, reason: 'schema_mismatch' };
}

async function deleteInvoiceRowById(
  admin: SupabaseClient,
  invoiceId: string,
): Promise<void> {
  const { error } = await withStageTimeout(
    admin
      .from('invoices')
      .delete()
      .eq('id', invoiceId),
    'invoices delete id',
    INVOICE_DELETE_TIMEOUT_MS,
  );

  if (error && !isInvoicePersistenceTableUnavailableError(error)) {
    throw new Error(`Failed to delete invoice row ${invoiceId}: ${error.message}`);
  }
}

async function insertWithOptionalColumnFallback(
  admin: SupabaseClient,
  params: {
    table: 'invoices' | 'invoice_lines';
    rows: Array<Record<string, unknown>>;
    optionalColumns: readonly string[];
    select?: string;
  },
): Promise<InsertResult> {
  let rows = params.rows.map((row) => ({ ...row }));
  const optionalColumns = new Set(
    params.optionalColumns.filter((column) => rows.some((row) => column in row)),
  );

  while (true) {
    if (params.select) {
      const { data, error } = await withStageTimeout(
        admin
          .from(params.table)
          .insert(rows)
          .select(params.select)
          .single(),
        `${params.table} insert`,
        INVOICE_INSERT_TIMEOUT_MS,
      );

      if (!error) {
        return {
          data: asRecord(data),
          error: null,
          rows,
        };
      }

      const missingColumn = extractMissingColumnName(error);
      if (!missingColumn || !optionalColumns.has(missingColumn)) {
        return { data: null, error, rows };
      }

      rows = rows.map((row) => {
        const next = { ...row };
        delete next[missingColumn];
        return next;
      });
      optionalColumns.delete(missingColumn);
      continue;
    }

    const { error } = await withStageTimeout(
      admin
        .from(params.table)
        .insert(rows),
      `${params.table} insert`,
      INVOICE_INSERT_TIMEOUT_MS,
    );

    if (!error) {
      return {
        data: null,
        error: null,
        rows,
      };
    }

    const missingColumn = extractMissingColumnName(error);
    if (!missingColumn || !optionalColumns.has(missingColumn)) {
      return { data: null, error, rows };
    }

    rows = rows.map((row) => {
      const next = { ...row };
      delete next[missingColumn];
      return next;
    });
    optionalColumns.delete(missingColumn);
  }
}

export async function persistCanonicalInvoiceForDocument(params: {
  admin?: SupabaseClient | null;
  documentId: string;
  projectId?: string | null;
  extractionData: Record<string, unknown> | null | undefined;
}): Promise<PersistCanonicalInvoiceResult> {
  const admin = params.admin ?? getSupabaseAdmin();
  if (!admin) {
    return { persisted: false, skipped: true, reason: 'missing_admin', invoiceCount: 0, lineCount: 0 };
  }
  if (!params.projectId) {
    return { persisted: false, skipped: true, reason: 'missing_project_id', invoiceCount: 0, lineCount: 0 };
  }

  const typedFields = readTypedFields(params.extractionData);
  if (!typedFields) {
    return { persisted: false, skipped: true, reason: 'not_invoice', invoiceCount: 0, lineCount: 0 };
  }

  const canonical = buildCanonicalInvoiceRowsFromTypedFields({
    documentId: params.documentId,
    typedFields,
  });
  if (!canonical.invoiceRow) {
    return { persisted: false, skipped: true, reason: 'no_invoice_data', invoiceCount: 0, lineCount: 0 };
  }

  const deletedLines = await deleteDocumentScopedRows(admin, 'invoice_lines', params.documentId);
  if (!deletedLines.ok) {
    return {
      persisted: false,
      skipped: true,
      reason: deletedLines.reason,
      invoiceCount: 0,
      lineCount: 0,
    };
  }

  const deletedInvoices = await deleteDocumentScopedRows(admin, 'invoices', params.documentId);
  if (!deletedInvoices.ok) {
    return {
      persisted: false,
      skipped: true,
      reason: deletedInvoices.reason,
      invoiceCount: 0,
      lineCount: 0,
    };
  }

  const invoiceInsertPayload: Record<string, unknown> = {
    project_id: params.projectId,
    source_document_id: params.documentId,
    document_id: params.documentId,
    invoice_number: canonical.invoiceRow.invoice_number ?? null,
    invoice_status: canonical.invoiceRow.invoice_status ?? null,
    invoice_date: canonical.invoiceRow.invoice_date ?? null,
    period_start: canonical.invoiceRow.period_start ?? null,
    period_end: canonical.invoiceRow.period_end ?? null,
    period_through: canonical.invoiceRow.period_through ?? null,
    vendor_name: canonical.invoiceRow.vendor_name ?? null,
    client_name: canonical.invoiceRow.client_name ?? null,
    subtotal_amount: canonical.invoiceRow.subtotal_amount ?? null,
    total_amount: canonical.invoiceRow.total_amount ?? null,
    billed_amount: canonical.invoiceRow.billed_amount ?? canonical.invoiceRow.total_amount ?? null,
    line_item_count: canonical.invoiceRow.line_item_count ?? canonical.invoiceLines.length,
  };

  const insertedInvoice = await insertWithOptionalColumnFallback(admin, {
    table: 'invoices',
    rows: [invoiceInsertPayload],
    optionalColumns: ['source_document_id', 'document_id', 'invoice_status', 'period_start', 'period_end', 'period_through', 'line_item_count'],
    select: 'id',
  });

  if (isInvoicePersistenceTableUnavailableError(insertedInvoice.error)) {
    return {
      persisted: false,
      skipped: true,
      reason: 'missing_table',
      invoiceCount: 0,
      lineCount: 0,
    };
  }
  if (insertedInvoice.error || !insertedInvoice.data) {
    if (isMissingColumnError(insertedInvoice.error)) {
      return {
        persisted: false,
        skipped: true,
        reason: 'schema_mismatch',
        invoiceCount: 0,
        lineCount: 0,
      };
    }
    throw new Error(
      `Failed to insert canonical invoice row for ${params.documentId}: ${insertedInvoice.error?.message ?? 'unknown error'}`,
    );
  }

  const invoiceId = asString(insertedInvoice.data.id);
  const insertedInvoiceRow = insertedInvoice.rows[0] ?? null;
  if (
    !invoiceId
    || !insertedInvoiceRow
    || (!('source_document_id' in insertedInvoiceRow) && !('document_id' in insertedInvoiceRow))
  ) {
    if (invoiceId) {
      await deleteInvoiceRowById(admin, invoiceId);
    } else {
      await deleteDocumentScopedRows(admin, 'invoices', params.documentId);
    }
    return {
      persisted: false,
      skipped: true,
      reason: 'schema_mismatch',
      invoiceCount: 0,
      lineCount: 0,
    };
  }

  if (canonical.invoiceLines.length === 0) {
    return {
      persisted: true,
      skipped: false,
      invoiceCount: 1,
      lineCount: 0,
    };
  }

  const invoiceLineInsertPayloads = canonical.invoiceLines.map((line) => ({
    project_id: params.projectId,
    source_document_id: params.documentId,
    document_id: params.documentId,
    invoice_id: invoiceId,
    invoice_number: line.invoice_number ?? canonical.invoiceRow?.invoice_number ?? null,
    line_code: line.line_code ?? null,
    rate_code: line.rate_code ?? line.line_code ?? null,
    description: line.description ?? line.line_description ?? null,
    line_description: line.line_description ?? line.description ?? null,
    material: line.material ?? null,
    service_item: line.service_item ?? null,
    quantity: line.quantity ?? null,
    unit: line.unit ?? null,
    unit_price: line.unit_price ?? null,
    line_total: line.line_total ?? line.total_amount ?? null,
    total_amount: line.total_amount ?? line.line_total ?? null,
    billing_rate_key: line.billing_rate_key ?? null,
    description_match_key: line.description_match_key ?? null,
    invoice_rate_key: line.invoice_rate_key ?? null,
    canonical_category: line.canonical_category ?? null,
    category_confidence: line.category_confidence ?? null,
  }));

  const insertedLines = await insertWithOptionalColumnFallback(admin, {
    table: 'invoice_lines',
    rows: invoiceLineInsertPayloads,
    optionalColumns: [
      'project_id',
      'source_document_id',
      'document_id',
      'description_match_key',
      'material',
      'service_item',
      'canonical_category',
      'category_confidence',
    ],
  });

  if (isInvoicePersistenceTableUnavailableError(insertedLines.error)) {
    await deleteDocumentScopedRows(admin, 'invoice_lines', params.documentId);
    await deleteInvoiceRowById(admin, invoiceId);
    return {
      persisted: false,
      skipped: true,
      reason: 'missing_table',
      invoiceCount: 0,
      lineCount: 0,
    };
  }
  if (insertedLines.error) {
    if (isMissingColumnError(insertedLines.error)) {
      await deleteDocumentScopedRows(admin, 'invoice_lines', params.documentId);
      await deleteInvoiceRowById(admin, invoiceId);
      return {
        persisted: false,
        skipped: true,
        reason: 'schema_mismatch',
        invoiceCount: 0,
        lineCount: 0,
      };
    }
    await deleteDocumentScopedRows(admin, 'invoice_lines', params.documentId);
    await deleteInvoiceRowById(admin, invoiceId);
    throw new Error(
      `Failed to insert canonical invoice lines for ${params.documentId}: ${insertedLines.error.message ?? 'unknown error'}`,
    );
  }

  const insertedLineRow = insertedLines.rows[0] ?? null;
  if (
    !insertedLineRow
    || (!('source_document_id' in insertedLineRow) && !('document_id' in insertedLineRow))
  ) {
    await deleteDocumentScopedRows(admin, 'invoice_lines', params.documentId);
    await deleteInvoiceRowById(admin, invoiceId);
    return {
      persisted: false,
      skipped: true,
      reason: 'schema_mismatch',
      invoiceCount: 0,
      lineCount: 0,
    };
  }

  return {
    persisted: true,
    skipped: false,
    invoiceCount: 1,
    lineCount: insertedLines.rows.length,
  };
}

export async function getCanonicalInvoicesForProject(params: {
  projectId: string;
  documentIds?: readonly string[];
  admin?: SupabaseClient | null;
}): Promise<CanonicalProjectInvoiceData> {
  const admin = params.admin ?? getSupabaseAdmin();
  if (!admin) {
    return { invoices: [], invoiceLines: [] };
  }

  const documentIds = params.documentIds ?? [];

  const projectInvoicesResult = await admin
    .from('invoices')
    .select('*')
    .eq('project_id', params.projectId);

  if (isInvoicePersistenceTableUnavailableError(projectInvoicesResult.error)) {
    return { invoices: [], invoiceLines: [] };
  }

  const shouldFallbackInvoices =
    documentIds.length > 0 &&
    (
      (
        projectInvoicesResult.error != null &&
        isMissingColumnError(projectInvoicesResult.error, 'project_id')
      ) ||
      (
        projectInvoicesResult.error == null &&
        Array.isArray(projectInvoicesResult.data) &&
        projectInvoicesResult.data.length === 0
      )
    );

  const invoicesResult = shouldFallbackInvoices
    ? await loadInvoicesByDocumentIds(admin, documentIds)
    : projectInvoicesResult;

  if (invoicesResult.error && isInvoicePersistenceTableUnavailableError(invoicesResult.error)) {
    return { invoices: [], invoiceLines: [] };
  }
  if (invoicesResult.error) {
    throw new Error(`Failed to load canonical invoices for ${params.projectId}: ${invoicesResult.error.message}`);
  }

  const invoices = Array.isArray(invoicesResult.data)
    ? invoicesResult.data
        .map((row) => asRecord(row))
        .filter((row): row is Record<string, unknown> => row != null)
    : [];
  const invoiceIds = invoices
    .map((row) => asString(row.id) ?? asString(row.invoice_id))
    .filter((value): value is string => value != null);

  const projectLinesResult = await admin
    .from('invoice_lines')
    .select('*')
    .eq('project_id', params.projectId);

  if (isInvoicePersistenceTableUnavailableError(projectLinesResult.error)) {
    return { invoices, invoiceLines: [] };
  }

  const shouldFallbackLinesByInvoiceId =
    invoiceIds.length > 0 &&
    (
      (
        projectLinesResult.error != null &&
        isMissingColumnError(projectLinesResult.error, 'project_id')
      ) ||
      (
        projectLinesResult.error == null &&
        Array.isArray(projectLinesResult.data) &&
        projectLinesResult.data.length === 0
      )
    );

  let invoiceLinesResult = shouldFallbackLinesByInvoiceId
    ? await loadInvoiceLinesByInvoiceIds(admin, invoiceIds)
    : projectLinesResult;

  const shouldFallbackLinesByDocument =
    documentIds.length > 0 &&
    (
      (
        invoiceLinesResult.error != null &&
        (
          isMissingColumnError(invoiceLinesResult.error, 'invoice_id') ||
          isMissingColumnError(invoiceLinesResult.error, 'project_id')
        )
      ) ||
      (
        invoiceLinesResult.error == null &&
        Array.isArray(invoiceLinesResult.data) &&
        invoiceLinesResult.data.length === 0
      )
    );

  if (shouldFallbackLinesByDocument) {
    invoiceLinesResult = await loadInvoiceLinesByDocumentIds(admin, documentIds);
  }

  if (invoiceLinesResult.error && isInvoicePersistenceTableUnavailableError(invoiceLinesResult.error)) {
    return { invoices, invoiceLines: [] };
  }
  if (invoiceLinesResult.error) {
    throw new Error(`Failed to load canonical invoice lines for ${params.projectId}: ${invoiceLinesResult.error.message}`);
  }

  const invoiceLines = Array.isArray(invoiceLinesResult.data)
    ? invoiceLinesResult.data
        .map((row) => asRecord(row))
        .filter((row): row is Record<string, unknown> => row != null)
        .map((row) => enrichCanonicalInvoiceLineRow(row))
    : [];
  const enrichedInvoices = invoices.map((row) => enrichCanonicalInvoiceRow({
    row,
    invoiceLines,
  }));

  return {
    invoices: enrichedInvoices,
    invoiceLines,
  };
}
