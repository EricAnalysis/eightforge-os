import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { utils, write } from 'xlsx';

import { parseWorkbook } from '@/lib/extraction/xlsx/parseWorkbook';

function workbookBytes(rows: unknown[][]): ArrayBuffer {
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, utils.aoa_to_sheet(rows), 'ticket_query');
  const buffer = write(workbook, { type: 'buffer', bookType: 'xlsx' });
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

describe('parseWorkbook', () => {
  it('retains late workbook columns beyond the legacy truncation boundary', async () => {
    const fillerHeaders = Array.from({ length: 41 }, (_, index) => `Early Column ${index + 1}`);
    const lateHeaders = [
      'CYD',
      'Net Tonnage',
      'Invoice #',
      'Rate Code',
      'Transaction Quantity',
      'Extended Cost',
      'Net Quantity',
      'Ticket Notes',
      'Eligibility',
    ];
    const headers = [...fillerHeaders, ...lateHeaders];
    const rowValues = [
      ...Array.from({ length: fillerHeaders.length }, (_, index) => `value-${index + 1}`),
      42,
      17.5,
      'INV-204',
      'RC-01',
      12,
      1250.75,
      10,
      'Late column survives parse',
      'Eligible',
    ];

    const workbook = await parseWorkbook(workbookBytes([
      ['Ticket Query Results'],
      headers,
      rowValues,
    ]));

    assert.equal(workbook.sheets.length, 1);
    const sheet = workbook.sheets[0];
    assert.equal(sheet?.header_row_number, 2);
    assert.equal(sheet?.column_count, headers.length);
    assert.deepEqual(sheet?.headers, headers);
    assert.equal(sheet?.rows.length, 1);
    assert.equal(sheet?.rows[0]?.cells.length, headers.length);
    assert.equal(sheet?.rows[0]?.values['CYD'], 42);
    assert.equal(sheet?.rows[0]?.values['Net Tonnage'], 17.5);
    assert.equal(sheet?.rows[0]?.values['Invoice #'], 'INV-204');
    assert.equal(sheet?.rows[0]?.values['Rate Code'], 'RC-01');
    assert.equal(sheet?.rows[0]?.values['Transaction Quantity'], 12);
    assert.equal(sheet?.rows[0]?.values['Extended Cost'], 1250.75);
    assert.equal(sheet?.rows[0]?.values['Net Quantity'], 10);
    assert.equal(sheet?.rows[0]?.values['Ticket Notes'], 'Late column survives parse');
    assert.equal(sheet?.rows[0]?.values['Eligibility'], 'Eligible');
  });

  it('parses rows beyond the legacy per-sheet row cap without truncation', async () => {
    const totalDataRows = 10_005;
    const headers = ['Transaction #', 'Invoice #', 'Net Tonnage'];
    const dataRows = Array.from({ length: totalDataRows }, (_, index) => [
      `TX-${index + 1}`,
      `INV-${Math.floor(index / 10) + 1}`,
      index + 0.5,
    ]);

    const workbook = await parseWorkbook(workbookBytes([
      ['Ticket Query Results'],
      headers,
      ...dataRows,
    ]));

    assert.equal(workbook.row_limit_reached, false);
    assert.equal(workbook.gaps.some((gap) => gap.category === 'row_limit_applied'), false);
    assert.equal(workbook.sheets.length, 1);
    const sheet = workbook.sheets[0];
    assert.equal(sheet?.header_row_number, 2);
    assert.equal(sheet?.row_count, totalDataRows);
    assert.equal(sheet?.rows.length, totalDataRows);
    assert.equal(sheet?.rows.at(-1)?.row_number, totalDataRows + 2);
    assert.equal(sheet?.rows.at(-1)?.values['Transaction #'], `TX-${totalDataRows}`);
    assert.equal(sheet?.rows.at(-1)?.values['Invoice #'], `INV-${Math.floor((totalDataRows - 1) / 10) + 1}`);
    assert.equal(sheet?.rows.at(-1)?.values['Net Tonnage'], totalDataRows - 0.5);
  });
});
