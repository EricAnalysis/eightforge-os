import assert from 'node:assert/strict';
import { beforeEach, describe, it, vi } from 'vitest';

import { persistApprovalSnapshot } from '@/lib/server/approvalSnapshots';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

function createAdminMock(inserts: Array<{ table: string; payload: unknown }>) {
  return {
    from(table: string) {
      let payload: unknown;
      const query = {
        insert(value: unknown) {
          payload = value;
          inserts.push({ table, payload: value });
          return query;
        },
        select() {
          return query;
        },
        single() {
          return Promise.resolve({ data: payload, error: null });
        },
        then(resolve: (value: { data: null; error: null }) => unknown) {
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
}

const rollup = {
  status: { label: 'Blocked' },
  pending_actions: [{ id: 'finding-pseudo-id' }],
} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('persistApprovalSnapshot attribution', () => {
  it('persists run, decision, actor, and canonical finding UUIDs when provided', async () => {
    const inserts: Array<{ table: string; payload: unknown }> = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(createAdminMock(inserts) as never);

    const snapshot = await persistApprovalSnapshot('project-1', null, rollup, {
      runId: 'run-1',
      triggerEntity: { trigger_entity_type: 'decision', trigger_entity_id: 'decision-1' },
      createdBy: 'user-1',
      findingIds: ['finding-uuid-2', 'finding-uuid-1', 'finding-uuid-2'],
    });

    assert.equal(snapshot?.run_id, 'run-1');
    assert.equal(snapshot?.triggering_decision_id, 'decision-1');
    assert.equal(snapshot?.created_by, 'user-1');
    assert.deepEqual(snapshot?.finding_ids, ['finding-uuid-1', 'finding-uuid-2']);
    assert.equal(snapshot?.finding_ids.includes('finding-pseudo-id'), false);
  });

  it('persists nullable attribution and an empty canonical set when omitted', async () => {
    const inserts: Array<{ table: string; payload: unknown }> = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(createAdminMock(inserts) as never);

    const snapshot = await persistApprovalSnapshot('project-1', null, rollup);

    assert.equal(snapshot?.run_id, null);
    assert.equal(snapshot?.triggering_decision_id, null);
    assert.equal(snapshot?.created_by, null);
    assert.deepEqual(snapshot?.finding_ids, []);
  });

  it('does not treat non-decision trigger ids as decision attribution', async () => {
    const inserts: Array<{ table: string; payload: unknown }> = [];
    vi.mocked(getSupabaseAdmin).mockReturnValue(createAdminMock(inserts) as never);

    const snapshot = await persistApprovalSnapshot('project-1', null, rollup, {
      runId: 'run-2',
      triggerEntity: { trigger_entity_type: 'fact', trigger_entity_id: 'fact-1' },
      createdBy: 'user-2',
      findingIds: ['finding-uuid-1'],
    });

    assert.equal(snapshot?.run_id, 'run-2');
    assert.equal(snapshot?.triggering_decision_id, null);
    assert.equal(snapshot?.created_by, 'user-2');
  });
});
