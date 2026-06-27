import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  logActivityEventMock,
  logDecisionFeedbackMock,
  closeDecisionLinkedWorkMock,
  processWorkflowTriggersMock,
  requestDecisionStatusRevalidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
  logDecisionFeedbackMock: vi.fn().mockResolvedValue({ ok: true }),
  closeDecisionLinkedWorkMock: vi.fn().mockResolvedValue({
    closedFindingIds: ['finding-1'],
    closedWorkflowTaskIds: ['task-1'],
    closedExecutionItemIds: ['execution-1'],
    recomputedDocumentStatus: true,
    errors: [],
  }),
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

vi.mock('@/lib/server/decisionClosure', () => ({
  closeDecisionLinkedWork: closeDecisionLinkedWorkMock,
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
  closeDecisionLinkedWorkMock.mockClear();
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
    expect(closeDecisionLinkedWorkMock).not.toHaveBeenCalled();
    expect(processWorkflowTriggersMock).not.toHaveBeenCalled();
    expect(requestDecisionStatusRevalidationMock).not.toHaveBeenCalled();
  });

  it('closes linked work and preserves route side effects for terminal status changes', async () => {
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
                      document_id: 'doc-1',
                      status: 'in_review',
                      severity: 'high',
                    },
                    error: null,
                  }),
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            assert.equal(patch.status, 'resolved');
            assert.equal(typeof patch.updated_at, 'string');
            assert.equal(typeof patch.resolved_at, 'string');

            const filters: Record<string, unknown> = {};
            const query = {
              eq(field: string, value: unknown) {
                filters[field] = value;
                return query;
              },
              select() {
                return {
                  single: async () => {
                    assert.equal(filters.id, 'decision-1');
                    assert.equal(filters.organization_id, 'org-1');
                    return {
                      data: {
                        id: 'decision-1',
                        organization_id: 'org-1',
                        project_id: 'project-1',
                        document_id: 'doc-1',
                        status: 'resolved',
                        severity: 'high',
                        ...patch,
                      },
                      error: null,
                    };
                  },
                };
              },
            };
            return query;
          },
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
        body: JSON.stringify({ status: 'resolved' }),
        headers: {
          'content-type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: 'decision-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'resolved');

    expect(closeDecisionLinkedWorkMock).toHaveBeenCalledWith(expect.objectContaining({
      admin,
      decisionId: 'decision-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      documentId: 'doc-1',
      actorId: 'user-1',
      status: 'resolved',
    }));
    expect(logActivityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      organization_id: 'org-1',
      project_id: 'project-1',
      entity_type: 'decision',
      entity_id: 'decision-1',
      event_type: 'status_changed',
      changed_by: 'user-1',
      old_value: { status: 'in_review' },
      new_value: expect.objectContaining({
        status: 'resolved',
        linked_closure: {
          findings: 1,
          workflow_tasks: 1,
          execution_items: 1,
          document_status_recomputed: true,
          errors: [],
        },
      }),
    }));
    expect(logDecisionFeedbackMock).toHaveBeenCalledWith(admin, expect.objectContaining({
      organization_id: 'org-1',
      decision_id: 'decision-1',
      new_status: 'resolved',
      previous_status: 'in_review',
      created_by: 'user-1',
    }));
    expect(processWorkflowTriggersMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      eventType: 'status_changed',
      entityType: 'decision',
      entityId: 'decision-1',
      payload: {
        from: 'in_review',
        to: 'resolved',
        severity: 'high',
      },
    });
    expect(requestDecisionStatusRevalidationMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      actorId: 'user-1',
      newStatus: 'resolved',
    });
  });
});
