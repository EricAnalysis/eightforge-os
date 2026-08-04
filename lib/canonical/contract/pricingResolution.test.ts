import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  classifyApprovalEligibility,
  classifyDisplayGroup,
  normalizeUnresolvedReasons,
} from '@/lib/canonical/contract/pricingResolution';
import type {
  CanonicalPricingEvidenceCompleteness,
  CanonicalPricingRowState,
  CanonicalPricingUnresolvedReason,
} from '@/lib/canonical/contract/pricing';

const ALL_ROW_STATES: readonly CanonicalPricingRowState[] = [
  'resolved',
  'derived',
  'unresolved_mapping',
  'extraction_conflict',
  'precedence_conflict',
  'not_applicable',
  'non_pricing',
  'requires_review',
];

const COMPLETE_EVIDENCE: CanonicalPricingEvidenceCompleteness = {
  hasLocatableEvidence: true,
  coreFieldsBacked: true,
  evidenceRefCount: 2,
  unbackedFieldKeys: [],
};

function approvalInput(overrides: Partial<Parameters<typeof classifyApprovalEligibility>[0]> = {}) {
  return {
    state: 'resolved' as CanonicalPricingRowState,
    hasGoverningDocument: true,
    evidenceCompleteness: COMPLETE_EVIDENCE,
    descriptionSettled: true,
    unitSettled: true,
    rateSettled: true,
    authoredCorrection: false,
    ...overrides,
  };
}

describe('classifyDisplayGroup', () => {
  it('is total over the row-state union', () => {
    for (const state of ALL_ROW_STATES) {
      const group = classifyDisplayGroup(state);
      assert.ok(
        group === 'resolved_pricing' || group === 'needs_review' || group === 'excluded',
        `state ${state} produced ${group}`,
      );
    }
  });

  it('routes only settled states into the authoritative pricing group', () => {
    const resolvedGroup = ALL_ROW_STATES.filter(
      (state) => classifyDisplayGroup(state) === 'resolved_pricing',
    );
    assert.deepEqual(resolvedGroup, ['resolved', 'derived']);
  });

  it('never routes an unresolved state into resolved_pricing', () => {
    for (const state of ['unresolved_mapping', 'extraction_conflict', 'precedence_conflict', 'requires_review'] as const) {
      assert.equal(classifyDisplayGroup(state), 'needs_review');
    }
  });

  it('routes non-pricing content to excluded, not needs_review', () => {
    assert.equal(classifyDisplayGroup('non_pricing'), 'excluded');
    assert.equal(classifyDisplayGroup('not_applicable'), 'excluded');
  });
});

describe('normalizeUnresolvedReasons', () => {
  it('dedupes and returns a deterministic severity order', () => {
    const input: CanonicalPricingUnresolvedReason[] = [
      'unit_unresolved',
      'extraction_conflict',
      'unit_unresolved',
      'governing_source_missing',
    ];
    const normalized = normalizeUnresolvedReasons(input);
    assert.deepEqual(normalized, [
      'extraction_conflict',
      'governing_source_missing',
      'unit_unresolved',
    ]);
  });

  it('is order-independent', () => {
    const a = normalizeUnresolvedReasons(['rate_unresolved', 'evidence_incomplete']);
    const b = normalizeUnresolvedReasons(['evidence_incomplete', 'rate_unresolved']);
    assert.deepEqual(a, b);
  });

  it('returns an empty list unchanged', () => {
    assert.deepEqual(normalizeUnresolvedReasons([]), []);
  });
});

describe('classifyApprovalEligibility', () => {
  it('grants eligibility only when every confirmation is present', () => {
    const result = classifyApprovalEligibility(approvalInput());
    assert.equal(result.eligible, true);
    assert.deepEqual(result.blockers, []);
  });

  it('blocks on a missing governing source', () => {
    const result = classifyApprovalEligibility(approvalInput({ hasGoverningDocument: false }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.blockers, ['governing_source_missing']);
  });

  it('blocks on incomplete evidence', () => {
    const result = classifyApprovalEligibility(approvalInput({
      evidenceCompleteness: {
        hasLocatableEvidence: false,
        coreFieldsBacked: false,
        evidenceRefCount: 0,
        unbackedFieldKeys: ['rate'],
      },
    }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.blockers, ['evidence_incomplete']);
  });

  it('blocks on unsettled description, unit, or rate independently', () => {
    assert.deepEqual(
      classifyApprovalEligibility(approvalInput({ descriptionSettled: false })).blockers,
      ['description_unresolved'],
    );
    assert.deepEqual(
      classifyApprovalEligibility(approvalInput({ unitSettled: false })).blockers,
      ['unit_unresolved'],
    );
    assert.deepEqual(
      classifyApprovalEligibility(approvalInput({ rateSettled: false })).blockers,
      ['rate_unresolved'],
    );
  });

  it('blocks on an authored value correction even when everything else is present', () => {
    const result = classifyApprovalEligibility(approvalInput({ authoredCorrection: true }));
    assert.equal(result.eligible, false);
    assert.deepEqual(result.blockers, ['authored_value_correction']);
  });

  it('blocks every non-settled state regardless of field completeness', () => {
    for (const state of ALL_ROW_STATES) {
      const result = classifyApprovalEligibility(approvalInput({ state }));
      if (state === 'resolved' || state === 'derived') {
        assert.equal(result.eligible, true, `${state} should be eligible`);
      } else {
        assert.equal(result.eligible, false, `${state} must not be eligible`);
        assert.ok(result.blockers.length > 0, `${state} must report a blocker`);
      }
    }
  });

  it('accumulates every applicable blocker rather than reporting only the first', () => {
    const result = classifyApprovalEligibility(approvalInput({
      state: 'extraction_conflict',
      hasGoverningDocument: false,
      rateSettled: false,
      authoredCorrection: true,
    }));
    assert.deepEqual(result.blockers, [
      'extraction_conflict',
      'governing_source_missing',
      'rate_unresolved',
      'authored_value_correction',
    ]);
  });
});
