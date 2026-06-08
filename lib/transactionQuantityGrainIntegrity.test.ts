import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildCanonicalTransactionSummaryFromRows,
  type CanonicalProjectTransactionRowInput,
} from '@/lib/projectFacts';

function row(params: {
  ticketNo: string;
  rateCode: string;
  cyd: number;
  mileage: number;
  extendedCost: number;
  subcontractor: string;
  clientProject?: string;
  sourceRow: number;
}): CanonicalProjectTransactionRowInput {
  return {
    id: `row-${params.sourceRow}`,
    document_id: 'williamson-ticket-query',
    project_id: 'williamson',
    invoice_number: 'INV-WILLIAMSON',
    transaction_number: null,
    rate_code: params.rateCode,
    transaction_quantity: null,
    extended_cost: params.extendedCost,
    source_sheet_name: 'Ticket Query Results',
    source_row_number: params.sourceRow,
    raw_row_json: {
      'Ticket No': params.ticketNo,
      'Ticket ID': params.ticketNo,
      'Rate Code': params.rateCode,
      CYD: params.cyd,
      Mileage: params.mileage,
      Diameter: params.ticketNo === 'COUNTY-001' ? 2632 : null,
      'Net Tonnage': null,
      'Extended Cost': params.extendedCost,
      Subcontractor: params.subcontractor,
      'Client Project': params.clientProject ?? 'Williamson Co TN COUNTY Fern 0126',
      'Invoice #': 'INV-WILLIAMSON',
    },
    record_json: {},
    created_at: '2026-06-07T00:00:00Z',
  };
}

function buildWilliamsonQuantityRows(): CanonicalProjectTransactionRowInput[] {
  return [
    row({ ticketNo: 'COUNTY-001', rateCode: 'RC-A', cyd: 2000, mileage: 1000, extendedCost: 100000, subcontractor: 'County', sourceRow: 1 }),
    row({ ticketNo: 'COUNTY-001', rateCode: 'RC-B', cyd: 2000, mileage: 1000, extendedCost: 100000, subcontractor: 'County', sourceRow: 2 }),
    row({ ticketNo: 'COUNTY-001', rateCode: 'RC-C', cyd: 2000, mileage: 1000, extendedCost: 100000, subcontractor: 'County', sourceRow: 3 }),
    row({ ticketNo: 'COUNTY-002', rateCode: 'RC-A', cyd: 2186, mileage: 1000, extendedCost: 100000, subcontractor: 'County', sourceRow: 4 }),
    row({ ticketNo: 'COUNTY-PILE-001', rateCode: 'RC-A', cyd: 3926, mileage: 2000, extendedCost: 100000, subcontractor: 'County pile', sourceRow: 5 }),
    row({ ticketNo: 'COUNTY-PILE-001', rateCode: 'RC-B', cyd: 3926, mileage: 2000, extendedCost: 100000, subcontractor: 'County pile', sourceRow: 6 }),
    row({ ticketNo: 'NOLENSVILLE-001', rateCode: 'RC-A', cyd: 2225, mileage: 2000, extendedCost: 100000, subcontractor: 'Williamson County Nolensville Park Pile', sourceRow: 7 }),
    row({ ticketNo: 'NOLENSVILLE-001', rateCode: 'RC-B', cyd: 2225, mileage: 2000, extendedCost: 100000, subcontractor: 'Williamson County Nolensville Park Pile', sourceRow: 8 }),
    row({ ticketNo: 'OTHER-001', rateCode: 'RC-A', cyd: 64280, mileage: 4434, extendedCost: 15559.35, subcontractor: 'Other', clientProject: 'Williamson Co TN MAIN', sourceRow: 9 }),
  ];
}

function rawNumber(rowInput: CanonicalProjectTransactionRowInput, key: string): number {
  const value = rowInput.raw_row_json?.[key];
  assert.equal(typeof value, 'number');
  return value as number;
}

function rawText(rowInput: CanonicalProjectTransactionRowInput, key: string): string {
  const value = rowInput.raw_row_json?.[key];
  assert.equal(typeof value, 'string');
  return value as string;
}

function countyPartition(rows: readonly CanonicalProjectTransactionRowInput[]): Record<string, number> {
  const valuesBySubcontractor = new Map<string, Map<string, number>>();

  for (const rowInput of rows) {
    if (!rawText(rowInput, 'Client Project').toLowerCase().includes('county')) continue;
    const subcontractor = rawText(rowInput, 'Subcontractor');
    const ticketNo = rawText(rowInput, 'Ticket No');
    const cyd = rawNumber(rowInput, 'CYD');
    const ticketValues = valuesBySubcontractor.get(subcontractor) ?? new Map<string, number>();
    const existing = ticketValues.get(ticketNo);
    if (existing != null && existing !== cyd) {
      throw new Error(`Fixture quantity invariant violated for ${ticketNo}`);
    }
    ticketValues.set(ticketNo, cyd);
    valuesBySubcontractor.set(subcontractor, ticketValues);
  }

  return Object.fromEntries(
    [...valuesBySubcontractor.entries()].map(([subcontractor, ticketValues]) => [
      subcontractor,
      [...ticketValues.values()].reduce((sum, value) => sum + value, 0),
    ]),
  );
}

describe('transaction quantity grain integrity', () => {
  it('dedups Williamson-shaped CYD and mileage by raw Ticket No while preserving row-grain amounts', () => {
    const rows = buildWilliamsonQuantityRows();
    const summary = buildCanonicalTransactionSummaryFromRows(rows);

    assert.equal(summary.total_cyd_ticket_grain, 74617);
    assert.equal(summary.total_cyd, 74617);
    assert.equal(summary.total_mileage_ticket_grain, 10434);
    assert.equal(summary.total_diameter, 2632);
    assert.equal(summary.total_net_tonnage, 0);
    assert.equal(summary.total_extended_cost, 815559.35);

    assert.deepEqual(countyPartition(rows), {
      County: 4186,
      'County pile': 3926,
      'Williamson County Nolensville Park Pile': 2225,
    });
  });

  it('errors loudly when a repeated ticket has non-uniform raw CYD values', () => {
    const rows = [
      row({ ticketNo: 'BAD-001', rateCode: 'RC-A', cyd: 10, mileage: 1, extendedCost: 10, subcontractor: 'County', sourceRow: 1 }),
      row({ ticketNo: 'BAD-001', rateCode: 'RC-B', cyd: 11, mileage: 1, extendedCost: 10, subcontractor: 'County', sourceRow: 2 }),
    ];

    assert.throws(
      () => buildCanonicalTransactionSummaryFromRows(rows),
      /non-uniform cyd values/,
    );
  });
});
