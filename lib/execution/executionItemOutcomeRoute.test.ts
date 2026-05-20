import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectExecutionItemRow } from '@/lib/executionItems';

const {
  getActorContextMock,
  getSupabaseAdminMock,
  logActivityEventMock,
  triggerProjectValidationMock,
} = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  logActivityEventMock: vi.fn().mockResolvedValue({ ok: true }),
  triggerProjectValidationMock: vi.fn().mockResolvedValue({ status: 'triggered' }),
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

vi.mock('@/lib/validator/triggerProjectValidation', () => ({
  triggerProjectValidation: triggerProjectValidationMock,
}));

import { PATCH } from '@/app/api/execution-items/[id]/outcome/route';

const TS = '2026-05-06T00:00:00.000Z';

type MockFindingRow = {
  id: string;
  project_id: string;
  status: string;
  resolved_by_user_id: string | null;
  resolved_at: string | null;
  updated_at: string;
};

function createExecutionItem(): ProjectExecutionItemRow {
  return {
    id: 'execution-1',
    organization_id: 'org-1',
    project_id: 'project-1',
    source_type: 'validator_finding',
    source_id: 'finding-1',
    source_key: 'invoice:INV-001:contract-rate',
    severity: 'critical',
    title: 'Contract rate missing',
    problem: 'No governing contract rate found for the billed line.',
    expected_value: 'Contract rate row',
    actual_value: 'missing',
    impact: 'Approval is blocked until the contract rate is confirmed.',
    required_action: 'Locate the governing contract rate row.',
    status: 'open',
    outcome: null,
    evidence_refs: ['document:doc-1:page:3', 'record:invoice-line-1'],
    fact_refs: ['fact:contract_rate'],
    validator_rule_key: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
    override_reason: null,
    suppression_signature: null,
    created_at: TS,
    updated_at: TS,
    last_seen_at: TS,
    overridden_at: null,
    resolved_at: null,
  };
}

function createAdminMock(params: {
  executionItem: ProjectExecutionItemRow;
  finding: MockFindingRow;
}) {
  const state = {
    executionItem: { ...params.executionItem },
    finding: { ...params.finding },
  };

  return {
    state,
    admin: {
      from(table: string) {
        if (table === 'execution_items') {
          return {
            select() {
              return {
                eq(field: string, value: unknown) {
                  if (field === 'id' && value === state.executionItem.id) {
                    return {
                      maybeSingle: async () => ({
                        data: { ...state.executionItem },
                        error: null,
                      }),
                    };
                  }

                  return {
                    maybeSingle: async () => ({
                      data: null,
                      error: null,
                    }),
                  };
                },
              };
            },
            update(patch: Partial<ProjectExecutionItemRow>) {
              const filters: Array<{ field: string; value: unknown }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value });
                  return query;
                },
                select() {
                  return {
                    single: async () => {
                      const matchesId = filters.some((filter) => filter.field === 'id' && filter.value === state.executionItem.id);
                      const matchesOrg = filters.some((filter) => filter.field === 'organization_id' && filter.value === state.executionItem.organization_id);
                      if (!matchesId || !matchesOrg) {
                        return { data: null, error: { message: 'not found' } };
                      }

                      Object.assign(state.executionItem, patch);
                      return {
                        data: { ...state.executionItem },
                        error: null,
                      };
                    },
                  };
                },
              };
              return query;
            },
          };
        }

        if (table === 'project_validation_findings') {
          return {
            update(patch: Partial<MockFindingRow>) {
              const filters: Array<{ field: string; value: unknown }> = [];
              const query = {
                eq(field: string, value: unknown) {
                  filters.push({ field, value });
                  const matchesId = filters.some((filter) => filter.field === 'id' && filter.value === state.finding.id);
                  const matchesProject = filters.some((filter) => filter.field === 'project_id' && filter.value === state.finding.project_id);
                  if (matchesId && matchesProject) {
                    Object.assign(state.finding, patch);
                  }
                  return query;
                },
                then(resolve: (value: { error: null }) => unknown, reject?: (reason: unknown) => unknown) {
                  return Promise.resolve({ error: null }).then(resolve, reject);
                },
              };
              return query;
            },
          };
        }

        throw new Error(`Unexpected table: ${table}`);
      },
    },
  };
}

afterEach(() => {
  getActorContextMock.mockReset();
  getSupabaseAdminMock.mockReset();
  logActivityEventMock.mockClear();
  triggerProjectValidationMock.mockClear();
});

describe('execution item outcome route', () => {
  it('persists override reason, suppression signature, and override audit metadata', async () => {
    const executionItem = createExecutionItem();
    const adminMock = createAdminMock({
      executionItem,
      finding: {
        id: 'finding-1',
        project_id: 'project-1',
        status: 'open',
        resolved_by_user_id: null,
        resolved_at: null,
        updated_at: TS,
      },
    });

    getActorContextMock.mockResolvedValue({
      ok: true,
      actor: {
        actorId: 'user-1',
        organizationId: 'org-1',
        displayName: 'Operator',
        role: 'admin',
      },
    });
    getSupabaseAdminMock.mockReturnValue(adminMock.admin);

    const response = await PATCH(
      new Request('http://localhost/api/execution-items/execution-1/outcome', {
        method: 'PATCH',
        body: JSON.stringify({
          action: 'override',
          reason: 'Approved as an operator exception.',
        }),
        headers: {
          'content-type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: 'execution-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.outcome, 'overridden');
    assert.equal(body.status, 'resolved');
    assert.equal(body.override_reason, 'Approved as an operator exception.');
    assert.ok(typeof body.suppression_signature === 'string' && body.suppression_signature.length > 0);
    assert.ok(typeof body.overridden_at === 'string' && body.overridden_at.length > 0);
    assert.equal(adminMock.state.finding.status, 'dismissed');
    assert.equal(adminMock.state.finding.resolved_by_user_id, 'user-1');

    expect(logActivityEventMock).toHaveBeenCalledTimes(1);
    expect(logActivityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      event_type: 'execution_item_overridden',
      new_value: expect.objectContaining({
        override_reason: 'Approved as an operator exception.',
        suppression_signature: body.suppression_signature,
      }),
    }));
    expect(triggerProjectValidationMock).toHaveBeenCalledWith(
      'project-1',
      'override_applied',
      'user-1',
    );
  });
});
