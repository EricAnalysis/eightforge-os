import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildTableCellGeometry,
  type TableCellGeometry,
} from '@/lib/extraction/tableGeometry';
import {
  assembleCanonicalOperationalTableRows,
  type CanonicalOperationalTableRow,
  type OperationalTableFragment,
} from './canonicalOperationalTableRowAssembler';

function frag(params: {
  text: string;
  row: number;
  cell: number;
  table?: string;
  page?: number;
  candidate?: unknown;
  hint?: string;
  source?: OperationalTableFragment['source'];
  geometry?: TableCellGeometry;
}): OperationalTableFragment {
  return {
    cell_text: params.text,
    cell_index: params.cell,
    row_index: params.row,
    table_key: params.table ?? 'invoice-lines',
    page_number: params.page ?? 1,
    candidate_value: params.candidate,
    extractor_hint: params.hint,
    source: params.source,
    geometry: params.geometry,
  };
}

function assemble(fragments: OperationalTableFragment[]) {
  return assembleCanonicalOperationalTableRows({
    document_id: 'williamson-2026-002',
    source_family: 'invoice',
    fragments,
  });
}

function assembleContractRows(fragments: OperationalTableFragment[]) {
  return assembleCanonicalOperationalTableRows({
    document_id: 'williamson-contract',
    source_family: 'contract',
    fragments,
  });
}

function contractRow(params: {
  row?: number;
  category?: string;
  description?: string;
  unit?: string;
  rate?: string;
  table?: string;
}): OperationalTableFragment[] {
  const row = params.row ?? 1;
  const table = params.table ?? 'pdf_table_p8_t26';
  return [
    params.category == null ? null : frag({ row, cell: 0, table, page: 8, text: params.category, hint: 'category' }),
    params.description == null ? null : frag({ row, cell: 1, table, page: 8, text: params.description, hint: 'description' }),
    params.unit == null ? null : frag({ row, cell: 2, table, page: 8, text: params.unit, hint: 'unit' }),
    params.rate == null ? null : frag({ row, cell: 3, table, page: 8, text: params.rate, hint: 'unit_price' }),
  ].filter((fragment): fragment is OperationalTableFragment => fragment != null);
}

function rowByCode(rows: CanonicalOperationalTableRow[], code: string): CanonicalOperationalTableRow {
  const row = rows.find((candidate) => candidate.rate_code === code);
  assert.ok(row, `missing row ${code}`);
  return row;
}

