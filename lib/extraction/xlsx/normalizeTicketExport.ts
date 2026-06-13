import type { ExtractionGap } from '@/lib/extraction/types';
import type { DetectSheetsResult } from '@/lib/extraction/xlsx/detectSheets';
import type { WorkbookParseResult, WorkbookSheetModel } from '@/lib/extraction/xlsx/parseWorkbook';

/** Logical ticket fields mapped to workbook columns for grounding. */
export type TicketFieldKey =
  | 'ticket_id'
  | 'quantity'
  | 'rate'
  | 'unit'
  | 'invoice_number'
  | 'contract_line_item';

export interface NormalizedTicketRow {
  id: string;
  sheet_key: string;
  sheet_name: string;
  row_number: number;
  ticket_id: string | null;
  quantity: number | null;
  unit: string | null;
  rate: number | null;
  invoice_number: string | null;
  contract_line_item: string | null;
  /** Row-level sheet_row evidence id (matches buildSpreadsheetEvidence sheet_row ids). */
  evidence_ref: string;
  /** Resolved header label per field; null when no column was matched for that field. */
  column_headers: Record<TicketFieldKey, string | null>;
  /** Per-field sheet_cell evidence ids (present when the column exists, including empty cells). */
  field_evidence_ids: Partial<Record<TicketFieldKey, string>>;
  confidence: number;
  missing_fields: string[];
}

export interface TicketExportNormalizationResult {
  family: 'ticket';
  sheets: Array<{
    sheet_name: string;
    row_count: number;
    missing_quantity_rows: number;
    missing_rate_rows: number;
  }>;
  rows: NormalizedTicketRow[];
  summary: {
    row_count: number;
    missing_quantity_rows: number;
    missing_rate_rows: number;
  };
  confidence: number;
  gaps: ExtractionGap[];
}

const COLUMN_ALIASES = {
  ticket_id: ['ticket', 'ticket id', 'ticket number', 'load ticket'],
  quantity: ['quantity', 'qty', 'net qty', 'cy', 'tons', 'total qty'],
  unit: ['unit', 'uom', 'measure'],
  rate: ['rate', 'unit price', 'price', 'unit rate'],
  invoice_number: ['invoice', 'invoice #', 'invoice number'],
  contract_line_item: ['line item', 'line', 'clin', 'item code'],
} as const;

function buildGap(input: Omit<ExtractionGap, 'id' | 'source'>): ExtractionGap {
  return {
    id: `gap:${input.category}:${input.sheet ?? 'ticket_export'}:${input.row ?? '0'}`,
    source: 'xlsx',
    ...input,
  };
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function findColumn(sheet: WorkbookSheetModel, aliases: readonly string[]): string | null {
  const match = sheet.headers.find((header) => {
    const normalized = normalizeHeader(header);
    return aliases.some((alias) => normalized.includes(alias));
  });
  return match ?? null;
}

function parseNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/[$,]/g, '').trim();
  if (trimmed.length === 0) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/** Stable id shared with buildSpreadsheetEvidence for sheet_cell rows. */
export function ticketCellEvidenceId(
  sheetKey: string,
  rowNumber: number,
  columnHeader: string,
  headers: string[],
): string {
  const columnIndex = headers.indexOf(columnHeader);
  const c = columnIndex >= 0 ? columnIndex : 0;
  return `cell:${sheetKey}:r${rowNumber}:c${c}`;
}

export function neighborCellContext(
  row: WorkbookSheetModel['rows'][number],
  headers: string[],
  focusHeader: string | null,
  maxPairs = 4,
): string {
  if (!focusHeader) {
    return headers
      .map((h) => `${h}: ${row.values[h] ?? ''}`)
      .filter((pair) => !pair.endsWith(': '))
      .slice(0, maxPairs)
      .join(' | ');
  }
  const idx = headers.indexOf(focusHeader);
  const indices: number[] = [];
  if (idx >= 0) indices.push(idx);
  for (let d = 1; d <= 3 && indices.length < maxPairs; d += 1) {
    if (idx - d >= 0) indices.unshift(idx - d);
    if (idx + d < headers.length) indices.push(idx + d);
  }
  return indices
    .slice(0, maxPairs)
    .map((i) => `${headers[i]}: ${row.values[headers[i]] ?? ''}`)
    .join(' | ');
}

