import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  logActivityEventMock,
  closeDecisionLinkedWorkMock,
  processWorkflowTriggersMock,
  requestDecisionFeedbackRevalidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
  closeDecisionLinkedWorkMock: vi.fn().mockResolvedValue({
    closedFindingIds: ['finding-1'],
    closedWorkflowTaskIds: ['task-1'],
    closedExecutionItemIds: ['execution-1'],
    recomputedDocumentStatus: true,
    errors: [],
  }),
  processWorkflowTriggersMock: vi.fn().mockResolvedValue(undefined),
  requestDecisionFeedbackRevalidationMock: vi.fn(),
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

vi.mock('@/lib/server/decisionClosure', () => ({
  closeDecisionLinkedWork: closeDecisionLinkedWorkMock,
}));

vi.mock('@/lib/server/workflows/processWorkflowTriggers', () => ({
  processWorkflowTriggers: processWorkflowTriggersMock,
}));

vi.mock('@/lib/validator/revalidationRequests', () => ({
  requestDecisionFeedbackRevalidation: requestDecisionFeedbackRevalidationMock,
}));

import { POST } from '@/app/api/decisions/[id]/feedback/route';

afterEach(() => {
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  logActivityEventMock.mockClear();
  closeDecisionLinkedWorkMock.mockClear();
  processWorkflowTriggersMock.mockClear();
  requestDecisionFeedbackRevalidationMock.mockClear();
});

describe('decision feedback route', () => {
  it('suppresses decisions through shared linked-work closure', async () => {
    const state = {
      feedbackRows: [] as Array<Record<string, unknown>>,
      decisionPatch: null as Record<string, unknown> | null,
    };
    const admin = {
      from(table: string) {
        if (table === 'decision_feedback') {
          return {
            upsert: async (row: Record<string, unknown>) => {
              state.feedbackRows.push(row);
              return { error: null };
            },
          };
        }

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
                      status: 'open',
                      severity: 'critical',
                    },
                    error: null,
                  }),
                };
              },
            };
          },
          update(patch: Record<string, unknown>) {
            state.decisionPatch = patch;
            const query = {
              eq() {
                return query;
              },
              then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                return Promise.resolve({ error: null }).then(resolve, reject);
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

    const response = await POST(
      new Request('http://localhost/api/decisions/decision-1/feedback', {
        method: 'POST',
        body: JSON.stringify({
          is_correct: false,
          feedback_type: 'incorrect',
          disposition: 'suppress',
          review_error_type: 'edge_case',
          notes: 'Duplicate validator finding.',
        }),
        headers: {
          'content-type': 'application/json',
        },
      }) as never,
      { params: Promise.resolve({ id: 'decision-1' }) },
    );

    assert.equal(response.status, 200);
    assert.equal(state.decisionPatch?.status, 'suppressed');
    assert.equal(typeof state.decisionPatch?.resolved_at, 'string');
    assert.equal(state.feedbackRows[0]?.disposition, 'suppress');
    expect(closeDecisionLinkedWorkMock).toHaveBeenCalledWith(expect.objectContaining({
      admin,
      decisionId: 'decision-1',
      organizationId: 'org-1',
      projectId: 'project-1',
      documentId: 'doc-1',
      actorId: 'user-1',
      status: 'suppressed',
    }));
    expect(processWorkflowTriggersMock).toHaveBeenCalledWith({
      organizationId: 'org-1',
      eventType: 'status_changed',
      entityType: 'decision',
      entityId: 'decision-1',
      payload: {
        from: 'open',
        to: 'suppressed',
        severity: 'critical',
      },
    });
    expect(requestDecisionFeedbackRevalidationMock).toHaveBeenCalledWith({
      projectId: 'project-1',
      actorId: 'user-1',
      feedbackType: 'incorrect',
    });
  });
});
