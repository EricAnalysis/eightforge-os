import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { emitValidationFindingLifecycleActivity } from '@/lib/validator/validationFindingActivity';
import type { ValidationFinding } from '@/types/validator';

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: vi.fn(),
}));

function finding(overrides: Partial<ValidationFinding> = {}): ValidationFinding {
  return {
    id: 'finding-1',
    run_id: 'run-1',
    project_id: 'project-1',
    rule_id: 'RULE_1',
    check_key: 'RULE_1:subject-1',
    category: 'financial_integrity',
    severity: 'warning',
    status: 'open',
    subject_type: 'invoice',
    subject_id: 'subject-1',
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
    created_at: '2026-07-22T00:00:00.000Z',
    updated_at: '2026-07-22T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(logActivityEvent).mockResolvedValue({ ok: true, id: 'activity-1' });
});

describe('emitValidationFindingLifecycleActivity', () => {
  it('records trigger source on resolved events alongside the run id', async () => {
    await emitValidationFindingLifecycleActivity({
      organizationId: 'org-1',
      projectId: 'project-1',
      findingId: 'finding-1',
      previousFinding: finding(),
      currentFinding: finding({ status: 'resolved' }),
      runId: 'run-2',
      triggerSource: 'review_corrected',
    });

    const event = vi.mocked(logActivityEvent).mock.calls[0]?.[0];
    assert.equal(event?.event_type, 'validation_finding_resolved');
    assert.equal(event?.new_value?.run_id, 'run-2');
    assert.equal(event?.new_value?.trigger_source, 'review_corrected');
  });

  it('does not add trigger source to validation finding changed events', async () => {
    await emitValidationFindingLifecycleActivity({
      organizationId: 'org-1',
      projectId: 'project-1',
      findingId: 'finding-1',
      previousFinding: finding({ severity: 'warning' }),
      currentFinding: finding({ severity: 'critical' }),
      runId: 'run-2',
      triggerSource: 'manual',
    });

    const event = vi.mocked(logActivityEvent).mock.calls[0]?.[0];
    assert.equal(event?.event_type, 'validation_finding_changed');
    assert.equal(event?.new_value?.trigger_source, undefined);
  });
});
