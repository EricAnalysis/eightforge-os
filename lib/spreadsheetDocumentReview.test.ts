import { describe, expect, it } from 'vitest';

import type { ValidationFinding } from '@/types/validator';
import { resolveTicketOverrideTargetId } from './spreadsheetDocumentReview';

function buildFinding(
  overrides: Partial<ValidationFinding> = {},
): ValidationFinding {
  return {
    id: 'finding-1',
    run_id: 'run-1',
    project_id: 'project-1',
    rule_id: 'ticket_integrity',
    check_key: 'ticket_integrity:missing_invoice',
    category: 'ticket_integrity',
    severity: 'warning',
    status: 'open',
    subject_type: 'transaction_row',
    subject_id: 'transaction:sheet-1:12',
    field: null,
    expected: null,
    actual: null,
    variance: null,
    variance_unit: null,
    blocked_reason: null,
    decision_eligible: false,
    action_eligible: false,
    linked_decision_id: null,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: '2026-04-13T00:00:00Z',
    updated_at: '2026-04-13T00:00:00Z',
    ...overrides,
  };
}

describe('spreadsheet document review ticket overrides', () => {
  it('uses the transaction row subject id when evidence rows are absent', () => {
    const finding = buildFinding();

    expect(resolveTicketOverrideTargetId(finding, [])).toBe('transaction:sheet-1:12');
  });

  it('suppresses ticket overrides when a finding spans multiple records', () => {
    const finding = buildFinding({
      subject_type: 'invoice_rate_group',
      subject_id: 'INV-001|RATE-A',
    });

    expect(resolveTicketOverrideTargetId(finding, [
      { record_id: 'transaction:sheet-1:12' },
      { record_id: 'transaction:sheet-1:13' },
    ])).toBeNull();
  });
});
