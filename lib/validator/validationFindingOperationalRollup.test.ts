import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { makeFinding } from '@/lib/validator/shared';
import { buildValidationFindingOperationalRollup } from '@/lib/validator/validationFindingOperationalRollup';
import type { ValidationFinding, ValidationStatus } from '@/types/validator';

const PROJECT_ID = 'project-1';

function finding(params: {
  ruleId: string;
  subjectId: string;
  severity?: ValidationFinding['severity'];
  status?: ValidationFinding['status'];
  decisionEligible?: boolean;
}): ValidationFinding {
  return makeFinding({
    projectId: PROJECT_ID,
    ruleId: params.ruleId,
    category: 'financial_integrity',
    severity: params.severity ?? 'warning',
    subjectType: 'project',
    subjectId: params.subjectId,
    status: params.status,
    decisionEligible: params.decisionEligible,
    field: 'supported_amount',
    expected: '1000',
    actual: '750',
    variance: 250,
    varianceUnit: 'USD',
  });
}

describe('buildValidationFindingOperationalRollup', () => {
  it('counts only open canonical approval blockers', () => {
    const openBlockerOne = finding({
      ruleId: 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
      subjectId: 'blocker-1',
      decisionEligible: true,
    });
    const openBlockerTwo = finding({
      ruleId: 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
      subjectId: 'blocker-2',
      decisionEligible: true,
    });
    const resolvedBlocker = finding({
      ruleId: 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
      subjectId: 'resolved-blocker',
      status: 'resolved',
      decisionEligible: true,
    });
    const openReview = finding({
      ruleId: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
      subjectId: 'review',
      decisionEligible: true,
    });
    const rawCriticalButInformational = finding({
      ruleId: 'FINANCIAL_NTE_FACT_MISSING',
      subjectId: 'informational',
      severity: 'critical',
    });

    const rollup = buildValidationFindingOperationalRollup({
      projectId: PROJECT_ID,
      validationStatus: 'BLOCKED',
      findings: [
        openBlockerOne,
        openBlockerTwo,
        resolvedBlocker,
        openReview,
        rawCriticalButInformational,
      ],
    });

    assert.equal(rollup.blocked_count, 2);
    assert.equal(rollup.unresolved_finding_count, 4);
    assert.equal(rollup.pending_actions.length, 3);
    assert.deepEqual(
      rollup.pending_actions.map((action) => ({
        id: action.id,
        status_label: action.status_label,
        due_tone: action.due_tone,
        href: action.href,
      })),
      [
        {
          id: `finding-${openBlockerOne.check_key}`,
          status_label: 'Blocked',
          due_tone: 'danger',
          href: `/platform/projects/${PROJECT_ID}#validator`,
        },
        {
          id: `finding-${openBlockerTwo.check_key}`,
          status_label: 'Blocked',
          due_tone: 'danger',
          href: `/platform/projects/${PROJECT_ID}#validator`,
        },
        {
          id: `finding-${openReview.check_key}`,
          status_label: 'Needs Review',
          due_tone: 'warning',
          href: `/platform/projects/${PROJECT_ID}#validator`,
        },
      ],
    );
  });

  it('preserves validation status labels and fully typed status state', () => {
    const expectedByStatus: Record<
      ValidationStatus,
      { key: string; label: string; tone: string; isClear: boolean }
    > = {
      VALIDATED: { key: 'operationally_clear', label: 'Approved', tone: 'success', isClear: true },
      BLOCKED: { key: 'blocked', label: 'Blocked', tone: 'danger', isClear: false },
      FINDINGS_OPEN: { key: 'needs_review', label: 'Needs Review', tone: 'warning', isClear: false },
      NOT_READY: { key: 'attention_required', label: 'Not Evaluated', tone: 'muted', isClear: false },
    };

    for (const [validationStatus, expected] of Object.entries(expectedByStatus)) {
      const rollup = buildValidationFindingOperationalRollup({
        projectId: PROJECT_ID,
        validationStatus: validationStatus as ValidationStatus,
        findings: [],
      });

      assert.equal(rollup.status.key, expected.key);
      assert.equal(rollup.status.label, expected.label);
      assert.equal(rollup.status.tone, expected.tone);
      assert.equal(rollup.status.is_clear, expected.isClear);
      assert.equal(rollup.project_clear, expected.isClear);
    }
  });
});
