import type { SupabaseClient } from '@supabase/supabase-js';

import type { TicketExportNormalizationResult } from '@/lib/extraction/xlsx/normalizeTicketExport';
import type { TicketExtraction } from '@/lib/types/documentIntelligence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { withStageTimeout } from '@/lib/server/stageTimeout';

const SUPPORT_DELETE_TIMEOUT_MS = 60_000;
const SUPPORT_INSERT_TIMEOUT_MS = 60_000;

type TableError = {
  code?: string | null;
  message?: string | null;
} | null | undefined;

type PersistTargetTable = 'mobile_tickets' | 'load_tickets';

type SupportInsertResult = {
  error: TableError;
  rows: Array<Record<string, unknown>>;
};

type CanonicalSupportInsert = {
  table: PersistTargetTable;
  row: Record<string, unknown>;
};

export type PersistCanonicalSupportResult = {
  persisted: boolean;
  skipped: boolean;
  reason?:
    | 'missing_admin'
    | 'missing_project_id'
    | 'no_support_rows'
    | 'missing_table'
    | 'schema_mismatch';
  mobileTicketCount: number;
  loadTicketCount: number;
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
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[$,]/g, '').trim();
  if (cleaned.length === 0) return null;

  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
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

export function isSupportPersistenceTableUnavailableError(error: TableError): boolean {
  if (!error) return false;

  const code = error.code ?? '';
  const message = (error.message ?? '').toLowerCase();

  if (code === '42P01' || code === 'PGRST205') {
    return true;
  }

  return (
    message.includes('could not find the table') ||
    /(?:relation|table)\s+"?(?:public\.)?(mobile_tickets|load_tickets)"?\s+does not exist/.test(message)
  );
}

function readNormalizedTicketExport(
  extractionData: Record<string, unknown> | null | undefined,
): TicketExportNormalizationResult | null {
  const root = asRecord(extractionData);
  const extraction = asRecord(root?.extraction);
  const contentLayers = asRecord(extraction?.content_layers_v1);
  const spreadsheet = asRecord(contentLayers?.spreadsheet);
  const normalized = asRecord(spreadsheet?.normalized_ticket_export);
  if (!normalized) return null;

  const rows = Array.isArray(normalized.rows) ? normalized.rows : null;
  if (!rows || rows.length === 0) return null;

  return normalized as unknown as TicketExportNormalizationResult;
}

function readTicketExtraction(
  extracted: Record<string, unknown> | null | undefined,
): TicketExtraction | null {
  const ticket = asRecord(extracted);
  if (!ticket) return null;

  const looksLikeTicket =
    asString(ticket.ticketId) != null ||
    asString(ticket.ticket_id) != null ||
    asNumber(ticket.quantityCY) != null ||
    asNumber(ticket.quantity_cy) != null ||
    asString(ticket.disposalSite) != null ||
    asString(ticket.disposal_site) != null ||
    asString(ticket.material) != null ||
    asString(ticket.contractor) != null;

  return looksLikeTicket ? (ticket as unknown as TicketExtraction) : null;
}

function workbookSupportRows(params: {
  documentId: string;
  projectId: string;
  organizationId?: string | null;
  ticketExport: TicketExportNormalizationResult;
}): CanonicalSupportInsert[] {
  return params.ticketExport.rows.map((row) => {
    const ticketId = row.ticket_id ?? `ticket:${row.sheet_key}:${row.row_number}`;
    const isUnitTicket = row.ticket_family === 'mobile_unit_ticket';
    const table = isUnitTicket ? 'load_tickets' : 'mobile_tickets';
    const sourceWorkDescriptor = isUnitTicket
      ? row.service_item ?? null
      : row.material ?? null;

    const record: Record<string, unknown> = {
      project_id: params.projectId,
      source_document_id: params.documentId,
      document_id: params.documentId,
      mobile_ticket_id: isUnitTicket ? null : ticketId,
      load_ticket_id: isUnitTicket ? ticketId : null,
      ticket_id: ticketId,
      ticket_number: row.ticket_id ?? null,
      mobile_ticket_number: isUnitTicket ? null : row.ticket_id ?? null,
      load_ticket_number: isUnitTicket ? row.ticket_id ?? null : null,
      quantity_cyd: row.quantity,
      quantity_cy: row.quantity,
      quantityCY: row.quantity,
      rate: row.rate,
      unit: row.unit,
      invoice_number: row.invoice_number,
      contract_line_item: row.contract_line_item,
      material: row.material ?? null,
      material_type: row.material ?? null,
      debris_type: row.material ?? null,
      service_item: row.service_item ?? null,
      ticket_family: row.ticket_family,
      source_work_descriptor: sourceWorkDescriptor,
      source_sheet_name: row.sheet_name,
      source_row_number: row.row_number,
      evidence_ref: row.evidence_ref,
      confidence: row.confidence,
      missing_fields: row.missing_fields,
      column_headers: row.column_headers,
      field_evidence_ids: row.field_evidence_ids,
      row_json: row,
      raw_row_json: row,
      record_json: row,
    };

    if (params.organizationId) {
      record.organization_id = params.organizationId;
    }

    return {
      table,
      row: record,
    };
  });
}

