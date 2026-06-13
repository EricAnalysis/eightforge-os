import type { EvidenceObject, ExtractionGap, EvidenceValue } from '@/lib/extraction/types';
import type { DetectSheetsResult } from '@/lib/extraction/xlsx/detectSheets';
import type { WorkbookParseResult } from '@/lib/extraction/xlsx/parseWorkbook';
import type { TicketFieldKey, TicketExportNormalizationResult } from '@/lib/extraction/xlsx/normalizeTicketExport';
import { neighborCellContext } from '@/lib/extraction/xlsx/normalizeTicketExport';
import type { TransactionDataNormalizationResult } from '@/lib/extraction/xlsx/normalizeTransactionData';
import { TRANSACTION_DATA_FIELD_LABELS } from '@/lib/types/transactionData';
import type { TransactionDataFieldKey } from '@/lib/types/transactionData';

export interface SpreadsheetEvidenceResult {
  evidence: EvidenceObject[];
  confidence: number;
  gaps: ExtractionGap[];
}

function uniqueGaps(gaps: ExtractionGap[]): ExtractionGap[] {
  const seen = new Set<string>();
  return gaps.filter((gap) => {
    const key = `${gap.category}:${gap.sheet ?? 'workbook'}:${gap.row ?? '0'}:${gap.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const FIELD_LABELS: Record<TicketFieldKey, string> = {
  ticket_id: 'Ticket ID',
  quantity: 'Quantity',
  rate: 'Rate',
  unit: 'Unit',
  invoice_number: 'Invoice number',
  contract_line_item: 'Contract line',
};

function sheetConfidenceForKey(
  sheetKey: string,
  workbook: WorkbookParseResult,
  detectedSheets: DetectSheetsResult,
): number {
  const detected = detectedSheets.sheets.find((candidate) => candidate.sheet_key === sheetKey);
  return detected?.confidence ?? workbook.confidence;
}

function toEvidenceValue(raw: unknown): EvidenceValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') return raw;
  return String(raw);
}

function buildTicketCellEvidence(params: {
  docId: string;
  path: string;
  workbook: WorkbookParseResult;
  detectedSheets: DetectSheetsResult;
  ticketExport: TicketExportNormalizationResult;
}): EvidenceObject[] {
  const { docId, path, workbook, detectedSheets, ticketExport } = params;
  const out: EvidenceObject[] = [];
  const seenIds = new Set<string>();

  for (const ticketRow of ticketExport.rows) {
    const sheet = workbook.sheets.find((s) => s.key === ticketRow.sheet_key);
    if (!sheet) continue;
    const wbRow = sheet.rows.find((r) => r.row_number === ticketRow.row_number);
    if (!wbRow) continue;
    const sheetConfidence = sheetConfidenceForKey(sheet.key, workbook, detectedSheets);

    const fieldKeys = Object.keys(ticketRow.field_evidence_ids) as TicketFieldKey[];
    for (const fieldKey of fieldKeys) {
      const evidenceId = ticketRow.field_evidence_ids[fieldKey];
      const header = ticketRow.column_headers[fieldKey];
      if (!evidenceId || !header) continue;
      if (seenIds.has(evidenceId)) continue;
      seenIds.add(evidenceId);

      const raw = wbRow.values[header];
      const hasValue = raw !== null && raw !== undefined && String(raw).trim() !== '';
      const nearby = neighborCellContext(wbRow, sheet.headers, header);
      const colIndex = sheet.headers.indexOf(header);

      out.push({
        id: evidenceId,
        kind: 'sheet_cell',
        source_type: 'xlsx',
        source_document_id: docId,
        description: `${FIELD_LABELS[fieldKey]} — ${sheet.name}, row ${ticketRow.row_number}, column "${header}"`,
        text: hasValue ? `${header}: ${String(raw)}` : `${header}: (empty)`,
        value: toEvidenceValue(raw),
        location: {
          sheet: sheet.name,
          row: ticketRow.row_number,
          column: header,
          column_index: colIndex >= 0 ? colIndex : undefined,
          header_context: sheet.headers,
          nearby_text: nearby || undefined,
          label: FIELD_LABELS[fieldKey],
        },
        confidence: hasValue
          ? Math.min(0.94, sheetConfidence + 0.06)
          : Math.max(0.35, sheetConfidence - 0.12),
        weak: !hasValue || sheetConfidence < 0.55,
        metadata: {
          source_document_id: docId,
          source_extraction_path: path,
          field_key: fieldKey,
          sheet_key: sheet.key,
          matched_header: header,
          ticket_row_id: ticketRow.id,
          row_evidence_id: ticketRow.evidence_ref,
        },
      });
    }
  }

  return out;
}

function buildTransactionDataCellEvidence(params: {
  docId: string;
  path: string;
  workbook: WorkbookParseResult;
  detectedSheets: DetectSheetsResult;
  transactionData: TransactionDataNormalizationResult;
}): EvidenceObject[] {
  const { docId, path, workbook, detectedSheets, transactionData } = params;
  const out: EvidenceObject[] = [];
  const seenIds = new Set<string>();

  for (const record of transactionData.records) {
    const sheet = workbook.sheets.find((candidate) => candidate.name === record.source_sheet_name);
    if (!sheet) continue;

    const wbRow = sheet.rows.find((candidate) => candidate.row_number === record.source_row_number);
    if (!wbRow) continue;

    const sheetConfidence = sheetConfidenceForKey(sheet.key, workbook, detectedSheets);
    const fieldKeys = Object.keys(record.field_evidence_ids) as TransactionDataFieldKey[];

    for (const fieldKey of fieldKeys) {
      const evidenceId = record.field_evidence_ids[fieldKey];
      const header = record.column_headers[fieldKey];
      if (!evidenceId || !header) continue;
      if (seenIds.has(evidenceId)) continue;
      seenIds.add(evidenceId);

      const raw = wbRow.values[header];
      const hasValue = raw !== null && raw !== undefined && String(raw).trim() !== '';
      const nearby = neighborCellContext(wbRow, sheet.headers, header);
      const colIndex = sheet.headers.indexOf(header);

      out.push({
        id: evidenceId,
        kind: 'sheet_cell',
        source_type: 'xlsx',
        source_document_id: docId,
        description: `${TRANSACTION_DATA_FIELD_LABELS[fieldKey]} - ${sheet.name}, row ${record.source_row_number}, column "${header}"`,
        text: hasValue ? `${header}: ${String(raw)}` : `${header}: (empty)`,
        value: toEvidenceValue(raw),
        location: {
          sheet: sheet.name,
          row: record.source_row_number,
          column: header,
          column_index: colIndex >= 0 ? colIndex : undefined,
          header_context: sheet.headers,
          nearby_text: nearby || undefined,
          label: TRANSACTION_DATA_FIELD_LABELS[fieldKey],
        },
        confidence: hasValue
          ? Math.min(0.94, sheetConfidence + 0.05)
          : Math.max(0.35, sheetConfidence - 0.12),
        weak: !hasValue || sheetConfidence < 0.55,
        metadata: {
          source_document_id: docId,
          source_extraction_path: path,
          field_key: fieldKey,
          sheet_key: sheet.key,
          matched_header: header,
          transaction_record_id: record.id,
          row_evidence_id: record.evidence_ref,
        },
      });
    }
  }

  return out;
}

export function buildSpreadsheetEvidence(params: {
  sourceDocumentId: string;
  workbook: WorkbookParseResult;
  detectedSheets: DetectSheetsResult;
  ticketExport?: TicketExportNormalizationResult | null;
  transactionData?: TransactionDataNormalizationResult | null;
}): SpreadsheetEvidenceResult {
  const docId = params.sourceDocumentId;
  const path = 'xlsx_workbook';
  const evidence: EvidenceObject[] = [];

  params.workbook.sheets.forEach((sheet) => {
    const detected = params.detectedSheets.sheets.find((candidate) => candidate.sheet_key === sheet.key);
    const sheetConfidence = detected?.confidence ?? params.workbook.confidence;

    evidence.push({
      id: `sheet:${sheet.key}`,
      kind: 'sheet',
      source_type: 'xlsx',
      source_document_id: docId,
      description: `Workbook sheet ${sheet.name}`,
      text: sheet.preview_text,
      location: {
        sheet: sheet.name,
        header_context: sheet.headers,
      },
      confidence: sheetConfidence,
      weak: sheetConfidence < 0.55,
      metadata: {
        source_document_id: docId,
        source_extraction_path: path,
        classification: detected?.classification ?? 'unknown',
        row_count: sheet.row_count,
        sheet_key: sheet.key,
      },
    });

    sheet.rows.forEach((row) => {
      const pairs = sheet.headers
        .map((header) => [header, row.values[header]] as const)
        .filter(([, value]) => value !== null)
        .slice(0, 8)
        .map(([header, value]) => `${header}: ${String(value)}`);
      evidence.push({
        id: `sheet:${sheet.key}:row:${row.row_number}`,
        kind: 'sheet_row',
        source_type: 'xlsx',
        source_document_id: docId,
        description: `Sheet ${sheet.name} row ${row.row_number}`,
        text: pairs.join(' | '),
        location: {
          sheet: sheet.name,
          row: row.row_number,
          header_context: sheet.headers,
          nearby_text: pairs.length > 0 ? pairs.join(' | ') : undefined,
        },
        confidence: Math.min(0.96, sheetConfidence + (pairs.length >= 3 ? 0.08 : 0)),
        weak: pairs.length < 2,
        metadata: {
          source_document_id: docId,
          source_extraction_path: path,
          sheet_key: sheet.key,
        },
      });
    });
  });

  if (params.ticketExport) {
    evidence.push(
      ...buildTicketCellEvidence({
        docId,
        path,
        workbook: params.workbook,
        detectedSheets: params.detectedSheets,
        ticketExport: params.ticketExport,
      }),
    );
  }

  if (params.transactionData) {
    evidence.push(
      ...buildTransactionDataCellEvidence({
        docId,
        path,
        workbook: params.workbook,
        detectedSheets: params.detectedSheets,
        transactionData: params.transactionData,
      }),
    );
  }

  const contributingScores = [
    params.workbook.confidence,
    params.detectedSheets.confidence,
    params.ticketExport?.confidence,
    params.transactionData?.confidence,
  ].filter((score): score is number => typeof score === 'number' && score > 0);

  return {
    evidence,
    confidence: contributingScores.length > 0
      ? Number((contributingScores.reduce((sum, score) => sum + score, 0) / contributingScores.length).toFixed(3))
      : 0,
    gaps: uniqueGaps([
      ...params.workbook.gaps,
      ...params.detectedSheets.gaps,
      ...(params.ticketExport?.gaps ?? []),
      ...(params.transactionData?.gaps ?? []),
    ]),
  };
}
