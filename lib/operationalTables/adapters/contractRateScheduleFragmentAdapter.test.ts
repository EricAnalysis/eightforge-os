import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { PdfTable } from '@/lib/extraction/pdf/extractTables';
import { assembleCanonicalOperationalTableRows } from '@/lib/operationalTables/canonicalOperationalTableRowAssembler';
import { adaptContractRateScheduleFragments } from './contractRateScheduleFragmentAdapter';

function table(params: {
  id?: string;
  page?: number;
  headers?: string[];
  headerContext?: string[];
  rows: Array<{
    page?: number;
    row: number;
    cells: Array<string | {
      text: string;
      source?: 'pdfjs' | 'ocr_fallback';
      x_min?: number;
      x_max?: number;
    }>;
  }>;
}): PdfTable {
  return {
    id: params.id ?? 'contract-rate-table',
    page_number: params.page ?? 4,
    headers: params.headers ?? ['Category', 'Description', 'Unit', 'Rate'],
    header_context: params.headerContext ?? [],
    confidence: 0.92,
    rows: params.rows.map((row) => ({
      id: `${params.id ?? 'contract-rate-table'}-r${row.row}`,
      page_number: row.page ?? params.page ?? 4,
      row_index: row.row,
      raw_text: row.cells.map((cell) => typeof cell === 'string' ? cell : cell.text).join(' '),
      cells: row.cells.map((cell, index) => ({
        column_index: index,
        text: typeof cell === 'string' ? cell : cell.text,
        source: typeof cell === 'string' ? undefined : cell.source,
        x_min: typeof cell === 'string' ? undefined : cell.x_min,
        x_max: typeof cell === 'string' ? undefined : cell.x_max,
      })),
    })),
  };
}

function assembleContract(tables: PdfTable[]) {
  const adapted = adaptContractRateScheduleFragments({
    document_id: 'contract-1',
    source_family: 'contract',
    schedule_kind: 'unit_rate',
    tables,
  });

  return {
    adapted,
    assembled: assembleCanonicalOperationalTableRows({
      document_id: 'contract-1',
      source_family: 'contract',
      fragments: adapted.fragments,
    }),
  };
}

