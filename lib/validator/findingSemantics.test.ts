import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import { buildValidationSummary, makeFinding } from '@/lib/validator/shared';

const PROJECT_ID = 'project-1';

describe('validator finding semantics', () => {
  it('does not treat activation trigger findings as blockers by default', () => {
    const finding = makeFinding({
      projectId: PROJECT_ID,
      ruleId: 'FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED',
      category: 'financial_integrity',
      severity: 'warning',
      subjectType: 'project',
      subjectId: PROJECT_ID,
    });

    assert.equal(finding.finding_disposition, 'warning');
    assert.equal(finding.business_severity, 'medium');
    assert.equal(finding.approval_gate_effect, 'requires_operator_review');
  });

  it('reserves critical approval semantics for payment-risk findings and fills operator fields', () => {
    const finding = makeFinding({
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
      evidence: [{
        evidence_type: 'summary',
        source_document_id: 'invoice-doc-1',
        record_id: 'invoice-summary-1',
        field_name: 'supported_amount',
        field_value: '750',
      }],
    });
    const normalized = normalizeValidationFinding(finding);

    assert.equal(normalized.finding_disposition, 'blocker');
    assert.equal(normalized.business_severity, 'critical');
    assert.equal(normalized.approval_gate_effect, 'blocks_approval');
    assert.equal(normalized.source_family, 'support');
    assert.equal(normalized.affected_amount, 250);
    assert.ok(normalized.problem && normalized.problem.length > 0);
    assert.ok(normalized.impact && normalized.impact.length > 0);
    assert.ok(normalized.required_action && normalized.required_action.length > 0);
    assert.deepEqual(normalized.evidence_refs, [
      'summary:invoice-doc-1:invoice-summary-1',
    ]);
  });

  it('builds summary counts from blocker, warning, review, and info findings', () => {
    const findings = [
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'project',
        subjectId: PROJECT_ID,
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
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'project',
        subjectId: PROJECT_ID,
      }),
      makeFinding({
        projectId: PROJECT_ID,
        ruleId: 'FINANCIAL_NTE_APPROACHING',
        category: 'financial_integrity',
        severity: 'warning',
        subjectType: 'project',
        subjectId: PROJECT_ID,
      }),
    ];

    const summary = buildValidationSummary(findings, 'FINDINGS_OPEN');

    assert.equal(summary.critical_count, 1);
    assert.equal(summary.blocker_count, 1);
    assert.equal(summary.warning_count, 1);
    assert.equal(summary.requires_review_count, 1);
    assert.equal(summary.info_count, 1);
    assert.equal(summary.validator_status, 'BLOCKED');
    assert.equal(summary.readiness, 'BLOCKED');
    assert.equal(summary.validator_blockers.length, 1);
    assert.ok(summary.validator_open_items.every((item) => item.problem && item.impact && item.required_action));
  });
});
