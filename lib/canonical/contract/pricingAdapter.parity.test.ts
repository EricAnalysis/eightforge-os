/**
 * Current-assembler parity and recovery analysis.
 *
 * This is the only file in the slice that calls `assembleContractPricingRows`.
 * The adapter itself never does. The purpose is to measure, on Golden and
 * alternate-layout inputs:
 *
 *   - how many rows the assembler emits;
 *   - how many become canonical candidates (must be identical — no loss);
 *   - how those candidates classify into the three display groups;
 *   - how many input rows the assembler discarded BEFORE the adapter could
 *     see them (the recovery delta the architecture review asked for).
 *
 * The adapter cannot recover rows already discarded upstream. That limit is
 * measured here, not worked around.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { assembleContractPricingRows } from '@/lib/contracts/contractPricingAssembly';
import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import { adaptAssembledPricingRows } from '@/lib/canonical/contract/pricingAdapter';
import {
  buildCanonicalPricingSchedule,
  resolveCanonicalPricingRow,
} from '@/lib/canonical/contract/pricingResolution';

const CONTEXT = {
  documentId: 'golden-contract',
  governingDocument: {
    documentId: 'golden-contract',
    family: 'contract',
    title: 'Golden governing contract',
  },
  rateSchedule: { scheduleId: 'golden-schedule', scheduleName: 'Contract rate schedule' },
};

function scheduleFor(inputs: readonly ContractRateScheduleRow[]) {
  const assembled = assembleContractPricingRows(inputs);
  const candidates = adaptAssembledPricingRows(assembled, CONTEXT);
  const rows = candidates.map((candidate) => resolveCanonicalPricingRow(candidate));
  const schedule = buildCanonicalPricingSchedule({ rows });
  return {
    inputCount: inputs.length,
    assembledCount: assembled.length,
    candidateCount: candidates.length,
    droppedUpstream: inputs.length - assembled.length,
    schedule,
  };
}

// ─── Golden Project ──────────────────────────────────────────────────────────

function goldenRow(overrides: Partial<ContractRateScheduleRow> = {}): ContractRateScheduleRow {
  return {
    row_id: 'golden:rate-row:1',
    description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    unit: 'Cubic Yard',
    rate: 6.9,
    category: 'Vegetative Collect, Remove & Haul',
    source_category: 'Vegetative Collect, Remove & Haul',
    canonical_category: 'vegetative',
    category_confidence: 0.92,
    page: 8,
    source_anchor_ids: ['golden:anchor:p8:b12'],
    rate_raw:
      'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $6.90',
    material_type: 'Vegetative Collect, Remove & Haul',
    unit_type: 'Cubic Yard',
    rate_amount: 6.9,
    ...overrides,
  };
}

/**
 * A Golden-shaped input set with deliberately degraded rows.
 *
 * Measured behaviour of the current assembler on these inputs (verified, not
 * assumed — earlier drafts of this fixture guessed wrong):
 *
 *   - `no-unit`  → unit is RECOVERED by re-parsing `rate_raw`; the row survives
 *                  alone, and in this set it collides with row 1 on the dedupe
 *                  key and is suppressed WITH a merge diagnostic.
 *   - `no-rate`  → rate is RECOVERED from `rate_raw`; same dedupe suppression.
 *   - `no-category` → category is RECOVERED from the classification text; the
 *                  row survives and is emitted with its unreadable description.
 *   - `no-page`  → dropped SILENTLY by `shouldKeepOperatorRow`. No diagnostic,
 *                  no trace. This is the only unrecoverable loss here.
 */
const GOLDEN_INPUTS: readonly ContractRateScheduleRow[] = [
  // emitted: complete, clean
  goldenRow(),
  // emitted: second complete row in the same category
  goldenRow({
    row_id: 'golden:rate-row:2',
    description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles',
    rate: 7.9,
    rate_amount: 7.9,
    rate_raw:
      'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles | Cubic Yard | $7.90',
  }),
  // suppressed by dedupe, but recorded as a merge diagnostic on row 1
  goldenRow({ row_id: 'golden:rate-row:no-unit', unit: null, unit_type: null }),
  // SILENTLY dropped: no page
  goldenRow({ row_id: 'golden:rate-row:no-page', page: null }),
  // suppressed by dedupe, but recorded as a merge diagnostic on row 1
  goldenRow({ row_id: 'golden:rate-row:no-rate', rate: null, rate_amount: null }),
  // emitted: category recovered from context despite an unreadable description
  goldenRow({
    row_id: 'golden:rate-row:no-category',
    category: null,
    source_category: null,
    canonical_category: null,
    description: 'Unreadable row fragment',
    rate_raw: 'Unreadable row fragment | $12.00',
  }),
];