describe('contractRateScheduleFragmentAdapter', () => {
  it('maps a clean unit-rate table to fragments with table/page/cell coordinates', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [
        table({
          id: 'exhibit-a',
          page: 7,
          rows: [
            { row: 3, cells: ['Vegetative', 'Collect haul to DMS', 'CY', '$12.50'] },
          ],
        }),
      ],
    });

    assert.equal(result.adapter_warnings.length, 0);
    assert.equal(result.fragments.length, 4);
    assert.deepEqual(
      result.fragments.map((fragment) => ({
        text: fragment.cell_text,
        cell: fragment.cell_index,
        row: fragment.row_index,
        table: fragment.table_key,
        page: fragment.page_number,
      })),
      [
        { text: 'Vegetative', cell: 0, row: 3, table: 'exhibit-a', page: 7 },
        { text: 'Collect haul to DMS', cell: 1, row: 3, table: 'exhibit-a', page: 7 },
        { text: 'CY', cell: 2, row: 3, table: 'exhibit-a', page: 7 },
        { text: '$12.50', cell: 3, row: 3, table: 'exhibit-a', page: 7 },
      ],
    );
  });

  it('adds header-derived hints only', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [
        table({
          headers: ['Type', 'Service Description', 'UOM', 'Unit Price'],
          rows: [
            { row: 1, cells: ['Tree', 'Hazardous tree removal', 'EA', '95.00'] },
          ],
        }),
      ],
    });

    assert.deepEqual(
      result.fragments.map((fragment) => fragment.extractor_hint),
      ['category', 'description', 'unit', 'unit_price'],
    );
    assert.ok(result.fragments.every((fragment) => fragment.candidate_value == null));
    assert.ok(result.fragments.every((fragment) => fragment.confidence == null));
  });

  it('maps OCR source lineage and alternate cost/header labels into hints', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [
        table({
          headers: ['Type', 'Item', 'Unit', 'Cost'],
          rows: [
            {
              row: 1,
              cells: [
                { text: 'Vegetative', source: 'ocr_fallback' },
                { text: 'ROW to DMS remains in description', source: 'ocr_fallback' },
                { text: 'Cubic Yard', source: 'ocr_fallback' },
                { text: '$6.90', source: 'ocr_fallback' },
              ],
            },
          ],
        }),
      ],
    });

    assert.deepEqual(
      result.fragments.map((fragment) => fragment.extractor_hint),
      ['category', 'description', 'unit', 'unit_price'],
    );
    assert.ok(result.fragments.every((fragment) => fragment.source === 'ocr_fallback'));
  });

  it('emits informational warnings for missing headers, passthrough, compound rates, and Pound/Unit', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'price_sheet',
      tables: [
        table({
          id: 'price-sheet',
          headers: [],
          rows: [
            { row: 1, cells: ['Disposal', 'Passthrough disposal fee', 'Pound/Unit', 'Passthrough'] },
            { row: 2, cells: ['Labor', 'Crew lead', 'Hour', '$95.00/hr'] },
          ],
        }),
      ],
    });

    assert.ok(result.adapter_warnings.some((warning) => warning.includes('no headers detected')));
    assert.ok(result.adapter_warnings.some((warning) => warning.includes('Passthrough rate detected')));
    assert.ok(result.adapter_warnings.some((warning) => warning.includes('compound rate detected')));
    assert.ok(result.adapter_warnings.some((warning) => warning.includes('compound unit detected')));
  });

  it('falls back to table page number when row page number is absent', () => {
    const pdfTable = table({
      id: 'fallback-page',
      page: 11,
      rows: [
        { row: 1, cells: ['Vegetative', 'Collect haul', 'CY', '12.50'] },
      ],
    }) as unknown as PdfTable;
    (pdfTable.rows[0] as { page_number?: number }).page_number = undefined;

    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [pdfTable],
    });

    assert.ok(result.fragments.every((fragment) => fragment.table_key === 'fallback-page'));
    assert.ok(result.fragments.every((fragment) => fragment.page_number === 11));
  });

  it('assembles contract fragments into rows without requiring invoice rate codes', () => {
    const { assembled } = assembleContract([
      table({
        rows: [
          { row: 1, cells: ['Vegetative', 'Collect haul to DMS 0-15 Miles', 'CY', '$12.50'] },
        ],
      }),
    ]);

    assert.equal(assembled.rows.length, 1);
    const row = assembled.rows[0]!;
    assert.equal(row.rate_code, undefined);
    assert.equal(row.category, 'Vegetative');
    assert.equal(row.description, 'Collect haul to DMS 0-15 Miles');
    assert.equal(row.unit, 'CY');
    assert.equal(row.unit_price, 12.5);
    assert.equal(row.mileage_tier, '0-15');
    assert.ok(!row.warnings.some((warning) => warning.includes('rate code not recovered')));
    assert.ok(row.evidence_refs.length > 0);
  });

  it('prefers header-hinted unit cells over ROW text embedded in the description', () => {
    const { assembled } = assembleContract([
      table({
        rows: [
          { row: 1, cells: ['Vegetative', '0-15 Miles from ROW to DMS', 'Cubic Yard', '$6.90'] },
          { row: 2, cells: ['Final Disposal', 'Mulch DMS to FDS', 'Cubic Yard', '$5.40'] },
        ],
      }),
    ]);

    assert.equal(assembled.rows.length, 2);
    const first = assembled.rows[0]!;
    assert.equal(first.description, '0-15 Miles from ROW to DMS');
    assert.equal(first.unit, 'CY');
    assert.equal(first.mileage_tier, '0-15');
    assert.ok(!first.description?.includes('Cubic Yard'));
    assert.ok(!first.warnings.some((warning) => warning.includes('unknown unit token')));

    const second = assembled.rows[1]!;
    assert.equal(second.description, 'Mulch DMS to FDS');
    assert.equal(second.unit, 'CY');
    assert.ok(!second.warnings.some((warning) => warning.includes('DMS')));
    assert.ok(!second.warnings.some((warning) => warning.includes('FDS')));
  });

  it('preserves mileage tier in descriptions with en dash ranges', () => {
    const { assembled } = assembleContract([
      table({
        rows: [
          { row: 1, cells: ['Vegetative', 'ROW to DMS 16–30 Miles', 'CY', '$13.50'] },
        ],
      }),
    ]);

    const row = assembled.rows[0]!;
    assert.equal(row.description, 'ROW to DMS 16–30 Miles');
    assert.equal(row.mileage_tier, '16-30');
  });

  it('keeps Passthrough unit_price null with a row warning', () => {
    const { assembled } = assembleContract([
      table({
        rows: [
          { row: 1, cells: ['Disposal', 'Passthrough disposal fee', 'TON', 'Passthrough'] },
        ],
      }),
    ]);

    const row = assembled.rows[0]!;
    assert.equal(row.unit_price, undefined);
    assert.equal(row.row_role, 'passthrough_rate');
    assert.equal(row.confidence, 1);
  });

  it('keeps Williamson-style OCR operational rows classified without promoting headers', () => {
    const { assembled } = assembleContract([
      table({
        id: 'williamson-ocr-table',
        headers: ['Category', 'Description', 'Unit', 'Rate'],
        rows: [
          { row: 1, cells: ['Vegetative', 'Collect, Remove & Haul 0-15 Miles from ROW to DMS', 'Cubic Yard', '$6.90'] },
          { row: 2, cells: ['Vegetative', 'Collect, Remove & Haul 16-30 Miles from ROW to DMS', 'Cubic Yard', '$7.90'] },
          { row: 3, cells: ['Final Disposal', 'Single Cost - Any Distance', 'Cubic Yard', '$5.40'] },
          { row: 4, cells: ['Final Disposal', 'Passthrough disposal fee', 'TON', 'Passthrough'] },
        ],
      }),
    ]);

    assert.equal(assembled.rows.length, 4);
    assert.equal(assembled.unclassified_rows.length, 0);
    assert.equal(assembled.rejected_rows.length, 0);
    assert.equal(assembled.rows[0]?.unit, 'CY');
    assert.equal(assembled.rows[0]?.unit_price, 6.9);
    assert.equal(assembled.rows[0]?.description, 'Collect, Remove & Haul 0-15 Miles from ROW to DMS');
    assert.equal(assembled.rows[3]?.row_role, 'passthrough_rate');
  });

  it('assembles T&M Hour rows', () => {
    const { assembled } = assembleContract([
      table({
        headers: ['Category', 'Labor Class', 'Unit', 'Rate'],
        rows: [
          { row: 1, cells: ['Labor', 'Crew lead', 'Hour', '$95.00/hr'] },
        ],
      }),
    ]);

    const row = assembled.rows[0]!;
    assert.equal(row.category, 'Labor');
    assert.equal(row.description, 'Crew lead');
    assert.equal(row.unit, 'Hour');
    assert.equal(row.unit_price, 95);
    assert.ok(row.evidence_refs.length > 0);
  });

  it('does not assign a unit hint to ROW tokens inside known ROW-to-DMS descriptions', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [
        table({
          rows: [
            { row: 1, cells: ['Vegetative', '0-15 Miles from ROW to DMS', 'Cubic Yard', '$6.90'] },
          ],
        }),
      ],
    });

    const description = result.fragments.find((fragment) => fragment.cell_text.includes('ROW to DMS'));
    assert.equal(description?.extractor_hint, 'description');
  });

  it('assigns Passthrough rate cells a unit_price hint and warning', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [
        table({
          rows: [
            { row: 1, cells: ['Final Disposal', 'Tipping Fee - Vegetative', 'Cubic Yard', 'Passthrough'] },
          ],
        }),
      ],
    });

    const passthrough = result.fragments.find((fragment) => fragment.cell_text === 'Passthrough');
    assert.equal(passthrough?.extractor_hint, 'unit_price');
    assert.ok(result.adapter_warnings.some((warning) => warning.includes('Passthrough rate detected')));
  });

  it('infers conservative hints for accepted OCR schedule tables with noisy headers', () => {
    const result = adaptContractRateScheduleFragments({
      document_id: 'contract-1',
      source_family: 'contract',
      schedule_kind: 'unit_rate',
      tables: [
        table({
          id: 'williamson-noisy-ocr',
          headers: ['|', 'from', 'Upincdtporated', 'Neighborhoods', '|'],
          headerContext: ['EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES'],
          rows: [
            {
              row: 1,
              cells: [
                { text: 'Vegetative Collect, Remove & Haul', source: 'ocr_fallback', x_min: 140, x_max: 451 },
                { text: '0-15 Miles from ROW to DMS', source: 'ocr_fallback', x_min: 500, x_max: 765 },
                { text: 'Cubic Yard', source: 'ocr_fallback', x_min: 824, x_max: 932 },
                { text: '$6.90', source: 'ocr_fallback', x_min: 960, x_max: 1018 },
              ],
            },
          ],
        }),
      ],
    });

    assert.deepEqual(
      result.fragments.map((fragment) => fragment.extractor_hint),
      ['description', 'description', 'unit', 'unit_price'],
    );
    assert.ok(result.fragments.every((fragment) => fragment.source === 'ocr_fallback'));
  });

  it('recovers Williamson-style OCR rows without treating ROW to DMS as a unit', () => {
    const { assembled } = assembleContract([
      table({
        id: 'williamson-noisy-ocr',
        headers: ['|', 'from', 'Upincdtporated', 'Neighborhoods', '|'],
        headerContext: ['EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES'],
        rows: [
          {
            row: 1,
            cells: [
              { text: 'Vegetative Collect, Remove & Haul', source: 'ocr_fallback' },
              { text: '0-15 Miles from ROW to DMS', source: 'ocr_fallback' },
              { text: 'Cubic Yard', source: 'ocr_fallback' },
              { text: '$6.90', source: 'ocr_fallback' },
            ],
          },
          {
            row: 2,
            cells: [
              { text: 'Vegetative Collect, Remove & Haul', source: 'ocr_fallback' },
              { text: '16-30 Miles from ROW to DMS', source: 'ocr_fallback' },
              { text: 'Cubic Yard', source: 'ocr_fallback' },
              { text: '$7.90', source: 'ocr_fallback' },
            ],
          },
          {
            row: 3,
            cells: [
              { text: 'Final Disposal', source: 'ocr_fallback' },
              { text: 'Single Cost - Any Distance', source: 'ocr_fallback' },
              { text: 'Cubic Yard', source: 'ocr_fallback' },
              { text: '$5.40', source: 'ocr_fallback' },
            ],
          },
        ],
      }),
    ]);

    assert.equal(assembled.rows.length, 3);
    assert.equal(assembled.unclassified_rows.length, 0);
    assert.equal(assembled.rejected_rows.length, 0);
    assert.equal(assembled.rows[0]?.unit, 'CY');
    assert.equal(assembled.rows[0]?.unit_price, 6.9);
    assert.equal(assembled.rows[0]?.description, 'Vegetative Collect, Remove & Haul 0-15 Miles from ROW to DMS');
    assert.equal(assembled.rows[0]?.mileage_tier, '0-15');
    assert.ok(assembled.rows[0]?.evidence_refs.length);
  });

  it('splits mixed OCR contract cells into description, unit, and rate hints', () => {
    const { adapted, assembled } = assembleContract([
      table({
        id: 'williamson-mixed-ocr',
        headers: ['|', 'from', 'Upincdtporated', 'Neighborhoods', '|'],
        headerContext: ['EMERGENCY DEBRIS REMOVAL UNIT RATES AND TIME-AND-MATERIALS RATES'],
        rows: [
          {
            row: 1,
            cells: [
              {
                text: 'Vegetative Collect, Remove & Haul 0-15 Milesfrom ROW t6 DMS | Cubic ____| Yard | $6.90 Rate',
                source: 'ocr_fallback',
              },
            ],
          },
          {
            row: 2,
            cells: [
              { text: 'Tree Operations Hazardous Tree Removal 6-12 inch | Tree $95.00', source: 'ocr_fallback' },
            ],
          },
          {
            row: 3,
            cells: [
              { text: 'Tree Operations Hazardous Trees with Hanging Limbs | Tree $80.00', source: 'ocr_fallback' },
            ],
          },
        ],
      }),
    ]);

    assert.ok(adapted.fragments.some((fragment) => fragment.extractor_hint === 'description' && fragment.cell_index === 0));
    assert.ok(adapted.fragments.some((fragment) => fragment.extractor_hint === 'unit' && fragment.cell_text === 'Cubic Yard'));
    assert.ok(adapted.fragments.some((fragment) => fragment.extractor_hint === 'unit_price' && fragment.cell_text.includes('$6.90')));
    assert.equal(assembled.rows.length, 3);
    assert.equal(assembled.rows[0]?.unit, 'CY');
    assert.equal(assembled.rows[0]?.unit_price, 6.9);
    assert.equal(assembled.rows[0]?.site_type, 'ROW_to_DMS');
    assert.equal(assembled.rows[0]?.mileage_tier, '0-15');
    assert.equal(assembled.rows[1]?.unit, 'Tree');
    assert.equal(assembled.rows[1]?.unit_price, 95);
    assert.equal(assembled.rows[2]?.unit, 'Tree');
    assert.equal(assembled.rows[2]?.unit_price, 80);
    assert.ok(assembled.rows.every((row) => row.evidence_refs.length > 0));
  });
});
