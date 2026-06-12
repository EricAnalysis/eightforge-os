import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  logActivityEventMock,
  logDecisionFeedbackMock,
  processWorkflowTriggersMock,
  requestDecisionStatusRevalidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
  logDecisionFeedbackMock: vi.fn().mockResolvedValue({ ok: true }),
  processWorkflowTriggersMock: vi.fn().mockResolvedValue(undefined),
  requestDecisionStatusRevalidationMock: vi.fn(),
}));

vi.mock('@/lib/server/getActorContext', () => ({
  getActorContext: getActorContextMock,
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

vi.mock('@/lib/server/activity/logActivityEvent', () => ({
  logActivityEvent: logActivityEventMock,
}));

vi.mock('@/lib/server/decisionFeedback', () => ({
  logDecisionFeedback: logDecisionFeedbackMock,
}));

vi.mock('@/lib/server/workflows/processWorkflowTriggers', () => ({
  processWorkflowTriggers: processWorkflowTriggersMock,
}));

vi.mock('@/lib/validator/revalidationRequests', () => ({
  requestDecisionStatusRevalidation: requestDecisionStatusRevalidationMock,
}));

import { PATCH } from '@/app/api/decisions/[id]/status/route';

afterEach(() => {
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  logActivityEventMock.mockClear();
  logDecisionFeedbackMock.mockClear();
  processWorkflowTriggersMock.mockClear();
  requestDecisionStatusRevalidationMock.mockClear();
});

describe('decision status route', () => {
  it('rejects approval-impacting finalization outside Execution', async () => {
    const updateMock = vi.fn();
    const admin = {
      from(table: string) {
        assert.equal(table, 'decisions');

        return {
          select() {
            return {
              eq(field: string, value: unknown) {
                assert.equal(field, 'id');
                assert.equal(value, 'decision-1');

                return {
                  single: async () => ({
                    data: {
                      id: 'decision-1',
                      organization_id: 'org-1',
                      project_id: 'project-1',
                      status: 'open',
                      severity: 'critical',
                    },
                    error: null,
                  }),
                };
              },
            };
          },
          update: updateMock,
        };
      },
    };

    getActorContextMock.mockResolvedValue({
      ok: true,
      actor: {
        actorId: 'user-1',
        organizationId: 'org-1',
        displayName: 'Operator',
        role: 'admin',
      },
    });
    getSupabaseAdminMock.mockReturnValue(admin);

    const response = await PATCH(
      new Request('http://localhost/api/decisions/decision-1/status', {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'resolved',
          operator_action: 'approve',
        }),
        headers: {
          'content-type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: 'decision-1' }) },
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: 'Approval-impacting outcomes must be finalized through Execution.',
    });
    expect(updateMock).not.toHaveBeenCalled();
    expect(logActivityEventMock).not.toHaveBeenCalled();
    expect(logDecisionFeedbackMock).not.toHaveBeenCalled();
    expect(processWorkflowTriggersMock).not.toHaveBeenCalled();
    expect(requestDecisionStatusRevalidationMock).not.toHaveBeenCalled();
  });
});
