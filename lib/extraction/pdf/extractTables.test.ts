import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildPdfTableExtraction } from './extractTables';
import type { PdfLayout, PdfLayoutLine, PdfToken } from './extractText';

function makeTokens(entries: Array<[string, number]>, y: number): PdfToken[] {
  return entries.map(([text, x]) => ({
    text,
    x,
    y,
    width: Math.max(8, text.length * 5),
    height: 12,
  }));
}

function makeLine(params: {
  id: string;
  y: number;
  kind: PdfLayoutLine['kind'];
  entries?: Array<[string, number]>;
  text?: string;
  pageNumber?: number;
}): PdfLayoutLine {
  const entries = params.entries ?? [[params.text ?? '', 0]];
  const tokens = makeTokens(entries, params.y);
  const text = params.text ?? entries.map(([value]) => value).join(' ');
  const first = tokens[0];
  const last = tokens.at(-1);
  return {
    id: params.id,
    page_number: params.pageNumber ?? 18,
    text,
    tokens,
    kind: params.kind,
    x_min: first?.x ?? 0,
    x_max: last ? last.x + last.width : 0,
    y: params.y,
  };
}

function makeLayout(lines: PdfLayoutLine[]): PdfLayout {
  return {
    page_count: 1,
    gaps: [],
    pages: [
      {
        page_number: 18,
        lines,
      },
    ],
  };
}

function makePagedLayout(pages: Array<{ pageNumber: number; lines: PdfLayoutLine[] }>): PdfLayout {
  return {
    page_count: pages.length,
    gaps: [],
    pages: pages.map((page) => ({
      page_number: page.pageNumber,
      lines: page.lines,
    })),
  };
}

