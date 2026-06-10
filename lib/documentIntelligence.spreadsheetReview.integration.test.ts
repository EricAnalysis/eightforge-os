import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { utils, write } from 'xlsx';

import { buildDocumentIntelligenceViewModel } from '@/lib/documentIntelligenceViewModel';
import { detectSheets } from '@/lib/extraction/xlsx/detectSheets';
import { normalizeTransactionData } from '@/lib/extraction/xlsx/normalizeTransactionData';
import { parseWorkbook } from '@/lib/extraction/xlsx/parseWorkbook';

function workbookBytes(sheets: Array<{ name: string; rows: unknown[][] }>): ArrayBuffer {
  const workbook = utils.book_new();

  for (const sheet of sheets) {
    utils.book_append_sheet(workbook, utils.aoa_to_sheet(sheet.rows), sheet.name);
  }

  const buffer = write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function buildCurrentWorkbookRows(): unknown[][] {
  const fillerHeaders = Array.from({ length: 41 }, (_, index) => `Early Column ${index + 1}`);
  const transactionHeaders = [
    'Ticket ID',
    'Ticket No',
    'Discrepancy',
    'CYD',
    'Net Tonnage',
    'Invoice #',
    'Rate Code',
    'Transaction Quantity',
    'Extended Cost',
    'Ticket Notes',
    'Eligibility',
    'Service Item',
    'Material',
    'Disposal Site',
    'Site Type',
    'Project Name',
  ];

  const makeEarlyValues = (rowNumber: number) =>
    Array.from({ length: fillerHeaders.length }, (_, index) => `row-${rowNumber}-value-${index + 1}`);

  return [
    ['Current Workbook Export'],
    [...fillerHeaders, ...transactionHeaders],
    [
      ...makeEarlyValues(1),
      'TID-1001',
      'TK-1001',
      3,
      10,
      2.5,
      'INV-100',
      'RC-01',
      12,
      1000,
      'Late note 1',
      'Eligible',
      'Hauling',
      'Vegetative',
      'Alpha DMS',
      'DMS',
      'Williamson County',
    ],
    [
      ...makeEarlyValues(2),
      'TID-1002',
      'TK-1002',
      0,
      4,
      1.5,
      'INV-100',
      'RC-01',
      8,
      600,
      'Late note 2',
      'Ineligible',
      'Hauling',
      'Vegetative',
      'Alpha DMS',
      'DMS',
      'Williamson County',
    ],
    [
      ...makeEarlyValues(3),
      'TID-1002',
      'TK-1002',
      1,
      4,
      1.5,
      'INV-101',
      'RC-02',
      5,
      1200,
      'Late note 3',
      'Eligible',
      'Grinding',
      'C&D',
      'Beta Landfill',
      'Landfill',
      'Williamson County',
    ],
    [
      ...makeEarlyValues(4),
      'TID-1003',
      'TK-1003',
      2,
      null,
      1,
      '',
      'RC-03',
      3,
      800,
      'Late note 4',
      '',
      'Load Management',
      'Ash',
      '',
      'Temporary',
      'Williamson County',
    ],
  ];
}

describe('spreadsheet review integration', () => {
  it('keeps current-workbook metrics correct from parse through spreadsheet review inputs', async () => {
    const workbook = await parseWorkbook(
      workbookBytes([
        {
          name: 'ticket_query',
          rows: buildCurrentWorkbookRows(),
        },
      ]),
    );

    assert.equal(workbook.row_limit_reached, false);
    assert.equal(workbook.sheets.length, 1);
    assert.equal(workbook.sheets[0]?.header_row_number, 2);
    assert.equal(workbook.sheets[0]?.row_count, 4);
    assert.equal(workbook.sheets[0]?.headers.includes('CYD'), true);
    assert.equal(workbook.sheets[0]?.headers.includes('Net Tonnage'), true);
    assert.equal(workbook.sheets[0]?.headers.includes('Ticket Notes'), true);
    assert.equal(workbook.sheets[0]?.headers.includes('Eligibility'), true);

    const detectedSheets = detectSheets(workbook);
    const normalized = normalizeTransactionData({
      workbook,
      detectedSheets,
    });

    const normalizedNetTonnage = normalized.records.reduce((sum, record) => sum + (record.net_tonnage ?? 0), 0);

    assert.equal(normalized.row_count, 4);
    assert.equal(normalized.header_map.transaction_number?.[0]?.column_name, 'Ticket No');
    assert.equal(normalized.header_map.ticket_notes?.[0]?.column_name, 'Ticket Notes');
    assert.equal(normalized.header_map.cyd?.[0]?.column_name, 'CYD');
    assert.equal(normalized.header_map.net_tonnage?.[0]?.column_name, 'Net Tonnage');
    assert.equal(normalized.records[0]?.ticket_notes, 'Late note 1');
    assert.equal(normalized.records[0]?.rate_code, 'RC-01');
    assert.equal(normalized.records[0]?.cyd, 10);
    assert.equal(normalized.records[0]?.net_tonnage, 2.5);
    assert.equal(normalized.summary.total_tickets, 3);
    assert.equal(normalized.summary.total_cyd, 14);
    assert.equal(normalized.summary.distinct_invoice_count, 2);
    assert.equal(normalized.summary.total_invoiced_amount, 2800);
    assert.equal(normalized.summary.eligible_count, 2);
    assert.equal(normalized.summary.ineligible_count, 2);
    assert.equal(normalized.summary.project_operations_overview?.total_tickets, 3);
    assert.equal(normalized.summary.project_operations_overview?.total_cyd, 14);
    assert.equal(normalized.summary.project_operations_overview?.total_invoiced_amount, 2800);
    assert.equal(normalized.summary.project_operations_overview?.distinct_invoice_count, 2);
    assert.equal(normalized.summary.project_operations_overview?.eligible_count, 2);
    assert.equal(normalized.summary.project_operations_overview?.ineligible_count, 2);
    assert.equal(normalizedNetTonnage, 6.5);
    assert.deepEqual(
      [...normalized.rollups.distinct_service_items].sort((left, right) => left.localeCompare(right, 'en-US')),
      ['Grinding', 'Hauling', 'Load Management'],
    );
    assert.deepEqual(
      [...normalized.rollups.distinct_materials].sort((left, right) => left.localeCompare(right, 'en-US')),
      ['Ash', 'C&D', 'Vegetative'],
    );
    assert.deepEqual(
      normalized.rollups.grouped_by_disposal_site
        .map((group) => group.disposal_site)
        .filter((value): value is string => value != null)
        .sort((left, right) => left.localeCompare(right, 'en-US')),
      ['Alpha DMS', 'Beta Landfill'],
    );
    assert.deepEqual(
      normalized.rollups.grouped_by_site_type
        .map((group) => group.site_type)
        .filter((value): value is string => value != null)
        .sort((left, right) => left.localeCompare(right, 'en-US')),
      ['DMS', 'Landfill', 'Temporary'],
    );

    const model = buildDocumentIntelligenceViewModel({
      documentId: 'spreadsheet-current-workbook-doc',
      documentType: 'transaction_data',
      documentName: 'ticket_query.xlsx',
      documentTitle: 'Current Workbook Export',
      projectName: 'Storm Debris Cleanup',
      preferredExtraction: {
        id: 'spreadsheet-current-workbook-doc:extraction',
        created_at: '2026-04-19T18:30:00Z',
        data: {
          fields: {},
          extraction: {
            evidence_v1: {},
            content_layers_v1: {
              spreadsheet: {
                evidence: [],
                normalized_transaction_data: normalized,
              },
            },
          },
        },
      },
      relatedDocs: [],
      normalizedDecisions: [],
      extractionGaps: [],
      auditNotes: [],
      nodeTraces: [],
      executionTrace: {
        facts: {
          source_type: 'transaction_data',
          row_count: 750,
        },
        decisions: [],
        flow_tasks: [],
        generated_at: '2026-04-18T12:00:00Z',
        engine_version: 'document_intelligence:v2',
        extracted: {
          sourceType: 'transaction_data',
          rowCount: 750,
          records: [
            {
              id: 'stale-row-1',
              transaction_number: 'STALE-1001',
              invoice_number: 'INV-STALE',
              rate_code: 'STALE-RC',
            },
          ],
          summary: {
            row_count: 750,
            total_tickets: 750,
            total_cyd: 0,
            distinct_invoice_count: 0,
            total_invoiced_amount: 0,
            uninvoiced_line_count: 750,
            eligible_count: 0,
            ineligible_count: 0,
            unknown_eligibility_count: 750,
          },
          rollups: {
            totalTickets: 750,
            totalCyd: 0,
            distinctInvoiceCount: 0,
            totalInvoicedAmount: 0,
            uninvoicedLineCount: 750,
            groupedByRateCode: [
              {
                billing_rate_key: 'STALE-RC',
                rate_code: 'STALE-RC',
                rate_description_sample: null,
                row_count: 750,
                total_transaction_quantity: 0,
                total_extended_cost: 0,
                distinct_invoice_numbers: [],
                distinct_materials: [],
                distinct_service_items: [],
              },
            ],
          },
        },
      },
      extractionHistory: [],
      factOverrides: [],
      factAnchors: [],
      factReviews: [],
      reviewedDecisionIds: [],
    });

    assert.equal(model.transactionDataExtraction?.rowCount, 4);
    assert.ok(model.spreadsheetReviewDataset);
    assert.equal(model.spreadsheetReviewDataset?.records.length, 4);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalTickets, 3);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalCyd, 14);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalNetTonnage, 6.5);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoices, 2);
    assert.equal(model.spreadsheetReviewDataset?.kpis.totalInvoicedAmount, 2800);
    assert.equal(model.spreadsheetReviewDataset?.kpis.eligible, 2);
    assert.equal(model.spreadsheetReviewDataset?.kpis.ineligible, 2);
    assert.equal(
      'unknown_eligibility_count'
        in ((model.spreadsheetReviewDataset?.summary ?? {}) as Record<string, unknown>),
      false,
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.groupedByRateCode.map((group) => group.billing_rate_key),
      ['RC01', 'RC02', 'RC03'],
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.groupedByServiceItemMobileOnly,
      [],
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.groupedByDisposalSite
        .map((group) => group.disposal_site)
        .filter((value): value is string => value != null)
        .sort((left, right) => left.localeCompare(right, 'en-US')),
      ['Alpha DMS', 'Beta Landfill'],
    );
    assert.deepEqual(
      model.spreadsheetReviewDataset?.groupedBySiteType
        .map((group) => group.site_type)
        .filter((value): value is string => value != null)
        .sort((left, right) => left.localeCompare(right, 'en-US')),
      ['DMS', 'Landfill', 'Temporary'],
    );
  });
});




