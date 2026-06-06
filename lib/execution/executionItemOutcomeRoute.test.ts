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
  overrides?: Array<Record<string, unknown>>;
  reviews?: Array<Record<string, unknown>>;
}) {
  const state = {
    executionItem: { ...params.executionItem },
    finding: { ...params.finding },
    overrides: params.overrides ?? [],
    reviews: params.reviews ?? [],
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

        if (table === 'document_fact_overrides' || table === 'document_fact_reviews') {
          const rows = table === 'document_fact_overrides' ? state.overrides : state.reviews;
          const filters: Array<{ type: 'eq' | 'in' | 'gte'; field: string; value: unknown }> = [];
          const query = {
            select() {
              return query;
            },
            eq(field: string, value: unknown) {
              filters.push({ type: 'eq', field, value });
              return query;
            },
            in(field: string, value: unknown) {
              filters.push({ type: 'in', field, value });
              return query;
            },
            gte(field: string, value: unknown) {
              filters.push({ type: 'gte', field, value });
              return query;
            },
            limit: async () => {
              const data = rows.filter((row) =>
                filters.every((filter) => {
                  const rowValue = row[filter.field];
                  if (filter.type === 'eq') return rowValue === filter.value;
                  if (filter.type === 'in') return Array.isArray(filter.value) && filter.value.includes(rowValue);
                  if (filter.type === 'gte') return typeof rowValue === 'string' && typeof filter.value === 'string' && rowValue >= filter.value;
                  return true;
                }),
              );
              return { data, error: null };
            },
          };
          return query;
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
  it('keeps correct non-final when no canonical truth mutation was written', async () => {
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
        body: JSON.stringify({ action: 'correct' }),
        headers: {
          'content-type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: 'execution-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.status, 'resolvable');
    assert.equal(body.outcome, null);
    assert.equal(body.resolved_at, null);
    assert.equal(adminMock.state.finding.status, 'open');
    assert.equal(adminMock.state.finding.resolved_by_user_id, null);

    expect(logActivityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      event_type: 'execution_item_corrected',
      new_value: expect.objectContaining({
        execution_item_id: 'execution-1',
        finding_id: 'finding-1',
        new_status: 'resolvable',
        evidence_refs: ['document:doc-1:page:3', 'record:invoice-line-1'],
        status: 'resolvable',
        outcome: null,
        canonical_truth_mutation_recorded: false,
      }),
    }));
    expect(triggerProjectValidationMock).toHaveBeenCalledWith(
      'project-1',
      'review_corrected',
      'user-1',
    );
  });

  it('finalizes correct when linked canonical override evidence exists', async () => {
    const executionItem = {
      ...createExecutionItem(),
      evidence_refs: ['document:doc-1:field:contract_rate'],
      fact_refs: ['fact:doc-1:contract_rate'],
    };
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
      overrides: [{
        id: 'override-1',
        organization_id: 'org-1',
        document_id: 'doc-1',
        field_key: 'contract_rate',
        is_active: true,
        created_at: '2026-05-06T01:00:00.000Z',
      }],
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
          action: 'correct',
          canonicalMutation: {
            documentId: 'doc-1',
            fieldKey: 'contract_rate',
          },
        }),
        headers: {
          'content-type': 'application/json',
        },
      }),
      { params: Promise.resolve({ id: 'execution-1' }) },
    );

    assert.equal(response.status, 200);
    const body = await response.json();

    assert.equal(body.status, 'resolved');
    assert.equal(body.outcome, 'resolved');
    assert.equal(adminMock.state.finding.status, 'resolved');
    expect(logActivityEventMock).toHaveBeenCalledWith(expect.objectContaining({
      project_id: 'project-1',
      event_type: 'execution_item_corrected',
      new_value: expect.objectContaining({
        execution_item_id: 'execution-1',
        finding_id: 'finding-1',
        canonical_truth_mutation_recorded: true,
        canonical_truth_mutation_verified: true,
      }),
    }));
  });

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
      project_id: 'project-1',
      event_type: 'execution_item_overridden',
      old_value: expect.objectContaining({
        execution_item_id: 'execution-1',
        finding_id: 'finding-1',
        previous_status: 'open',
      }),
      new_value: expect.objectContaining({
        execution_item_id: 'execution-1',
        finding_id: 'finding-1',
        new_status: 'resolved',
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
