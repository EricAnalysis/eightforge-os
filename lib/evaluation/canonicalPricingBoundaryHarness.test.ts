/**
 * Corpus-independent unit tests for the boundary harness.
 *
 * The real-fixture parity test skips when the external corpus is absent, so
 * these synthetic cases keep the harness itself covered on any machine.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import type { ContractRateScheduleRow } from '@/lib/contracts/types';
import {
  rateScheduleRowIdentity,
  runPricingBoundaries,
  tallyReasons,
} from '@/lib/evaluation/canonicalPricingBoundaryHarness';

function row(overrides: Partial<ContractRateScheduleRow> = {}): ContractRateScheduleRow {
  return {
    row_id: 'harness:row:1',
    description: 'Loading and hauling debris from collection point to disposal site',
    unit: 'Cubic Yard',
    rate: 12.5,
    category: 'Final Disposal',
    source_category: 'Final Disposal',
    canonical_category: 'final_disposal',
    category_confidence: 0.9,
    page: 4,
    source_anchor_ids: ['harness:anchor:p4:t1:r1'],
    rate_raw: 'Final Disposal | Loading and hauling debris | Cubic Yard | $12.50',
    material_type: 'Final Disposal',
    unit_type: 'Cubic Yard',
    rate_amount: 12.5,
    ...overrides,
  };
}

describe('boundary identity', () => {
  it('does not rely on a volatile canonical id alone', () => {
    const identity = rateScheduleRowIdentity(row(), 'doc-1');
    assert.equal(identity.documentId, 'doc-1');
    assert.equal(identity.page, 4);
    assert.equal(identity.sourceAnchor, 'harness:anchor:p4:t1:r1');
    assert.equal(identity.unit, 'Cubic Yard');
    assert.equal(identity.rate, 12.5);
    assert.ok(identity.key.includes('harness:anchor:p4:t1:r1'));
    // The upstream row id is retained but is not the whole key.
    assert.equal(identity.upstreamRowId, 'harness:row:1');
    assert.equal(identity.key.includes('harness:row:1'), false);
  });

  it('is stable across repeated derivation', () => {
    assert.equal(
      rateScheduleRowIdentity(row(), 'doc-1').key,
      rateScheduleRowIdentity(row(), 'doc-1').key,
    );
  });

  it('normalizes description casing and whitespace into the key', () => {
    const a = rateScheduleRowIdentity(row({ description: 'Hauling   Debris' }), 'doc-1');
    const b = rateScheduleRowIdentity(row({ description: 'hauling debris' }), 'doc-1');
    assert.equal(a.key, b.key);
  });
});

describe('runPricingBoundaries ledger', () => {
  it('accounts for every input row exactly once', () => {
    const report = runPricingBoundaries({
      fixtureId: 'harness',
      documentId: 'doc-1',
      rateScheduleRows: [
        row(),
        row({ row_id: 'harness:row:2', rate: 19.25, rate_amount: 19.25, description: 'Stump removal over 24 inch diameter', rate_raw: 'Final Disposal | Stump removal | Each | $19.25', unit: 'Each', unit_type: 'Each' }),
        row({ row_id: 'harness:row:nopage', page: null }),
      ],
    });

    assert.equal(
      report.counts.assemblerOutputs
      + report.counts.rowsMergedOrDeduped
      + report.counts.rowsSilentlyLost,
      report.counts.rateScheduleRows,
    );
    assert.equal(report.counts.canonicalCandidates, report.counts.assemblerOutputs);
  });

  it('attributes a page-less row to the documented selection predicate', () => {
    const report = runPricingBoundaries({
      fixtureId: 'harness',
      documentId: 'doc-1',
      rateScheduleRows: [row({ row_id: 'harness:row:nopage', page: null })],
    });
    const lost = report.rejections;
    assert.equal(lost.length, 1);
    assert.equal(lost[0]?.reason, 'missing_page');
    assert.equal(lost[0]?.boundary, 'assembler_selection_phase');
    assert.equal(lost[0]?.reasonBasis, 'derived_from_documented_predicate');
    assert.equal(lost[0]?.canonicalRecoveryPossible, false);
  });

  it('classifies a dedupe-suppressed row from the observed merge diagnostic', () => {
    const report = runPricingBoundaries({
      fixtureId: 'harness',
      documentId: 'doc-1',
      rateScheduleRows: [row(), row({ row_id: 'harness:row:dup' })],
    });
    assert.equal(report.counts.assemblerOutputs, 1);
    assert.equal(report.counts.rowsMergedOrDeduped, 1);
    assert.equal(report.mergeSuppressed[0]?.reasonBasis, 'observed_merge_diagnostic');
    assert.equal(report.mergeSuppressed[0]?.referencedBySurvivingMergeDiagnostic, true);
    assert.equal(report.mergeSuppressed[0]?.evidenceDiscoverableElsewhere, true);
  });

  it('tallies reasons deterministically', () => {
    const report = runPricingBoundaries({
      fixtureId: 'harness',
      documentId: 'doc-1',
      rateScheduleRows: [
        row({ row_id: 'a', page: null }),
        row({ row_id: 'b', page: null, description: 'Different row entirely', rate: 3, rate_amount: 3, rate_raw: 'x | $3.00' }),
      ],
    });
    assert.deepEqual(tallyReasons(report.rejections), { missing_page: 2 });
  });

  it('reconciles schedule coverage with candidate count', () => {
    const report = runPricingBoundaries({
      fixtureId: 'harness',
      documentId: 'doc-1',
      rateScheduleRows: [row(), row({ row_id: 'harness:row:2', description: 'Hauling C&D debris to final disposal', rate: 8, rate_amount: 8, rate_raw: 'C&D | Hauling | Cubic Yard | $8.00' })],
    });
    const { candidateCount, resolvedCount, needsReviewCount, excludedCount } =
      report.schedule.coverage;
    assert.equal(resolvedCount + needsReviewCount + excludedCount, candidateCount);
  });
});