function ticketDocumentRows(params: {
  documentId: string;
  projectId: string;
  organizationId?: string | null;
  extracted: TicketExtraction;
}): CanonicalSupportInsert[] {
  const ticketId = params.extracted.ticketId ?? params.documentId;

  const record: Record<string, unknown> = {
    project_id: params.projectId,
    source_document_id: params.documentId,
    document_id: params.documentId,
    mobile_ticket_id: ticketId,
    ticket_id: ticketId,
    ticket_number: params.extracted.ticketId ?? null,
    mobile_ticket_number: params.extracted.ticketId ?? null,
    quantity_cyd: params.extracted.quantityCY ?? null,
    quantity_cy: params.extracted.quantityCY ?? null,
    quantityCY: params.extracted.quantityCY ?? null,
    contractor_name: params.extracted.contractor ?? null,
    contractor: params.extracted.contractor ?? null,
    vendor_name: params.extracted.contractor ?? null,
    subcontractor: params.extracted.subcontractor ?? null,
    disposal_site: params.extracted.disposalSite ?? null,
    disposal_facility: params.extracted.disposalSite ?? null,
    dump_site: params.extracted.disposalSite ?? null,
    material: params.extracted.material ?? null,
    material_type: params.extracted.material ?? null,
    debris_type: params.extracted.material ?? null,
    ticket_family: 'mobile_ticket',
    source_work_descriptor: params.extracted.material ?? null,
    mileage: params.extracted.mileage ?? null,
    truck_id: params.extracted.truckId ?? null,
    truck_capacity: params.extracted.truckCapacity ?? null,
    project_code: params.extracted.projectCode ?? null,
    ticket_project_code: params.extracted.projectCode ?? null,
    row_json: params.extracted,
    raw_row_json: params.extracted,
    record_json: params.extracted,
  };

  if (params.organizationId) {
    record.organization_id = params.organizationId;
  }

  return [{
    table: 'mobile_tickets',
    row: record,
  }];
}

function buildSupportRows(params: {
  documentId: string;
  projectId: string;
  organizationId?: string | null;
  extractionData: Record<string, unknown> | null | undefined;
  extracted: Record<string, unknown> | null | undefined;
}): CanonicalSupportInsert[] {
  const ticketExport = readNormalizedTicketExport(params.extractionData);
  if (ticketExport) {
    return workbookSupportRows({
      documentId: params.documentId,
      projectId: params.projectId,
      organizationId: params.organizationId,
      ticketExport,
    });
  }

  const ticket = readTicketExtraction(params.extracted);
  if (ticket) {
    return ticketDocumentRows({
      documentId: params.documentId,
      projectId: params.projectId,
      organizationId: params.organizationId,
      extracted: ticket,
    });
  }

  return [];
}