describe('Golden parity — assembler → canonical candidates', () => {
  it('adapts every emitted row with no loss', () => {
    const result = scheduleFor(GOLDEN_INPUTS);
    assert.equal(
      result.candidateCount,
      result.assembledCount,
      'the adapter must never drop an emitted row',
    );
    assert.equal(result.schedule.coverage.candidateCount, result.assembledCount);
  });

  it('reconciles every candidate into exactly one display group', () => {
    const { schedule } = scheduleFor(GOLDEN_INPUTS);
    const { candidateCount, resolvedCount, needsReviewCount, excludedCount } = schedule.coverage;
    assert.equal(resolvedCount + needsReviewCount + excludedCount, candidateCount);
  });

  it('resolves the complete Golden rows and keeps them approval-eligible', () => {
    const { schedule } = scheduleFor(GOLDEN_INPUTS);
    const resolved = schedule.rows.filter((row) => row.resolution.displayGroup === 'resolved_pricing');
    assert.ok(resolved.length >= 1, 'at least one complete Golden row must resolve');
    for (const row of resolved) {
      assert.equal(row.resolution.approval.eligible, true);
      assert.equal(row.rate.value != null, true);
      assert.equal(row.unit.value != null, true);
      assert.equal(row.category.value != null, true);
    }
  });

  it('measures the rows discarded upstream, which the adapter cannot recover', () => {
    const result = scheduleFor(GOLDEN_INPUTS);
    assert.equal(result.inputCount, 6);
    assert.equal(result.assembledCount, 3);
    assert.equal(result.droppedUpstream, 3);
    assert.equal(result.droppedUpstream, result.inputCount - result.assembledCount);
    console.log('[parity:golden]', JSON.stringify({
      inputCount: result.inputCount,
      assembledCount: result.assembledCount,
      candidateCount: result.candidateCount,
      droppedUpstream: result.droppedUpstream,
      emittedRowIds: result.schedule.rows.map((row) => row.rowId),
      coverage: result.schedule.coverage,
    }));
  });

  it('retains dedupe-suppressed rows as merge diagnostics on the surviving row', () => {
    const { schedule } = scheduleFor(GOLDEN_INPUTS);
    // Row identity is document-scoped; `assembleContractPricingRows` is the
    // compatibility wrapper, so that is the scope these rows carry.
    const survivor = schedule.rows.find(
      (row) => row.rowId === 'compatibility-wrapper:golden:rate-row:1',
    );
    assert.ok(survivor, 'the winning row must be emitted');

    const suppressedIds = survivor.mergeDiagnostics.map((d) => d.droppedRowId).sort();
    assert.deepEqual(suppressedIds, [
      'golden:rate-row:no-rate',
      'golden:rate-row:no-unit',
    ]);
    // Two of the three "lost" rows are therefore auditable in canonical output,
    // even though they are not resurrected as rows.
    assert.equal(survivor.mergeDiagnostics.length, 2);
  });

  it('cannot see a silently dropped row anywhere in canonical output', () => {
    const { schedule } = scheduleFor(GOLDEN_INPUTS);
    const serialized = JSON.stringify(schedule);
    // The missing-page row leaves no trace: not a row, not a diagnostic, not
    // an evidence reference. This is the exact limit of the adapter.
    assert.equal(
      serialized.includes('golden:rate-row:no-page'),
      false,
      'a silently dropped row is unrecoverable downstream — this documents the limit',
    );
  });
});

// ─── Alternate pricing layout (uncategorized canonical price-sheet rows) ─────

/**
 * Price-sheet layouts reach the assembler as canonical-source rows that often
 * carry no resolvable category. The assembler preserves those (rather than
 * dropping them), which makes them the clearest case of a row that must not
 * enter the authoritative pricing group.
 */
const ALTERNATE_LAYOUT_INPUTS: readonly ContractRateScheduleRow[] = [
  {
    row_id: 'contract:price-sheet:1',
    description: 'Hauling debris to disposal facility',
    unit: 'Ton',
    rate: 41.5,
    category: null,
    source_category: null,
    canonical_category: null,
    category_confidence: null,
    page: 2,
    source_anchor_ids: ['alt:anchor:p2:t1:r1'],
    rate_raw: 'Hauling debris to disposal facility | Ton | $41.50',
    material_type: null,
    unit_type: 'Ton',
    rate_amount: 41.5,
    source_kind: 'structural_table',
  },
  {
    row_id: 'contract:price-sheet:2',
    description: 'Stump removal 24 inch and greater',
    unit: 'Each',
    rate: 180,
    category: null,
    source_category: null,
    canonical_category: null,
    category_confidence: null,
    page: 2,
    source_anchor_ids: ['alt:anchor:p2:t1:r2'],
    rate_raw: 'Stump removal 24 inch and greater | Each | $180.00',
    material_type: null,
    unit_type: 'Each',
    rate_amount: 180,
    source_kind: 'structural_table',
  },
];

describe('Alternate pricing layout parity', () => {
  it('adapts every emitted row with no loss', () => {
    const result = scheduleFor(ALTERNATE_LAYOUT_INPUTS);
    assert.equal(result.candidateCount, result.assembledCount);
  });

  it('never places an uncategorized row in the authoritative pricing group', () => {
    const { schedule } = scheduleFor(ALTERNATE_LAYOUT_INPUTS);
    for (const row of schedule.rows) {
      if (row.category.value == null) {
        assert.notEqual(row.resolution.displayGroup, 'resolved_pricing');
        assert.equal(row.resolution.approval.eligible, false);
      }
    }
    console.log('[parity:alternate-layout]', JSON.stringify({
      assembledCount: schedule.coverage.candidateCount,
      coverage: schedule.coverage,
      categories: schedule.rows.map((row) => row.category.state),
    }));
  });
});

// ─── Cross-fixture invariants ────────────────────────────────────────────────

describe('parity invariants across fixtures', () => {
  it('holds no-loss and group reconciliation on every fixture', () => {
    for (const inputs of [GOLDEN_INPUTS, ALTERNATE_LAYOUT_INPUTS]) {
      const result = scheduleFor(inputs);
      assert.equal(result.candidateCount, result.assembledCount);
      const { candidateCount, resolvedCount, needsReviewCount, excludedCount } =
        result.schedule.coverage;
      assert.equal(resolvedCount + needsReviewCount + excludedCount, candidateCount);
    }
  });

  it('is deterministic across repeated runs', () => {
    const first = scheduleFor(GOLDEN_INPUTS).schedule;
    const second = scheduleFor(GOLDEN_INPUTS).schedule;
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});