export function normalizeTicketExport(params: {
  workbook: WorkbookParseResult;
  detectedSheets: DetectSheetsResult;
}): TicketExportNormalizationResult | null {
  const ticketSheets = params.detectedSheets.sheets.filter((sheet) => sheet.classification === 'ticket_export');
  if (ticketSheets.length === 0) return null;

  const rows: NormalizedTicketRow[] = [];
  const gaps: ExtractionGap[] = [];
  const sheetSummaries: TicketExportNormalizationResult['sheets'] = [];

  for (const detectedSheet of ticketSheets) {
    const sheet = params.workbook.sheets.find((candidate) => candidate.key === detectedSheet.sheet_key);
    if (!sheet) continue;

    const ticketColumn = findColumn(sheet, COLUMN_ALIASES.ticket_id);
    const quantityColumn = findColumn(sheet, COLUMN_ALIASES.quantity);
    const unitColumn = findColumn(sheet, COLUMN_ALIASES.unit);
    const rateColumn = findColumn(sheet, COLUMN_ALIASES.rate);
    const invoiceColumn = findColumn(sheet, COLUMN_ALIASES.invoice_number);
    const lineItemColumn = findColumn(sheet, COLUMN_ALIASES.contract_line_item);

    const columnHeaders: Record<TicketFieldKey, string | null> = {
      ticket_id: ticketColumn,
      quantity: quantityColumn,
      unit: unitColumn,
      rate: rateColumn,
      invoice_number: invoiceColumn,
      contract_line_item: lineItemColumn,
    };

    let missingQuantityRows = 0;
    let missingRateRows = 0;

    sheet.rows.forEach((row, index) => {
      const ticketId = ticketColumn ? parseText(row.values[ticketColumn]) : null;
      const quantity = quantityColumn ? parseNumber(row.values[quantityColumn]) : null;
      const unit = unitColumn ? parseText(row.values[unitColumn]) : null;
      const rate = rateColumn ? parseNumber(row.values[rateColumn]) : null;
      const invoiceNumber = invoiceColumn ? parseText(row.values[invoiceColumn]) : null;
      const contractLineItem = lineItemColumn ? parseText(row.values[lineItemColumn]) : null;
      const missingFields = [
        !ticketId ? 'ticket_id' : null,
        quantity == null ? 'quantity' : null,
        rate == null ? 'rate' : null,
      ].filter((field): field is string => Boolean(field));

      if (missingFields.includes('quantity')) missingQuantityRows += 1;
      if (missingFields.includes('rate')) missingRateRows += 1;

      const fieldEvidenceIds: Partial<Record<TicketFieldKey, string>> = {};
      const assign = (key: TicketFieldKey, header: string | null) => {
        if (!header) return;
        fieldEvidenceIds[key] = ticketCellEvidenceId(sheet.key, row.row_number, header, sheet.headers);
      };
      assign('ticket_id', ticketColumn);
      assign('quantity', quantityColumn);
      assign('unit', unitColumn);
      assign('rate', rateColumn);
      assign('invoice_number', invoiceColumn);
      assign('contract_line_item', lineItemColumn);

      rows.push({
        id: `ticket:${sheet.key}:${row.row_number}`,
        sheet_key: sheet.key,
        sheet_name: sheet.name,
        row_number: row.row_number,
        ticket_id: ticketId,
        quantity,
        unit,
        rate,
        invoice_number: invoiceNumber,
        contract_line_item: contractLineItem,
        evidence_ref: `sheet:${sheet.key}:row:${row.row_number}`,
        column_headers: { ...columnHeaders },
        field_evidence_ids: fieldEvidenceIds,
        confidence: Number((0.45 + Math.max(0, 0.12 * (3 - missingFields.length)) + (detectedSheet.confidence * 0.2)).toFixed(3)),
        missing_fields: missingFields,
      });

      if (missingFields.length > 0 && index < 10) {
        const nearby = neighborCellContext(row, sheet.headers, quantityColumn ?? rateColumn ?? ticketColumn);
        gaps.push(buildGap({
          category: 'ticket_row_missing_support',
          severity: missingFields.includes('quantity') ? 'warning' : 'info',
          message: `Ticket row is missing ${missingFields.join(', ')} support.`,
          sheet: sheet.name,
          row: row.row_number,
          nearby_text: nearby || undefined,
        }));
      }
    });

    sheetSummaries.push({
      sheet_name: sheet.name,
      row_count: sheet.rows.length,
      missing_quantity_rows: missingQuantityRows,
      missing_rate_rows: missingRateRows,
    });
  }

  const summary = {
    row_count: rows.length,
    missing_quantity_rows: rows.filter((row) => row.missing_fields.includes('quantity')).length,
    missing_rate_rows: rows.filter((row) => row.missing_fields.includes('rate')).length,
  };

  const confidence = rows.length > 0
    ? Number((rows.reduce((sum, row) => sum + row.confidence, 0) / rows.length).toFixed(3))
    : 0;

  return {
    family: 'ticket',
    sheets: sheetSummaries,
    rows,
    summary,
    confidence,
    gaps,
  };
}
