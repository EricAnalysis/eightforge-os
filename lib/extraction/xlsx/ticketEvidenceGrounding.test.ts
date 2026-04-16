import { describe, expect, it } from 'vitest';
import { buildSpreadsheetEvidence } from '@/lib/extraction/xlsx/buildSpreadsheetEvidence';
import { normalizeTicketExport, ticketCellEvidenceId } from '@/lib/extraction/xlsx/normalizeTicketExport';
import type { DetectSheetsResult } from '@/lib/extraction/xlsx/detectSheets';
import type { WorkbookParseResult } from '@/lib/extraction/xlsx/parseWorkbook';

const fixtureWorkbook: WorkbookParseResult = {
  parser_version: 'workbook_v1',
  sheet_count: 1,
  sheets: [
    {
      key: 'sheet_loads',
      name: 'Loads',
      header_row_number: 1,
      headers: ['Ticket', 'Qty', 'Rate', 'Invoice #'],
      row_count: 1,
      column_count: 4,
      rows: [
        {
          row_number: 42,
          cells: [],
          values: {
            Ticket: 'T-100',
            Qty: '',
            Rate: '125.5',
            'Invoice #': 'INV-204',
          },
        },
      ],
      preview_text: 'Ticket | Qty | Rate',
    },
  ],
  workbook_text_preview: '',
  confidence: 0.82,
  gaps: [],
};

const fixtureDetected: DetectSheetsResult = {
  sheets: [
    {
      sheet_key: 'sheet_loads',
      sheet_name: 'Loads',
      classification: 'ticket_export',
      confidence: 0.88,
      matched_headers: ['Qty', 'Rate', 'Ticket'],
    },
  ],
  confidence: 0.88,
  gaps: [],
};

describe('ticket export grounding', () => {
  it('assigns stable cell evidence ids per field including empty quantity', () => {
    const normalized = normalizeTicketExport({
      workbook: fixtureWorkbook,
      detectedSheets: fixtureDetected,
    });
    expect(normalized).not.toBeNull();
    const row = normalized!.rows[0];
    expect(row.sheet_name).toBe('Loads');
    expect(row.row_number).toBe(42);
    expect(row.column_headers.quantity).toBe('Qty');
    expect(row.column_headers.rate).toBe('Rate');
    expect(row.missing_fields).toContain('quantity');

    const headers = fixtureWorkbook.sheets[0].headers;
    const qtyId = ticketCellEvidenceId('sheet_loads', 42, 'Qty', headers);
    const rateId = ticketCellEvidenceId('sheet_loads', 42, 'Rate', headers);
    expect(row.field_evidence_ids.quantity).toBe(qtyId);
    expect(row.field_evidence_ids.rate).toBe(rateId);
    expect(row.evidence_ref).toBe('sheet:sheet_loads:row:42');
  });

  it('emits sheet_cell evidence objects aligned with normalization ids', () => {
    const normalized = normalizeTicketExport({
      workbook: fixtureWorkbook,
      detectedSheets: fixtureDetected,
    });
    const built = buildSpreadsheetEvidence({
      sourceDocumentId: 'doc_fixture',
      workbook: fixtureWorkbook,
      detectedSheets: fixtureDetected,
      ticketExport: normalized,
    });

    const byId = new Map(built.evidence.map((e) => [e.id, e]));
    const row = normalized!.rows[0];
    const qty = byId.get(row.field_evidence_ids.quantity!);
    const rate = byId.get(row.field_evidence_ids.rate!);

    expect(qty?.kind).toBe('sheet_cell');
    expect(qty?.location.sheet).toBe('Loads');
    expect(qty?.location.row).toBe(42);
    expect(qty?.location.column).toBe('Qty');
    expect(qty?.text).toContain('empty');
    expect(qty?.metadata).toMatchObject({ field_key: 'quantity', row_evidence_id: row.evidence_ref });

    expect(rate?.kind).toBe('sheet_cell');
    expect(rate?.location.column).toBe('Rate');
    expect(String(rate?.text)).toContain('125.5');
    expect(rate?.location.nearby_text).toBeTruthy();
  });
});