const williamsonFragments: OperationalTableFragment[] = [
  frag({ row: 0, cell: 0, text: 'Description' }),
  frag({ row: 0, cell: 1, text: 'Quantity' }),
  frag({ row: 0, cell: 2, text: 'Unit Price' }),
  frag({ row: 0, cell: 3, text: 'Line Total' }),
  frag({ row: 1, cell: 0, text: '1A' }),
  frag({ row: 1, cell: 1, text: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15' }),
  frag({ row: 1, cell: 2, text: '43894.00' }),
  frag({ row: 1, cell: 3, text: '6.90' }),
  frag({ row: 1, cell: 4, text: '302868.60' }),
  frag({ row: 2, cell: 0, text: '1B' }),
  frag({ row: 2, cell: 1, text: 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30' }),
  frag({ row: 2, cell: 2, text: '12250.00' }),
  frag({ row: 2, cell: 3, text: '7.90' }),
  frag({ row: 2, cell: 4, text: '96775.00' }),
  frag({ row: 3, cell: 0, text: '1E' }),
  frag({ row: 3, cell: 1, text: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15' }),
  frag({ row: 3, cell: 2, text: '3099.00' }),
  frag({ row: 3, cell: 3, text: '13.50' }),
  frag({ row: 3, cell: 4, text: '41836.50' }),
  frag({ row: 4, cell: 0, text: '1F' }),
  frag({ row: 4, cell: 1, text: 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30' }),
  frag({ row: 4, cell: 2, text: '916.00' }),
  frag({ row: 4, cell: 3, text: '14.50' }),
  frag({ row: 4, cell: 4, text: '13282.00' }),
  frag({ row: 5, cell: 0, text: '5A' }),
  frag({ row: 5, cell: 1, text: 'Tree Operations Hazardous Tree Removal 6-12 in' }),
  frag({ row: 5, cell: 2, text: '5.00' }),
  frag({ row: 5, cell: 3, text: '95.00' }),
  frag({ row: 5, cell: 4, text: '475.00' }),
  frag({ row: 6, cell: 0, text: '6A' }),
  frag({ row: 6, cell: 1, text: 'Tree Operations Hazardous Hanging Limb Removal >2" per tree' }),
  frag({ row: 6, cell: 2, text: '994.00' }),
  frag({ row: 6, cell: 3, text: '80.00' }),
  frag({ row: 6, cell: 4, text: '79520.00' }),
  frag({ row: 7, cell: 0, text: 'Subtotal' }),
  frag({ row: 7, cell: 1, text: '534757.10' }),
];

describe('canonicalOperationalTableRowAssembler', () => {
  it('preserves page/table/row/cell geometry in evidence refs and raw fragments', () => {
    const geometry = buildTableCellGeometry({
      page_number: 8,
      table_id: 'pdf:table:p8:t1',
      row_id: 'pdf:table:p8:t1:r1',
      row_index: 1,
      cell_index: 3,
      text: '$27.00',
      x_min: 620,
      x_max: 690,
      source_type: 'ocr_fallback',
      anchor_id: 'pdf:table:p8:t1:r1',
    });

    const result = assembleContractRows([
      frag({ row: 1, cell: 0, table: 'pdf:table:p8:t1', page: 8, text: 'Vegetative', hint: 'category' }),
      frag({ row: 1, cell: 1, table: 'pdf:table:p8:t1', page: 8, text: 'Loading and Hauling Vegetative Debris', hint: 'description' }),
      frag({ row: 1, cell: 2, table: 'pdf:table:p8:t1', page: 8, text: 'CY', hint: 'unit' }),
      frag({ row: 1, cell: 3, table: 'pdf:table:p8:t1', page: 8, text: '$27.00', hint: 'unit_price', source: 'ocr_fallback', geometry }),
    ]);

    const row = result.rows[0];
    const rateEvidence = row?.evidence_refs.find((ref) => ref.field_assigned === 'unit_price');
    assert.equal(rateEvidence?.geometry?.x_min, 620);
    assert.equal(rateEvidence?.geometry?.x_max, 690);
    assert.equal(rateEvidence?.geometry?.table_id, 'pdf:table:p8:t1');
    assert.equal(rateEvidence?.geometry?.row_id, 'pdf:table:p8:t1:r1');
    assert.equal(rateEvidence?.geometry?.cell_index, 3);
    assert.equal(row?.raw_fragments.find((fragment) => fragment.cell_text === '$27.00')?.geometry?.x_max, 690);
  });

  it('does not preserve malformed fragment geometry as typed provenance', () => {
    const malformedGeometry = { text: '$27.00' } as TableCellGeometry;
    const result = assembleContractRows([
      frag({ row: 1, cell: 0, table: 'pdf:table:p8:t1', page: 8, text: 'Vegetative', hint: 'category' }),
      frag({ row: 1, cell: 1, table: 'pdf:table:p8:t1', page: 8, text: 'Loading and Hauling Vegetative Debris', hint: 'description' }),
      frag({ row: 1, cell: 2, table: 'pdf:table:p8:t1', page: 8, text: 'CY', hint: 'unit' }),
      frag({ row: 1, cell: 3, table: 'pdf:table:p8:t1', page: 8, text: '$27.00', hint: 'unit_price', source: 'ocr_fallback', geometry: malformedGeometry }),
    ]);

    const row = result.rows[0];
    const rateEvidence = row?.evidence_refs.find((ref) => ref.field_assigned === 'unit_price');
    assert.equal(rateEvidence?.geometry, undefined);
    assert.equal(row?.raw_fragments.find((fragment) => fragment.cell_text === '$27.00')?.geometry, undefined);
  });

  it('assembles all 6 Williamson 2026-002 rows exactly', () => {
    const result = assemble(williamsonFragments);

    assert.equal(result.rows.length, 6);
    assert.deepEqual(result.rows.map((row) => row.rate_code), ['1A', '1B', '1E', '1F', '5A', '6A']);
    assert.equal(result.rejected_rows.length, 2);

    const expected = [
      ['1A', 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 0 to 15', 43894.00, 6.90, 302868.60],
      ['1B', 'Vegetative Collect Remove Haul Unincorporated Neighborhoods ROW to DMS 16 to 30', 12250.00, 7.90, 96775.00],
      ['1E', 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 0 to 15', 3099.00, 13.50, 41836.50],
      ['1F', 'Vegetative Collect Remove Haul Rural Areas ROW to DMS 16 to 30', 916.00, 14.50, 13282.00],
      ['5A', 'Tree Operations Hazardous Tree Removal 6-12 in', 5.00, 95.00, 475.00],
      ['6A', 'Tree Operations Hazardous Hanging Limb Removal >2" per tree', 994.00, 80.00, 79520.00],
    ] as const;

    for (const [code, description, quantity, unitPrice, lineTotal] of expected) {
      const row = rowByCode(result.rows, code);
      assert.equal(row.description, description);
      assert.equal(row.quantity, quantity);
      assert.equal(row.unit_price, unitPrice);
      assert.equal(row.line_total, lineTotal);
      assert.ok(!/INVOICE|Aftermath|Williamson County|Due Date|Emergency Agmt/.test(row.description ?? ''));
    }
  });

  it('recovers split rate code, multi-cell descriptions, unit price, subtotal rejection, and duplicate collapse', () => {
    const result = assemble([
      frag({ row: 1, cell: 0, text: '1' }),
      frag({ row: 1, cell: 1, text: 'A Vegetative' }),
      frag({ row: 1, cell: 2, text: 'Collect Remove Haul' }),
      frag({ row: 1, cell: 3, text: '10.00' }),
      frag({ row: 1, cell: 4, text: 'ROW' }),
      frag({ row: 1, cell: 5, text: '6.90' }),
      frag({ row: 1, cell: 6, text: '69.00' }),
      frag({ row: 1, cell: 6, text: '69.00' }),
      frag({ row: 2, cell: 0, text: 'Subtotal' }),
      frag({ row: 2, cell: 1, text: '69.00' }),
    ]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.rate_code, '1A');
    assert.equal(result.rows[0]?.description, 'Vegetative Collect Remove Haul');
    assert.equal(result.rows[0]?.unit, 'ROW');
    assert.equal(result.rows[0]?.unit_price, 6.90);
    assert.equal(result.rejected_rows.length, 1);
  });

  it('merges continuation rows into the parent line item', () => {
    const result = assemble([
      frag({ row: 1, cell: 0, text: '5A' }),
      frag({ row: 1, cell: 1, text: 'Tree Operations Hazardous Tree Removal' }),
      frag({ row: 1, cell: 2, text: '5.00' }),
      frag({ row: 1, cell: 3, text: '95.00' }),
      frag({ row: 1, cell: 4, text: '475.00' }),
      frag({ row: 2, cell: 0, text: '6-12 in' }),
    ]);

    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0]?.description, 'Tree Operations Hazardous Tree Removal 6-12 in');
    assert.equal(result.rows[0]?.confidence, 0.5);
  });

  it('rejects headers/subtotals and does not emit invoice header text as a line item', () => {
    const result = assemble([
      frag({ row: 1, cell: 0, text: 'INVOICE Description Quantity Unit Price Line Total' }),
      frag({ row: 2, cell: 0, text: 'Subtotal' }),
      frag({ row: 2, cell: 1, text: '100.00' }),
      frag({ row: 3, cell: 0, text: 'Aftermath Disaster Recovery Invoice No 2026-002' }),
    ]);

    assert.equal(result.rows.length, 0);
    assert.equal(result.rejected_rows.length, 2);
    assert.equal(result.unclassified_rows.length, 1);
  });

  it('accepts valid candidate_value and rejects conflicting candidate_value', () => {
    const result = assemble([
      frag({ row: 1, cell: 0, text: '1A', candidate: '1A' }),
      frag({ row: 1, cell: 1, text: 'Vegetative Haul' }),
      frag({ row: 1, cell: 2, text: '10.00', candidate: 99 }),
      frag({ row: 1, cell: 3, text: '6.90' }),
      frag({ row: 1, cell: 4, text: '69.00' }),
    ]);

    const row = rowByCode(result.rows, '1A');
    assert.equal(row.quantity, 10.00);
    assert.equal(row.evidence_refs.find((ref) => ref.field_assigned === 'rate_code')?.confidence, 0.85);
    assert.equal(row.evidence_refs.find((ref) => ref.field_assigned === 'quantity')?.raw_text, '10.00');
  });

  it('works without candidate_value fallback path', () => {
    const result = assemble([
      frag({ row: 1, cell: 0, text: '6A Tree Operations 994.00 80.00 79520.00' }),
    ]);

    const row = rowByCode(result.rows, '6A');
    assert.equal(row.quantity, 994);
    assert.equal(row.unit_price, 80);
    assert.equal(row.line_total, 79520);
    assert.equal(row.confidence, 0.7);
  });

  it('preserves evidence refs for assigned fields and emits deterministic low confidence warnings', () => {
    const first = assemble([
      frag({ row: 1, cell: 0, text: '1A Vegetative Haul 10.00 6.90 69.00' }),
      frag({ row: 2, cell: 0, text: 'continued service area' }),
    ]);
    const second = assemble([
      frag({ row: 1, cell: 0, text: '1A Vegetative Haul 10.00 6.90 69.00' }),
      frag({ row: 2, cell: 0, text: 'continued service area' }),
    ]);

    const row = rowByCode(first.rows, '1A');
    assert.ok(row.evidence_refs.length > 0);
    for (const field of ['rate_code', 'description', 'quantity', 'unit_price', 'line_total'] as const) {
      assert.ok(row.evidence_refs.some((ref) => ref.field_assigned === field), `${field} evidence missing`);
    }
    assert.equal(row.confidence, 0.5);
    assert.ok(row.warnings.some((warning) => warning.includes('below 0.60')));
    assert.deepEqual(first.rows.map((candidate) => candidate.confidence), second.rows.map((candidate) => candidate.confidence));
  });

  describe('Group F - contract semantic normalization', () => {
    it('classifies contract schedule rows by semantic role and avoids transactional arithmetic warnings', () => {
      const result = assembleContractRows([
        ...contractRow({ row: 1, category: 'Management & Reduction', description: 'Grinding and Chipping Vegetative Debris', unit: 'Cubic Yard', rate: '$2.25' }),
        ...contractRow({ row: 2, category: 'Final Disposal', description: 'Tipping Fee - Vegetative', unit: 'Cubic Yard', rate: 'Passthrough' }),
        ...contractRow({ row: 3, category: 'Personnel', description: 'Operations Supervisor', unit: 'Hour', rate: '$95.00' }),
        ...contractRow({ row: 4, category: 'Vegetative Collect', description: '16-30 Miles from ROW to DMS', unit: 'Cubic Yard', rate: '$7.90' }),
        ...contractRow({ row: 5, category: 'Vegetative Collect', description: 'Single Cost from ROW to DMS - Any Distance', unit: 'Cubic Yard', rate: '$12.00' }),
      ]);

      assert.deepEqual(result.rows.map((row) => row.row_role), [
        'unit_rate_definition',
        'passthrough_rate',
        'hourly_tm_rate',
        'mileage_tier_rate',
        'lump_sum_rate',
      ]);
      assert.equal(result.rows[1]?.unit_price, undefined);
      assert.equal(result.rows[1]?.confidence, 1);
      assert.equal(result.rows[3]?.mileage_tier, '16-30');
      assert.equal(result.rows[3]?.site_type, 'ROW_to_DMS');
      assert.equal(result.rows[4]?.mileage_tier, 'any');
      assert.ok(result.rows.every((row) => row.quantity == null && row.line_total == null));
      assert.ok(result.rows.every((row) => !row.warnings.some((warning) => warning.includes('reconcile'))));
      assert.ok(result.rows[0]!.confidence > 0.85);
    });

    it('classifies section header rows separately from operational rows', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'SECTION 2 - TIME AND MATERIALS' }),
      ]);

      assert.equal(result.rows.length, 0);
      assert.equal(result.rejected_rows[0]?.row_role, 'section_header');
    });

    it('does not promote mileage-only OCR fragments without a rate cell', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'Vegetative Collect, Remove & Haul', hint: 'description' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '16-30 Miles from ROW to DMS', hint: 'description' }),
        frag({ row: 1, cell: 2, table: 'contract-rate-table', text: 'Cubic Yard', hint: 'unit' }),
      ]);

      assert.equal(result.rows.length, 0);
      assert.equal(result.unclassified_rows.length, 1);
      assert.equal(result.unclassified_rows[0]?.row_role, 'unclassified');
    });

    it('uses the trailing amount in OCR rate cells that also contain mileage text', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'G&D Collect, Remove & Haul 31-60 Miles from ROW to DMS', hint: 'description' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '31-60 Miles from ROW10 DMS $8.90', hint: 'unit_price' }),
      ]);

      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]?.unit_price, 8.9);
      assert.equal(result.rows[0]?.mileage_tier, '31-60');
    });

    it('recovers safe OCR-compressed ROW to DMS and DMS to FDS mileage tiers', () => {
      const result = assembleContractRows([
        ...contractRow({
          row: 1,
          category: 'Vegetative',
          description: 'Collect, Remove & Haul 0-15 Milesfrom ROW t6 DMS',
          unit: 'Cubic Yard',
          rate: '$6.90',
        }),
        ...contractRow({
          row: 2,
          category: 'Vegetative',
          description: 'Collect, Remove & Haul 16-30 Miles from ROWtoDMS',
          unit: 'Cubic Yard',
          rate: '$7.90',
        }),
        ...contractRow({
          row: 3,
          category: 'Final Disposal',
          description: '31-60 Miles from DMS to Final Disposal',
          unit: 'Cubic Yard',
          rate: '$4.25',
        }),
      ]);

      assert.equal(result.rows.length, 3);
      assert.equal(result.rows[0]?.mileage_tier, '0-15');
      assert.equal(result.rows[0]?.site_type, 'ROW_to_DMS');
      assert.equal(result.rows[1]?.mileage_tier, '16-30');
      assert.equal(result.rows[1]?.site_type, 'ROW_to_DMS');
      assert.equal(result.rows[2]?.mileage_tier, '31-60');
      assert.equal(result.rows[2]?.site_type, 'DMS_to_FDS');
    });

    it('normalizes collapsed OCR currency only in contract schedule rows and records governance', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'G&D Collect, Remove & Haul 31-60 Miles from ROW to DMS', hint: 'description', source: 'ocr_fallback' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '$890', hint: 'unit_price', source: 'ocr_fallback' }),
      ]);

      assert.equal(result.rows.length, 1);
      assert.equal(result.rows[0]?.unit_price, 8.9);
      assert.ok(result.rows[0]?.warnings.includes('ocr currency normalization applied'));
      assert.deepEqual(result.rows[0]?.ocr_normalization_actions, ['$890 -> 8.90']);
      assert.ok(result.rows[0]?.confidence < 0.9);
      assert.ok(result.rows[0]?.confidence_penalties?.includes('ocr currency normalization applied'));
    });

    it('keeps multi-rate OCR cells unclassified instead of choosing silently', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'Management & Reduction Compacting', hint: 'description', source: 'ocr_fallback' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: 'Cubic Yard $1.00 $1.50', hint: 'unit_price', source: 'ocr_fallback' }),
      ]);

      assert.equal(result.rows.length, 0);
      assert.equal(result.unclassified_rows.length, 1);
      assert.ok(result.unclassified_rows[0]?.warnings.includes('multiple candidate rates detected'));
      assert.ok(result.unclassified_rows[0]?.warnings.includes('ambiguous OCR rate cell'));
      assert.deepEqual(result.unclassified_rows[0]?.raw_candidate_values, ['$1.00', '$1.50']);
    });

    it('does not promote 60+ mileage text as a 60.00 rate when lower currency evidence is present', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'Vegetative Collect, Remove & Haul 60+ Miles from ROW to DMS', hint: 'description', source: 'ocr_fallback' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '$10.90 / 60+', hint: 'unit_price', source: 'ocr_fallback' }),
      ]);

      assert.equal(result.rows.length, 0);
      assert.equal(result.unclassified_rows.length, 1);
      assert.notEqual(result.unclassified_rows[0]?.unit_price, 60);
    });

    it('keeps ambiguous non-currency rate candidates unclassified', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'Vegetative Collect 31-60 Miles from ROW to DMS', hint: 'description', source: 'ocr_fallback' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '31 60', hint: 'unit_price', source: 'ocr_fallback' }),
      ]);

      assert.equal(result.rows.length, 0);
      assert.equal(result.unclassified_rows.length, 1);
      assert.ok(result.unclassified_rows[0]?.warnings.includes('rate candidate source is ambiguous'));
    });

    it('recovers 0-15 and 16-30 ROW to DMS rows only with explicit rate evidence', () => {
      const safe = assembleContractRows([
        ...contractRow({ row: 1, description: '0-15 Miles from ROW to DMS', unit: 'Cubic Yard', rate: '$6.90' }),
        ...contractRow({ row: 2, description: '16-30 Miles from ROW to DMS', unit: 'Cubic Yard', rate: '$7.90' }),
      ]);
      const weak = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: '0-15 Miles from ROW to DMS', hint: 'description', source: 'ocr_fallback' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '6.90', hint: 'unit_price', source: 'ocr_fallback' }),
      ]);

      assert.equal(safe.rows.length, 2);
      assert.equal(safe.rows[0]?.unit_price, 6.9);
      assert.equal(safe.rows[1]?.unit_price, 7.9);
      assert.equal(weak.rows.length, 0);
      assert.equal(weak.unclassified_rows.length, 1);
    });

    it('preserves DMS to FDS site_type and mileage_tier on recovered rows', () => {
      const result = assembleContractRows([
        ...contractRow({ row: 1, category: 'Final Disposal', description: '16-30 Miles from DMS to FDS', unit: 'Cubic Yard', rate: '$3.50' }),
        ...contractRow({ row: 2, category: 'Final Disposal', description: '31-60 Miles from DMS to Final Disposal', unit: 'Cubic Yard', rate: '$4.25' }),
      ]);

      assert.equal(result.rows.length, 2);
      assert.equal(result.rows[0]?.site_type, 'DMS_to_FDS');
      assert.equal(result.rows[0]?.mileage_tier, '16-30');
      assert.equal(result.rows[1]?.site_type, 'DMS_to_FDS');
      assert.equal(result.rows[1]?.mileage_tier, '31-60');
    });

    it('recovers tree, hanging limb, grinding, and open burning rows with clear rate and unit evidence', () => {
      const result = assembleContractRows([
        ...contractRow({ row: 1, category: 'Tree Operations', description: 'Hazardous Tree Removal 6-12 inch', unit: 'Tree', rate: '$95.00' }),
        ...contractRow({ row: 2, category: 'Tree Operations', description: 'Hanging Limb Removal >2 inch', unit: 'Tree', rate: '$80.00' }),
        ...contractRow({ row: 3, category: 'Management & Reduction', description: 'Grinding/Chipping Vegetative Debris', unit: 'Cubic Yard', rate: '$2.25' }),
        ...contractRow({ row: 4, category: 'Management & Reduction', description: 'Open Burning Vegetative Debris', unit: 'Cubic Yard', rate: '$1.50' }),
      ]);

      assert.equal(result.rows.length, 4);
      assert.deepEqual(result.rows.map((row) => row.unit_price), [95, 80, 2.25, 1.5]);
      assert.deepEqual(result.rows.map((row) => row.unit), ['Tree', 'Tree', 'CY', 'CY']);
    });

    it('downgrades severe OCR noise rows without flow context', () => {
      const result = assembleContractRows([
        frag({ row: 1, cell: 0, table: 'contract-rate-table', text: 'CBD Colloct, Remove nemo', hint: 'description', source: 'ocr_fallback' }),
        frag({ row: 1, cell: 1, table: 'contract-rate-table', text: '$10.90', hint: 'unit_price', source: 'ocr_fallback' }),
      ]);

      assert.equal(result.rows.length, 0);
      assert.equal(result.unclassified_rows.length, 1);
      assert.ok(result.unclassified_rows[0]?.warnings.some((warning) => warning.includes('contract semantic confidence governance')));
      assert.ok(result.unclassified_rows[0]?.warnings.includes('unknown unit token "CBD"'));
    });
  });

  describe('Group G - unit normalization and precedence', () => {
    it('normalizes contract units and lets hinted unit cells win over ROW in descriptions', () => {
      const result = assembleContractRows([
        ...contractRow({ row: 1, description: '0-15 Miles from ROW to DMS', unit: 'Cubic Yard', rate: '$6.90' }),
        ...contractRow({ row: 2, description: 'Grinding', unit: 'Pound/Unit', rate: '$20.00/Unit' }),
      ]);

      assert.equal(result.rows[0]?.unit, 'CY');
      assert.equal(result.rows[0]?.description, '0-15 Miles from ROW to DMS');
      assert.equal(result.rows[0]?.mileage_tier, '0-15');
      assert.equal(result.rows[1]?.unit, 'Pound/Unit');
      assert.ok(result.rows.every((row) => !row.warnings.some((warning) => /unknown unit token "(?:DMS|FDS|ROW)"/.test(warning))));
    });

    it('keeps ROW valid as a transactional invoice unit token', () => {
      const result = assemble([
        frag({ row: 1, cell: 0, text: '1A' }),
        frag({ row: 1, cell: 1, text: 'Vegetative Haul' }),
        frag({ row: 1, cell: 2, text: '10.00' }),
        frag({ row: 1, cell: 3, text: 'ROW' }),
        frag({ row: 1, cell: 4, text: '6.90' }),
        frag({ row: 1, cell: 5, text: '69.00' }),
      ]);

      assert.equal(result.rows[0]?.unit, 'ROW');
    });
  });

  describe('Group H - description immutability', () => {
    it('preserves contract description text while deriving mileage and site fields', () => {
      const description = '0-15 Miles from ROW to DMS';
      const result = assembleContractRows([
        ...contractRow({ description, unit: 'CY', rate: '$6.90' }),
      ]);

      assert.equal(result.rows[0]?.description, description);
      assert.ok(result.rows[0]?.description?.includes('0-15 Miles'));
      assert.ok(result.rows[0]?.description?.includes('ROW to DMS'));
      assert.equal(result.rows[0]?.site_type, 'ROW_to_DMS');
    });
  });

  describe('Group I - category field', () => {
    it('populates category separately from service_item', () => {
      const result = assembleContractRows([
        ...contractRow({ category: 'Tree Operations', description: 'Hazardous Trees 6-12 trunk diameter', unit: 'Tree', rate: '$95.00' }),
        frag({ row: 1, cell: 4, table: 'pdf_table_p8_t26', page: 8, text: '6 - Hangers', hint: 'service_item' }),
      ]);

      assert.equal(result.rows[0]?.category, 'Tree Operations');
      assert.equal(result.rows[0]?.service_item, '6 - Hangers');
    });
  });

  describe('Group J - lineage and metadata', () => {
    it('keeps row IDs deterministic and metadata present on canonical rows', () => {
      const fragments = contractRow({ row: 5, category: 'Equipment', description: 'Tub Grinder (800-1,000 HP)', unit: 'Hour', rate: '$500.00' });
      const first = assembleContractRows(fragments);
      const second = assembleContractRows(fragments);

      assert.equal(first.rows[0]?.row_id, second.rows[0]?.row_id);
      assert.equal(first.rows[0]?.row_id, 'contract:pdf_table_p8_t26:p8:r5');
      assert.equal(first.rows[0]?.assembly_semantic_mode, 'schedule_definition');
      assert.equal(first.rows[0]?.source_table_key, 'pdf_table_p8_t26');
      assert.equal(first.rows[0]?.source_document_family, 'contract');
    });
  });
});