describe('buildPdfTableExtraction', () => {
  it('reconstructs a single unit-price table with multiline row descriptions', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:l1', y: 10, kind: 'text', text: 'ATTACHMENT B' }),
      makeLine({ id: 'p18:l2', y: 22, kind: 'text', text: 'UNIT PRICES' }),
      makeLine({
        id: 'p18:l3',
        y: 34,
        kind: 'text',
        entries: [
          ['N', 0],
          ['o.', 16],
          ['Description', 40],
          ['Quantity', 240],
          ['Unit', 340],
          ['Unit Price', 390],
          ['Extension', 490],
        ],
      }),
      makeLine({
        id: 'p18:l4',
        y: 46,
        kind: 'table_candidate',
        entries: [
          ['1.', 0],
          ['Pick Up & Haul Vegetative', 40],
          ['10,000.00', 240],
          ['CY', 340],
          ['$36.33', 390],
          ['$363,300.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l5', y: 58, kind: 'text', text: 'Debris (Field/Public' }),
      makeLine({ id: 'p18:l6', y: 70, kind: 'text', text: 'Row) to STL Composting (560' }),
      makeLine({ id: 'p18:l7', y: 82, kind: 'text', text: 'Terminal Row)' }),
      makeLine({
        id: 'p18:l8',
        y: 94,
        kind: 'table_candidate',
        entries: [
          ['2.', 0],
          ['Pick Up & Haul C&D Debris', 40],
          ['5,000.00', 240],
          ['CY', 340],
          ['$87.86', 390],
          ['$439,300.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l9', y: 106, kind: 'text', text: '(Field/Public Row) to Landfill' }),
      makeLine({
        id: 'p18:l10',
        y: 118,
        kind: 'table_candidate',
        entries: [
          ['3.', 0],
          ['Collect & Dispose of', 40],
          ['100.00', 240],
          ['CY', 340],
          ['$495.00', 390],
          ['$49,500.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l11', y: 130, kind: 'text', text: 'Household Hazardous Waste' }),
      makeLine({ id: 'p18:l12', y: 142, kind: 'text', text: '(HHW)' }),
      makeLine({
        id: 'p18:l13',
        y: 154,
        kind: 'table_candidate',
        entries: [
          ['4.', 0],
          ['Collect & Dispose of Friable', 40],
          ['50.00', 240],
          ['CY', 340],
          ['$785.00', 390],
          ['$39,250.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l14', y: 166, kind: 'text', text: 'Asbestos Containing' }),
      makeLine({ id: 'p18:l15', y: 178, kind: 'text', text: 'Material (ACM)' }),
      makeLine({
        id: 'p18:l16',
        y: 190,
        kind: 'table_candidate',
        entries: [
          ['5.', 0],
          ['Off Route Pickup (Additional', 40],
          ['1,000.00', 240],
          ['CY', 340],
          ['$24.10', 390],
          ['$24,100.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l17', y: 202, kind: 'text', text: 'Cost to Unit Prices in' }),
      makeLine({ id: 'p18:l18', y: 214, kind: 'text', text: 'Items 1-4)' }),
      makeLine({
        id: 'p18:l19',
        y: 226,
        kind: 'table_candidate',
        entries: [
          ['6.', 0],
          ['Remove White Goods with', 40],
          ['10.00', 240],
          ['EA', 340],
          ['$245.00', 390],
          ['$2,450.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l20', y: 238, kind: 'text', text: 'Freon (Refrigerators,' }),
      makeLine({ id: 'p18:l21', y: 250, kind: 'text', text: 'Freezers, Air Conditioners,' }),
      makeLine({ id: 'p18:l22', y: 262, kind: 'text', text: 'etc.)' }),
      makeLine({
        id: 'p18:l23',
        y: 274,
        kind: 'table_candidate',
        entries: [
          ['7.', 0],
          ['Remove White Goods without', 40],
          ['10.00', 240],
          ['EA', 340],
          ['$195.00', 390],
          ['$1,950.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l24', y: 286, kind: 'text', text: 'Freon (Washers, Dryers,' }),
      makeLine({ id: 'p18:l25', y: 298, kind: 'text', text: 'Water Heaters, Stoves,' }),
      makeLine({ id: 'p18:l26', y: 310, kind: 'text', text: 'etc.)' }),
      makeLine({
        id: 'p18:l27',
        y: 322,
        kind: 'table_candidate',
        entries: [
          ['8.', 0],
          ['Contingency*', 40],
          ['1.00', 240],
          ['EA', 340],
          ['$580,150.00', 390],
          ['$580,150.00', 490],
        ],
      }),
      makeLine({ id: 'p18:l28', y: 334, kind: 'form_candidate', text: 'Total: $1,500,000' }),
      makeLine({
        id: 'p18:l29',
        y: 346,
        kind: 'text',
        text: '*Contingency Line Item is only to be utilized at the written direction of the Board of Public Service',
      }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);

    const table = result.tables[0];
    assert.equal(table.page_number, 18);
    assert.deepEqual(table.headers, ['No.', 'Description', 'Quantity', 'Unit', 'Unit Price', 'Extension']);
    assert.deepEqual(table.header_context, ['ATTACHMENT B', 'UNIT PRICES']);
    assert.equal(table.rows.length, 8);

    assert.equal(table.rows[0]?.cells[1]?.text, 'Pick Up & Haul Vegetative Debris (Field/Public Row) to STL Composting (560 Terminal Row)');
    assert.equal(table.rows[0]?.cells[4]?.text, '$36.33');
    assert.equal(table.rows[1]?.cells[4]?.text, '$87.86');
    assert.equal(table.rows[2]?.cells[4]?.text, '$495.00');
    assert.equal(table.rows[3]?.cells[4]?.text, '$785.00');
    assert.equal(table.rows[4]?.cells[1]?.text, 'Off Route Pickup (Additional Cost to Unit Prices in Items 1-4)');
    assert.equal(table.rows[5]?.cells[1]?.text, 'Remove White Goods with Freon (Refrigerators, Freezers, Air Conditioners, etc.)');
    assert.equal(table.rows[6]?.cells[1]?.text, 'Remove White Goods without Freon (Washers, Dryers, Water Heaters, Stoves, etc.)');
    assert.equal(table.rows[7]?.cells[1]?.text, 'Contingency*');
  });

  it('captures four-column schedule-of-rates tables without an extension column', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:r1', y: 10, kind: 'text', text: 'SCHEDULE OF RATES' }),
      makeLine({
        id: 'p18:r2',
        y: 22,
        kind: 'text',
        entries: [
          ['Item', 0],
          ['Service', 60],
          ['Unit', 260],
          ['Rate', 340],
        ],
      }),
      makeLine({
        id: 'p18:r3',
        y: 34,
        kind: 'table_candidate',
        entries: [
          ['A1', 0],
          ['Emergency Debris Monitoring', 60],
          ['HR', 260],
          ['125.00', 340],
        ],
      }),
      makeLine({ id: 'p18:r4', y: 46, kind: 'text', text: 'for nighttime operations' }),
      makeLine({
        id: 'p18:r5',
        y: 58,
        kind: 'table_candidate',
        entries: [
          ['A2', 0],
          ['Load Site Supervision', 60],
          ['DAY', 260],
          ['950.00', 340],
        ],
      }),
      makeLine({ id: 'p18:r6', y: 70, kind: 'text', text: 'including documentation support' }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.deepEqual(table.headers, ['Item', 'Service', 'Unit', 'Rate']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]?.cells[1]?.text, 'Emergency Debris Monitoring for nighttime operations');
    assert.equal(table.rows[0]?.cells[2]?.text, 'HR');
    assert.equal(table.rows[0]?.cells[3]?.text, '125.00');
    assert.equal(table.rows[1]?.cells[1]?.text, 'Load Site Supervision including documentation support');
    assert.equal(table.rows[1]?.cells[3]?.text, '950.00');
  });

  it('captures three-column price sheets with multiline descriptions', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:p1', y: 10, kind: 'text', text: 'EXHIBIT A' }),
      makeLine({ id: 'p18:p2', y: 22, kind: 'text', text: 'PRICE SHEET' }),
      makeLine({
        id: 'p18:p3',
        y: 34,
        kind: 'text',
        entries: [
          ['Description', 20],
          ['Unit', 260],
          ['Price', 340],
        ],
      }),
      makeLine({
        id: 'p18:p4',
        y: 46,
        kind: 'table_candidate',
        entries: [
          ['Vegetative Debris Removal', 20],
          ['CY', 260],
          ['36.33', 340],
        ],
      }),
      makeLine({ id: 'p18:p5', y: 58, kind: 'text', text: 'including haul from right-of-way' }),
      makeLine({
        id: 'p18:p6',
        y: 70,
        kind: 'table_candidate',
        entries: [
          ['Construction & Demolition Debris', 20],
          ['TN', 260],
          ['87.86', 340],
        ],
      }),
      makeLine({ id: 'p18:p7', y: 82, kind: 'text', text: 'loading and disposal' }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.deepEqual(table.headers, ['Description', 'Unit', 'Price']);
    assert.deepEqual(table.header_context, ['EXHIBIT A', 'PRICE SHEET']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]?.cells[0]?.text, 'Vegetative Debris Removal including haul from right-of-way');
    assert.equal(table.rows[0]?.cells[1]?.text, 'CY');
    assert.equal(table.rows[0]?.cells[2]?.text, '36.33');
    assert.equal(table.rows[1]?.cells[0]?.text, 'Construction & Demolition Debris loading and disposal');
    assert.equal(table.rows[1]?.cells[1]?.text, 'TN');
    assert.equal(table.rows[1]?.cells[2]?.text, '87.86');
  });

  it('captures rate code schedules that use bare numeric rates', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:c1', y: 10, kind: 'text', text: 'COMPENSATION SCHEDULE' }),
      makeLine({
        id: 'p18:c2',
        y: 22,
        kind: 'text',
        entries: [
          ['Rate Code', 0],
          ['Rate Description', 80],
          ['Unit', 280],
          ['Rate', 360],
        ],
      }),
      makeLine({
        id: 'p18:c3',
        y: 34,
        kind: 'table_candidate',
        entries: [
          ['RD-1', 0],
          ['Vegetative Debris Removal', 80],
          ['CY', 280],
          ['36.33', 360],
        ],
      }),
      makeLine({
        id: 'p18:c4',
        y: 46,
        kind: 'table_candidate',
        entries: [
          ['RD-2', 0],
          ['Mixed C&D Debris Haul Off', 80],
          ['TN', 280],
          ['87.86', 360],
        ],
      }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.deepEqual(table.headers, ['Rate Code', 'Rate Description', 'Unit', 'Rate']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]?.cells[1]?.text, 'Vegetative Debris Removal');
    assert.equal(table.rows[0]?.cells[2]?.text, 'CY');
    assert.equal(table.rows[0]?.cells[3]?.text, '36.33');
    assert.equal(table.rows[1]?.cells[2]?.text, 'TN');
    assert.equal(table.rows[1]?.cells[3]?.text, '87.86');
  });

  it('captures time-and-materials hourly rate tables', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:t1', y: 10, kind: 'text', text: 'TIME AND MATERIALS RATES' }),
      makeLine({
        id: 'p18:t2',
        y: 22,
        kind: 'text',
        entries: [
          ['Labor Class', 20],
          ['Unit', 250],
          ['Rate', 330],
        ],
      }),
      makeLine({
        id: 'p18:t3',
        y: 34,
        kind: 'table_candidate',
        entries: [
          ['Equipment Operator', 20],
          ['HR', 250],
          ['$98.50', 330],
        ],
      }),
      makeLine({
        id: 'p18:t4',
        y: 46,
        kind: 'table_candidate',
        entries: [
          ['Truck Foreman', 20],
          ['HR', 250],
          ['$110.00', 330],
        ],
      }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.deepEqual(table.headers, ['Labor Class', 'Unit', 'Rate']);
    assert.deepEqual(table.header_context, ['TIME AND MATERIALS RATES']);
    assert.equal(table.rows.length, 2);
    assert.equal(table.rows[0]?.cells[0]?.text, 'Equipment Operator');
    assert.equal(table.rows[0]?.cells[1]?.text, 'HR');
    assert.equal(table.rows[0]?.cells[2]?.text, '$98.50');
    assert.equal(table.rows[1]?.cells[2]?.text, '$110.00');
  });

  it('keeps dense repeated-category rows distinct while still merging wrapped descriptions', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:d1', y: 10, kind: 'text', text: 'EXHIBIT A' }),
      makeLine({
        id: 'p18:d2',
        y: 22,
        kind: 'text',
        entries: [
          ['Category', 0],
          ['Description', 140],
          ['Unit', 360],
          ['Rate', 440],
        ],
      }),
      makeLine({
        id: 'p18:d3',
        y: 34,
        kind: 'table_candidate',
        entries: [
          ['Vegetative', 0],
          ['Collect, Remove & Haul', 140],
          ['Cubic Yard', 360],
          ['$6.90', 440],
        ],
      }),
      makeLine({ id: 'p18:d4', y: 46, kind: 'text', text: 'from unincorporated neighborhoods' }),
      makeLine({
        id: 'p18:d5',
        y: 58,
        kind: 'table_candidate',
        entries: [
          ['Vegetative', 0],
          ['16-30 Miles from ROW to DMS', 140],
          ['Cubic Yard', 360],
          ['$7.90', 440],
        ],
      }),
      makeLine({
        id: 'p18:d6',
        y: 70,
        kind: 'table_candidate',
        entries: [
          ['Vegetative', 0],
          ['31-60 Miles from ROW to DMS', 140],
          ['Cubic Yard', 360],
          ['$8.90', 440],
        ],
      }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.deepEqual(table.headers, ['Category', 'Description', 'Unit', 'Rate']);
    assert.equal(table.rows.length, 3);
    assert.equal(
      table.rows[0]?.cells[1]?.text,
      'Collect, Remove & Haul from unincorporated neighborhoods',
    );
    assert.equal(table.rows[1]?.cells[0]?.text, 'Vegetative');
    assert.equal(table.rows[1]?.cells[1]?.text, '16-30 Miles from ROW to DMS');
    assert.equal(table.rows[2]?.cells[1]?.text, '31-60 Miles from ROW to DMS');
  });

  it('captures continuation schedule rows across repeated headers on later pages', () => {
    const layout = makePagedLayout([
      {
        pageNumber: 18,
        lines: [
          makeLine({ id: 'p18:m1', pageNumber: 18, y: 10, kind: 'text', text: 'ATTACHMENT B' }),
          makeLine({ id: 'p18:m2', pageNumber: 18, y: 22, kind: 'text', text: 'UNIT RATE PRICE FORM' }),
          makeLine({
            id: 'p18:m3',
            pageNumber: 18,
            y: 34,
            kind: 'text',
            entries: [
              ['Description', 0],
              ['County A', 320],
              ['County B', 420],
            ],
          }),
          makeLine({
            id: 'p18:m4',
            pageNumber: 18,
            y: 46,
            kind: 'table_candidate',
            entries: [
              ['1. Vegetative Debris Removal', 0],
              ['6.90', 320],
              ['7.10', 420],
            ],
          }),
          makeLine({
            id: 'p18:m5',
            pageNumber: 18,
            y: 58,
            kind: 'table_candidate',
            entries: [
              ['2. Mixed C&D Debris', 0],
              ['8.90', 320],
              ['9.10', 420],
            ],
          }),
        ],
      },
      {
        pageNumber: 19,
        lines: [
          makeLine({ id: 'p19:m1', pageNumber: 19, y: 10, kind: 'text', text: 'ATTACHMENT B' }),
          makeLine({ id: 'p19:m2', pageNumber: 19, y: 22, kind: 'text', text: 'UNIT RATE PRICE FORM' }),
          makeLine({
            id: 'p19:m3',
            pageNumber: 19,
            y: 34,
            kind: 'text',
            entries: [
              ['Description', 0],
              ['County A', 320],
              ['County B', 420],
            ],
          }),
          makeLine({
            id: 'p19:m4',
            pageNumber: 19,
            y: 46,
            kind: 'table_candidate',
            entries: [
              ['3. White Goods Removal', 0],
              ['12.50', 320],
              ['12.80', 420],
            ],
          }),
          makeLine({
            id: 'p19:m5',
            pageNumber: 19,
            y: 58,
            kind: 'table_candidate',
            entries: [
              ['4. Hazardous Limb Removal', 0],
              ['85.00', 320],
              ['88.00', 420],
            ],
          }),
        ],
      },
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 2);
    assert.equal(result.tables[0]?.page_number, 18);
    assert.equal(result.tables[1]?.page_number, 19);
    assert.equal(result.tables[0]?.rows.length, 2);
    assert.equal(result.tables[1]?.rows.length, 2);
  });

  it('captures headerless EMERG03-style wrapped rate rows', () => {
    const layout = makeLayout([
      makeLine({ id: 'p18:e1', y: 10, kind: 'text', text: 'Attachment B' }),
      makeLine({ id: 'p18:e2', y: 22, kind: 'text', text: 'UNIT RATE PRICE FORM DOT (EMERG03)' }),
      makeLine({ id: 'p18:e3', y: 34, kind: 'text', text: 'Item and Place Pricing' }),
      makeLine({
        id: 'p18:e4',
        y: 46,
        kind: 'table_candidate',
        entries: [
          ['1.', 0],
          ['Removal of Eligible Hazardous Trees', 40],
          ['$ Per Tree', 290],
          ['483.31', 390],
          ['313.27', 470],
        ],
      }),
      makeLine({
        id: 'p18:e5',
        y: 58,
        kind: 'text',
        text: 'Work consists of all labor, equipment, fuel, and associated costs',
      }),
      makeLine({
        id: 'p18:e6',
        y: 70,
        kind: 'text',
        text: 'necessary for the removal of eligible hazardous trees and placement on the ROW.',
      }),
      makeLine({
        id: 'p18:e7',
        y: 82,
        kind: 'table_candidate',
        entries: [
          ['A.', 0],
          ['Single Slope Operation Plan', 40],
          ['$ Per Tree', 290],
          ['483.31', 390],
          ['313.27', 470],
        ],
      }),
      makeLine({
        id: 'p18:e8',
        y: 94,
        kind: 'text',
        text: 'for trees on the ROW slated for chipping and broadcasting.',
      }),
    ]);

    const result = buildPdfTableExtraction({ layout });

    assert.equal(result.tables.length, 1);
    const table = result.tables[0];
    assert.deepEqual(table.header_context, ['UNIT RATE PRICE FORM DOT (EMERG03)', 'Item and Place Pricing']);
    assert.equal(table.headers.length, 0);
    assert.equal(table.rows.length, 2);
    assert.equal(
      table.rows[0]?.cells[1]?.text,
      'Removal of Eligible Hazardous Trees Work consists of all labor, equipment, fuel, and associated costs necessary for the removal of eligible hazardous trees and placement on the ROW.',
    );
    assert.equal(
      table.rows[1]?.cells[1]?.text,
      'Single Slope Operation Plan for trees on the ROW slated for chipping and broadcasting.',
    );
    assert.equal(table.rows[0]?.cells[2]?.text, '$ Per Tree');
    assert.equal(table.rows[1]?.cells[3]?.text, '483.31');
  });
});
