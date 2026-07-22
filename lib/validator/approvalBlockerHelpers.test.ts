import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  blockerFindingCount,
  countApprovalBlockers,
  isApprovalBlocker,
  isBlockingFinding,
} from '@/lib/validator/findingSemantics';
import { makeFinding } from '@/lib/validator/shared';
import type { ValidationFinding } from '@/types/validator';

const PROJECT_ID = 'project-1';

/**
 * Phase B step 1 — capture the EXACT existing semantics of the sanctioned
 * approval-blocker helpers. These tests must pass with zero behavior change;
 * they pin what "approval blocker" means today so later retargeting steps
 * cannot silently move a surface's count.
 */

// A payment-risk exposure finding: the canonical blocker shape.
function blockingFinding(): ValidationFinding {
  return makeFinding({
    projectId: PROJECT_ID,
    ruleId: 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
    category: 'financial_integrity',
    severity: 'warning',
    subjectType: 'project',
    subjectId: PROJECT_ID,
    field: 'supported_amount',
    expected: '1000',
    actual: '750',
    variance: 250,
    varianceUnit: 'USD',
  });
}

// requires_operator_review, not a blocker.
function reviewFinding(): ValidationFinding {
  return makeFinding({
    projectId: PROJECT_ID,
    ruleId: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
    category: 'financial_integrity',
    severity: 'warning',
    subjectType: 'project',
    subjectId: PROJECT_ID,
  });
}

// informational, not a blocker.
function infoFinding(): ValidationFinding {
  return makeFinding({
    projectId: PROJECT_ID,
    ruleId: 'FINANCIAL_NTE_APPROACHING',
    category: 'financial_integrity',
    severity: 'warning',
    subjectType: 'project',
    subjectId: PROJECT_ID,
  });
}

// The axis-2 divergence case: a rule whose override pins business_severity to
// 'low' / approval_gate_effect to 'informational' while the RAW severity is
// 'critical'. Group A (approval_gate_effect) must NOT treat this as a blocker,
// even though the issue-board's current isBlocker() would (via raw severity).
function rawCriticalButDowngradedFinding(): ValidationFinding {
  return makeFinding({
    projectId: PROJECT_ID,
    ruleId: 'FINANCIAL_NTE_FACT_MISSING',
    category: 'financial_integrity',
    severity: 'critical',
    subjectType: 'project',
    subjectId: PROJECT_ID,
  });
}

describe('approval-blocker sanctioned helpers (Phase B step 1)', () => {
  it('isApprovalBlocker delegates verbatim to isBlockingFinding', () => {
    const cases = [
      blockingFinding(),
      reviewFinding(),
      infoFinding(),
      rawCriticalButDowngradedFinding(),
    ];

    for (const finding of cases) {
      assert.equal(
        isApprovalBlocker(finding),
        isBlockingFinding(finding),
        `divergence for rule ${finding.rule_id}`,
      );
    }
  });

  it('treats a payment-risk exposure finding as an approval blocker', () => {
    const finding = blockingFinding();
    assert.equal(finding.approval_gate_effect, 'blocks_approval');
    assert.equal(isApprovalBlocker(finding), true);
  });

  it('does not treat review or informational findings as approval blockers', () => {
    assert.equal(isApprovalBlocker(reviewFinding()), false);
    assert.equal(isApprovalBlocker(infoFinding()), false);
  });

  it('does not treat a raw-critical, override-downgraded finding as an approval blocker', () => {
    const finding = rawCriticalButDowngradedFinding();
    // The raw persisted severity is still 'critical' ...
    assert.equal(finding.severity, 'critical');
    // ... but the normalized approval semantics are informational, so Group A
    // does not count it. This is the exact axis-2 divergence from the current
    // issue-board isBlocker(), which the later B2 retarget will resolve by
    // adopting this (approval_gate_effect) basis.
    assert.equal(finding.approval_gate_effect, 'informational');
    assert.equal(isApprovalBlocker(finding), false);
  });

  it('countApprovalBlockers counts exactly the approval-blocking findings', () => {
    const findings = [
      blockingFinding(),
      blockingFinding(),
      reviewFinding(),
      infoFinding(),
      rawCriticalButDowngradedFinding(),
    ];

    assert.equal(countApprovalBlockers(findings), 2);
  });

  it('countApprovalBlockers equals blockerFindingCount for the current rule set', () => {
    // The Group A internal-agreement invariant: the disposition-based counter
    // (blockerFindingCount) and the gate-effect-based counter agree today.
    // Pinned so a future rule override that breaks the equivalence is caught.
    const battery = [
      blockingFinding(),
      reviewFinding(),
      infoFinding(),
      rawCriticalButDowngradedFinding(),
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'invoice',
        subjectId: '2026-002',
        field: 'at_risk_amount',
        expected: '0',
        actual: '500',
        variance: 500,
        varianceUnit: 'USD',
      }),
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'project',
        subjectId: PROJECT_ID,
      }),
    ];

    assert.equal(countApprovalBlockers(battery), blockerFindingCount(battery));
    // Concrete expected value so the equivalence is not vacuously satisfied.
    assert.equal(countApprovalBlockers(battery), 2);
  });

  it('is status-agnostic: resolved blockers are still counted (caller filters status)', () => {
    const resolvedBlocker = makeFinding({
      projectId: PROJECT_ID,
      ruleId: 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
      category: 'financial_integrity',
      severity: 'warning',
      subjectType: 'project',
      subjectId: PROJECT_ID,
      status: 'resolved',
      field: 'supported_amount',
      expected: '1000',
      actual: '750',
      variance: 250,
      varianceUnit: 'USD',
    });

    assert.equal(isApprovalBlocker(resolvedBlocker), true);
    assert.equal(countApprovalBlockers([resolvedBlocker]), 1);
    // Matches blockerFindingCount, which is also status-agnostic.
    assert.equal(blockerFindingCount([resolvedBlocker]), 1);
  });

  it('returns zero for an empty finding set', () => {
    assert.equal(countApprovalBlockers([]), 0);
  });
});
