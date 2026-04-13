import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import { buildValidatorFindingActionsByProjectId } from '@/lib/validator/queueFindingActions';
import type { ValidationEvidence, ValidationFinding } from '@/types/validator';

const FINDING_BASE: ValidationFinding = {
  id: 'finding-1',
  run_id: 'run-1',
  project_id: 'project-1',
  rule_id: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE',
  check_key: 'FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE:line-6A',
  category: 'financial_integrity',
  severity: 'critical',
  status: 'open',
  subject_type: 'invoice_line',
  subject_id: 'line-6A',
  field: 'unit_price',
  expected: '75',
  actual: '80',
  variance: 5,
  variance_unit: 'USD',
  blocked_reason: null,
  decision_eligible: true,
  action_eligible: true,
  linked_decision_id: null,
  linked_action_id: null,
  resolved_by_user_id: null,
  resolved_at: null,
  created_at: '2026-04-08T00:00:00.000Z',
  updated_at: '2026-04-08T00:00:00.000Z',
};

function makeEvidence(
  overrides: Partial<ValidationEvidence>,
): ValidationEvidence {
  return {
    id: `evidence-${Math.random()}`,
    finding_id: 'finding-1',
    evidence_type: 'invoice_line',
    source_document_id: 'invoice-doc-1',
    source_page: 3,
    fact_id: null,
    record_id: 'line-6A',
    field_name: 'rate_code',
    field_value: '6A',
    note: 'Test evidence.',
    created_at: '2026-04-08T00:00:00.000Z',
    ...overrides,
  };
}

describe('validator finding queue actions', () => {
  it('builds a Williamson-style queue action for a rate mismatch finding', () => {
    const actionsByProjectId = buildValidatorFindingActionsByProjectId({
      findings: [FINDING_BASE],
      evidence: [
        makeEvidence({
          field_name: 'invoice_number',
          field_value: 'WILLIAMSON-2026-003',
        }),
        makeEvidence({
          evidence_type: 'invoice_line',
          field_name: 'rate_code',
          field_value: '6A',
        }),
        makeEvidence({
          evidence_type: 'rate_schedule',
          source_document_id: 'contract-doc-1',
          source_page: 8,
          record_id: 'schedule:6A',
          field_name: 'rate_amount',
          field_value: '75',
        }),
      ],
    });

    const actions = actionsByProjectId.get('project-1') ?? [];
    assert.equal(actions.length, 1);

    const action = actions[0]!;
    assert.equal(action.title, 'Rate 6A exceeds contract rate');
    assert.equal(action.invoice_number, 'WILLIAMSON-2026-003');
    assert.equal(action.approval_status, 'blocked');
    assert.equal(action.expected_value, '$75.00');
    assert.equal(action.actual_value, '$80.00');
    assert.equal(action.variance_label, '+$5.00');
    assert.equal(action.requires_verification_amount, 5);
    assert.equal(action.at_risk_amount, null);
    assert.equal(action.next_step, 'Review contract rate schedule');
    assert.equal(
      action.source_document_title,
      'Contract document + Invoice extraction',
    );
    assert.equal(
      action.href,
      '/platform/documents/invoice-doc-1?source=project&projectId=project-1&page=3&fieldKey=rate_code',
    );
  });
});
