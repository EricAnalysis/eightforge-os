/**
 * Pricing assembly grain — source-derived, with explicit authored equivalence.
 *
 * Grain used to key on the operator-facing display description, which display
 * cleanup rewrites, so a display decision could determine whether two physical
 * rows collapsed. Measured on Golden, that merged ten materially distinct line
 * items into their neighbours — three dozer models at different rates, two dump
 * truck capacities, Soil & Sand into Electronic Waste.
 *
 * Precedence now:
 *   1. explicit authored equivalence assertion → approved collapse;
 *   2. otherwise document-scoped source observation identity;
 *   3. otherwise the rows stay distinct.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { assembleContractPricingRowsWithCandidates } from '@/lib/contracts/contractPricingAssembly';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';

const DOC_A = { documentId: 'doc-a', sourceVersionIdentity: null };
const DOC_B = { documentId: 'doc-b', sourceVersionIdentity: null };

function equipmentRow(overrides: Partial<ContractRateScheduleRow> = {}): ContractRateScheduleRow {
  return {
    row_id: 'exhibit_a_table:pdf:table:p10:t36:r1',
    description: 'Skid Steer Loader',
    category: 'Equipment',
    source_category: 'Equipment',
    canonical_category: 'equipment',
    category_confidence: 0.95,
    unit: 'Hour',
    unit_type: 'Hour',
    rate: 105,
    rate_amount: 105,
    page: 10,
    confidence: 'high',
    source_kind: 'exhibit_a_table',
    source_anchor_ids: ['pdf:table:p10:t36:r1'],
    ...overrides,
  } as ContractRateScheduleRow;
}

/** All emitted rows, selected plus candidate-only, for grain assertions. */
function assemble(rows: readonly ContractRateScheduleRow[], scope = DOC_A) {
  return assembleContractPricingRowsWithCandidates(rows, scope);
}

describe('grain is derived from source truth, not display text', () => {
  it('keeps two rows distinct when display cleanup gives them the same label', () => {
    // The Golden dozer defect: different models, different rates, one recovered
    // display label. Before the repair these collapsed to a single row.
    const result = assemble([
      equipmentRow({ row_id: 'r26', description: 'Il CAT D4 Dozer oe', rate: 1146, rate_amount: 1146 }),
      equipmentRow({ row_id: 'r30', description: 'CAT D8 Dozer', rate: 186, rate_amount: 186 }),
    ]);

    assert.equal(result.selectedRows.length, 2);
    assert.deepEqual(
      result.selectedRows.map((row) => row.sourceDescription).sort(),
      ['CAT D8 Dozer', 'Il CAT D4 Dozer oe'],
    );
  });

  it('keeps distinct equipment at the same rate and unit distinct', () => {
    // The Dump Truck case: identical on every source field except the
    // description, and display cleanup reduces both to "Dump Truck".
    const result = assemble([
      equipmentRow({
        row_id: 'r6', page: 11,
        description: 'Equi ent Dump Truck, 16-20 Cu. Yd. Capaeity',
        rate: 170, rate_amount: 170,
      }),
      equipmentRow({
        row_id: 'r7', page: 11,
        description: 'Dump Truck, 21-40 Cu, 4 Yd, Capacity -',
        rate: 170, rate_amount: 170,
      }),
    ]);

    assert.equal(result.selectedRows.length, 2, 'two capacities are two line items');
    assert.equal(new Set(result.selectedRows.map((row) => row.sourceDescription)).size, 2);
  });

  it('collapses rows that are identical in every source field', () => {
    const result = assemble([
      equipmentRow({ row_id: 'a', confidence: 'needs_review' }),
      equipmentRow({ row_id: 'b', confidence: 'high' }),
    ]);

    assert.equal(result.selectedRows.length, 1, 'one physical observation, extracted twice');
  });

  it('never collapses rows from different documents', () => {
    const a = assemble([equipmentRow()], DOC_A).selectedRows;
    const b = assemble([equipmentRow()], DOC_B).selectedRows;

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.notEqual(a[0]?.sourceDocumentId, b[0]?.sourceDocumentId);
  });

  it('does not let a display sentinel merge unrelated rows', () => {
    // Both rows display `Raw row needs review`; their source text differs, so
    // they are two observations.
    const result = assemble([
      equipmentRow({ row_id: 'x', description: 'ansports', rate: 115, rate_amount: 115 }),
      equipmentRow({ row_id: 'y', description: 'pment me', rate: 115, rate_amount: 115 }),
    ]);

    assert.equal(result.selectedRows.length, 2);
  });
});