async function deleteDocumentScopedRows(
  admin: SupabaseClient,
  table: PersistTargetTable,
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
      SUPPORT_DELETE_TIMEOUT_MS,
    );

    if (!error) {
      hadScopeColumn = true;
      continue;
    }

    if (isSupportPersistenceTableUnavailableError(error)) {
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

async function insertWithOptionalColumnFallback(
  admin: SupabaseClient,
  params: {
    table: PersistTargetTable;
    rows: Array<Record<string, unknown>>;
    optionalColumns: readonly string[];
  },
): Promise<SupportInsertResult> {
  let rows = params.rows.map((row) => ({ ...row }));
  const optionalColumns = new Set(
    params.optionalColumns.filter((column) => rows.some((row) => column in row)),
  );

  while (true) {
    const { error } = await withStageTimeout(
      admin
        .from(params.table)
        .insert(rows),
      `${params.table} insert`,
      SUPPORT_INSERT_TIMEOUT_MS,
    );

    if (!error) {
      return { error: null, rows };
    }

    const missingColumn = extractMissingColumnName(error);
    if (!missingColumn || !optionalColumns.has(missingColumn)) {
      return { error, rows };
    }

    rows = rows.map((row) => {
      const next = { ...row };
      delete next[missingColumn];
      return next;
    });
    optionalColumns.delete(missingColumn);
  }
}

export async function persistCanonicalSupportForDocument(params: {
  admin?: SupabaseClient | null;
  documentId: string;
  projectId?: string | null;
  organizationId?: string | null;
  extractionData: Record<string, unknown> | null | undefined;
  extracted: Record<string, unknown> | null | undefined;
}): Promise<PersistCanonicalSupportResult> {
  const admin = params.admin ?? getSupabaseAdmin();
  if (!admin) {
    return { persisted: false, skipped: true, reason: 'missing_admin', mobileTicketCount: 0, loadTicketCount: 0 };
  }
  if (!params.projectId) {
    return { persisted: false, skipped: true, reason: 'missing_project_id', mobileTicketCount: 0, loadTicketCount: 0 };
  }

  const supportRows = buildSupportRows({
    documentId: params.documentId,
    projectId: params.projectId,
    organizationId: params.organizationId,
    extractionData: params.extractionData,
    extracted: params.extracted,
  });
  if (supportRows.length === 0) {
    return { persisted: false, skipped: true, reason: 'no_support_rows', mobileTicketCount: 0, loadTicketCount: 0 };
  }

  const groupedByTable = new Map<PersistTargetTable, Array<Record<string, unknown>>>();
  for (const row of supportRows) {
    const existing = groupedByTable.get(row.table) ?? [];
    existing.push(row.row);
    groupedByTable.set(row.table, existing);
  }

  for (const table of groupedByTable.keys()) {
    const deleted = await deleteDocumentScopedRows(admin, table, params.documentId);
    if (!deleted.ok) {
      return {
        persisted: false,
        skipped: true,
        reason: deleted.reason,
        mobileTicketCount: 0,
        loadTicketCount: 0,
      };
    }
  }

  for (const [table, rows] of groupedByTable.entries()) {
    const inserted = await insertWithOptionalColumnFallback(admin, {
      table,
      rows,
      optionalColumns: [
        'organization_id',
        'source_document_id',
        'document_id',
        'mobile_ticket_id',
        'load_ticket_id',
        'ticket_id',
        'ticket_number',
        'mobile_ticket_number',
        'load_ticket_number',
        'quantity_cyd',
        'quantity_cy',
        'quantityCY',
        'rate',
        'unit',
        'invoice_number',
        'contract_line_item',
        'source_sheet_name',
        'source_row_number',
        'evidence_ref',
        'confidence',
        'missing_fields',
        'column_headers',
        'field_evidence_ids',
        'row_json',
        'raw_row_json',
        'record_json',
        'contractor_name',
        'contractor',
        'vendor_name',
        'subcontractor',
        'disposal_site',
        'disposal_facility',
        'dump_site',
        'material',
        'material_type',
        'debris_type',
        'service_item',
        'ticket_family',
        'source_work_descriptor',
        'mileage',
        'truck_id',
        'truck_capacity',
        'project_code',
        'ticket_project_code',
      ],
    });

    if (isSupportPersistenceTableUnavailableError(inserted.error)) {
      return {
        persisted: false,
        skipped: true,
        reason: 'missing_table',
        mobileTicketCount: 0,
        loadTicketCount: 0,
      };
    }
    if (inserted.error) {
      if (isMissingColumnError(inserted.error)) {
        return {
          persisted: false,
          skipped: true,
          reason: 'schema_mismatch',
          mobileTicketCount: 0,
          loadTicketCount: 0,
        };
      }
      throw new Error(`Failed to insert ${table} rows for ${params.documentId}: ${inserted.error.message}`);
    }
  }

  return {
    persisted: true,
    skipped: false,
    mobileTicketCount: groupedByTable.get('mobile_tickets')?.length ?? 0,
    loadTicketCount: groupedByTable.get('load_tickets')?.length ?? 0,
  };
}