describe('authored equivalence is explicit, exceptional, and grain-bearing', () => {
  /** The Exhibit A page 9 hazardous-trees cell, seen by both extractors. */
  function hazardousTreesPair(): readonly ContractRateScheduleRow[] {
    return [
      {
        row_id: 'exhibit_a_text_recovery:tree-hazardous-6-12-95-00',
        description: 'Hazardous Trees 6 to 12 inch trunk',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        canonical_category: 'tree_operations',
        category_confidence: 1,
        unit: 'Tree', unit_type: 'Tree', rate: 95, rate_amount: 95, page: 9,
        confidence: 'medium', source_kind: 'exhibit_a_text_recovery',
        source_anchor_ids: ['pdf:text:p9:b1'],
      },
      {
        row_id: 'exhibit_a_table:pdf:table:p9:t33:r4',
        description: 'Hazardous Trees 6"-12" trunk',
        category: 'Tree Operations',
        source_category: 'Tree Operations',
        canonical_category: 'tree_operations',
        category_confidence: 0.95,
        unit: 'Tree', unit_type: 'Tree', rate: 96, rate_amount: 96, page: 9,
        rate_raw: '$96.00',
        raw_text: '| Tree Operations Hazardous Trees 6"-12" trunk Tree $96.00',
        raw_cells: ['| Tree Operations', 'Hazardous Trees 6"-12" trunk', 'Tree', '$96.00'],
        confidence: 'high', source_kind: 'exhibit_a_table',
        source_anchor_ids: ['pdf:table:p9:t33:r4', 'pdf:table:p9:t33'],
      },
    ] as ContractRateScheduleRow[];
  }

  it('merges the approved pair despite differing source descriptions', () => {
    const result = assemble(hazardousTreesPair());

    assert.equal(result.selectedRows.length, 1);
    assert.ok(
      result.selectedRows[0]?.authoredEquivalenceKey,
      'the surviving row carries the equivalence class',
    );
  });

  it('marks the merge as correction-authorized, not naturally deduced', () => {
    const [row] = assemble(hazardousTreesPair()).selectedRows;
    const diagnostic = row?.mergeDiagnostics?.[0];

    assert.equal(diagnostic?.reason, 'authored_equivalence_collapse');
    assert.equal(
      diagnostic?.authoredEquivalenceKey,
      'exhibit-a:p9:tree-operations:hazardous-trees-6-to-12-inch',
    );
  });

  it('retains both contributing rows evidence through the merge', () => {
    const [row] = assemble(hazardousTreesPair()).selectedRows;
    const diagnostic = row?.mergeDiagnostics?.[0];

    assert.ok(diagnostic?.droppedRowId, 'the dropped row id survives');
    assert.ok(diagnostic?.droppedSourceAnchor, 'the dropped anchor survives');
    // The dropped row's own observed text is retained, so the evidence that two
    // differently-described sources were combined is not lost.
    assert.ok(diagnostic?.droppedSourceDescription);
    assert.notEqual(diagnostic?.droppedSourceDescription, row?.sourceDescription);
  });

  it('does not merge across documents even with a shared equivalence key', () => {
    const [recovery, table] = hazardousTreesPair();
    const a = assemble([recovery!], DOC_A).selectedRows;
    const b = assemble([table!], DOC_B).selectedRows;

    assert.equal(a.length, 1);
    assert.equal(b.length, 1);
    assert.ok(a[0]?.authoredEquivalenceKey);
    assert.ok(b[0]?.authoredEquivalenceKey);
    assert.notEqual(a[0]?.sourceDocumentId, b[0]?.sourceDocumentId);
  });

  it('leaves the key null for ordinary rows', () => {
    const result = assemble([equipmentRow()]);
    assert.equal(result.selectedRows[0]?.authoredEquivalenceKey, null);
  });

  it('does not merge merely because a row received an authored display correction', () => {
    // Both rows hit a value-correcting rule (page 8 vegetative $18.80 -> $13.50)
    // that rewrites description and rate but asserts NO equivalence. They must
    // remain two observations.
    const corrected = (rowId: string, description: string): ContractRateScheduleRow => ({
      row_id: rowId,
      description,
      category: 'Management & Reduction',
      source_category: 'Management & Reduction',
      canonical_category: 'management_reduction',
      category_confidence: 0.9,
      unit: 'Cubic Yard', unit_type: 'Cubic Yard',
      rate: 2.25, rate_amount: 2.25, page: 8,
      confidence: 'high', source_kind: 'exhibit_a_table',
      source_anchor_ids: [`pdf:table:p8:${rowId}`],
    } as ContractRateScheduleRow);

    const result = assemble([
      corrected('g1', 'Grinding and Chipping Vegetative Debris'),
      corrected('g2', 'Something Else Entirely At The Same Rate'),
    ]);

    assert.equal(result.selectedRows.length, 2);
  });
});

describe('grain output is deterministic', () => {
  it('produces identical rows and diagnostics under reversed input order', () => {
    const rows = [
      equipmentRow({ row_id: 'r26', description: 'Il CAT D4 Dozer oe', rate: 1146, rate_amount: 1146 }),
      equipmentRow({ row_id: 'r30', description: 'CAT D8 Dozer', rate: 186, rate_amount: 186 }),
      equipmentRow({ row_id: 'r31', description: 'FrontE nd Loader', rate: 145, rate_amount: 145 }),
    ];
    const project = (result: ReturnType<typeof assemble>) =>
      [...result.selectedRows]
        .map((row) => [row.id, row.sourceDescription, row.rate, row.authoredEquivalenceKey].join('|'))
        .sort((left, right) => left.localeCompare(right, 'en-US'));

    assert.deepEqual(project(assemble(rows)), project(assemble([...rows].reverse())));
  });

  it('is stable across repeated identical runs', () => {
    const rows = [equipmentRow({ row_id: 'a' }), equipmentRow({ row_id: 'b', rate: 200, rate_amount: 200 })];
    assert.equal(
      JSON.stringify(assemble(rows).selectedRows),
      JSON.stringify(assemble(rows).selectedRows),
    );
  });
});
