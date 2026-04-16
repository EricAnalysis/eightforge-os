import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  groupIntoBatches,
  getApprovalActionHistory,
} from '../approvalActionHistory';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../supabaseAdmin', () => {
  const makeChain = (resolution: { data: unknown; error: unknown }) => {
    const chain: Record<string, unknown> = {};
    const self = () => chain;
    chain.from = self;
    chain.select = self;
    chain.eq = self;
    chain.order = self;
    chain.limit = () => Promise.resolve(resolution);
    return chain;
  };

  return { getSupabaseAdmin: vi.fn(() => makeChain({ data: [], error: null })) };
});

import * as supabaseAdmin from '../supabaseAdmin';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

type PartialRow = {
  id?: string;
  approval_status?: string;
  action_type?: string;
  invoice_number?: string | null;
  amount?: number | null;
  reason?: string | null;
  priority?: string;
  task_id?: string | null;
  task_outcome?: string;
  error?: string | null;
  executed_at?: string;
};

let rowSeq = 0;

function makeRow(overrides: PartialRow = {}) {
  rowSeq += 1;
  return {
    id: `row-${rowSeq}`,
    approval_status: 'blocked',
    action_type: 'requires_verification_review',
    invoice_number: null,
    amount: 3187500,
    reason: 'Test reason',
    priority: 'critical',
    task_id: `task-${rowSeq}`,
    task_outcome: 'created',
    error: null,
    executed_at: new Date().toISOString(),
    ...overrides,
  };
}

function tsOffset(baseIso: string, offsetSeconds: number): string {
  const ms = new Date(baseIso).getTime() + offsetSeconds * 1000;
  return new Date(ms).toISOString();
}

// ---------------------------------------------------------------------------
// groupIntoBatches — pure function tests
// ---------------------------------------------------------------------------

describe('groupIntoBatches', () => {
  beforeEach(() => { rowSeq = 0; });

  it('returns empty array for empty input', () => {
    expect(groupIntoBatches([])).toEqual([]);
  });

  it('groups a single row into one batch', () => {
    const row = makeRow();
    const batches = groupIntoBatches([row]);
    expect(batches).toHaveLength(1);
    expect(batches[0].actions).toHaveLength(1);
    expect(batches[0].approval_status).toBe('blocked');
  });

  it('groups rows within 30 seconds into one batch', () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({ executed_at: base }),
      makeRow({ executed_at: tsOffset(base, -5) }),   // 5s later (rows are newest-first)
      makeRow({ executed_at: tsOffset(base, -10) }),  // 10s later
    ];
    const batches = groupIntoBatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].actions).toHaveLength(3);
  });

  it('splits rows more than 30 seconds apart into separate batches', () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({ executed_at: base }),
      makeRow({ executed_at: tsOffset(base, -60) }), // 60s gap → new batch
    ];
    const batches = groupIntoBatches(rows);
    expect(batches).toHaveLength(2);
  });

  it('splits rows with different approval_status into separate batches even within window', () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({ approval_status: 'blocked',      executed_at: base }),
      makeRow({ approval_status: 'needs_review', executed_at: tsOffset(base, -2) }),
    ];
    const batches = groupIntoBatches(rows);
    expect(batches).toHaveLength(2);
    expect(batches[0].approval_status).toBe('blocked');
    expect(batches[1].approval_status).toBe('needs_review');
  });

  it('uses the first (newest) row timestamp as batch_timestamp', () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({ executed_at: base }),
      makeRow({ executed_at: tsOffset(base, -3) }),
    ];
    const batches = groupIntoBatches(rows);
    expect(batches[0].batch_timestamp).toBe(base);
  });

  it('counts tasks_created, tasks_updated, and failures correctly', () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({ task_outcome: 'created',  executed_at: base }),
      makeRow({ task_outcome: 'created',  executed_at: tsOffset(base, -1) }),
      makeRow({ task_outcome: 'updated',  executed_at: tsOffset(base, -2) }),
      makeRow({ task_outcome: 'failed',   executed_at: tsOffset(base, -3) }),
    ];
    const batches = groupIntoBatches(rows);
    expect(batches).toHaveLength(1);
    expect(batches[0].tasks_created).toBe(2);
    expect(batches[0].tasks_updated).toBe(1);
    expect(batches[0].failures).toBe(1);
  });

  it('produces multiple batches when three distinct runs exist', () => {
    const t0 = new Date('2026-04-07T10:00:00Z').toISOString();
    const t1 = new Date('2026-04-07T10:05:00Z').toISOString(); // 5 min gap
    const t2 = new Date('2026-04-07T10:10:00Z').toISOString(); // 5 min gap

    // Rows are newest-first: t2 > t1 > t0
    const rows = [
      makeRow({ executed_at: t2, approval_status: 'approved' }),
      makeRow({ executed_at: tsOffset(t2, -2), approval_status: 'approved' }),
      makeRow({ executed_at: t1, approval_status: 'needs_review' }),
      makeRow({ executed_at: tsOffset(t1, -1), approval_status: 'needs_review' }),
      makeRow({ executed_at: t0, approval_status: 'blocked' }),
    ];

    const batches = groupIntoBatches(rows);
    expect(batches).toHaveLength(3);
    expect(batches[0].approval_status).toBe('approved');
    expect(batches[0].actions).toHaveLength(2);
    expect(batches[1].approval_status).toBe('needs_review');
    expect(batches[1].actions).toHaveLength(2);
    expect(batches[2].approval_status).toBe('blocked');
    expect(batches[2].actions).toHaveLength(1);
  });

  it('preserves all fields on each action entry', () => {
    const row = makeRow({
      action_type: 'flag_project',
      invoice_number: 'INV-003',
      amount: 3187500,
      reason: 'Project flagged',
      priority: 'high',
      task_id: 'task-abc',
      task_outcome: 'created',
    });
    const batches = groupIntoBatches([row]);
    const action = batches[0].actions[0];
    expect(action.action_type).toBe('flag_project');
    expect(action.invoice_number).toBe('INV-003');
    expect(action.amount).toBe(3187500);
    expect(action.reason).toBe('Project flagged');
    expect(action.priority).toBe('high');
    expect(action.task_id).toBe('task-abc');
    expect(action.task_outcome).toBe('created');
  });
});

// ---------------------------------------------------------------------------
// getApprovalActionHistory — integration tests with mocked Supabase
// ---------------------------------------------------------------------------

describe('getApprovalActionHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rowSeq = 0;
  });

  it('returns empty executions when no log entries exist', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(buildMockAdmin([]));

    const result = await getApprovalActionHistory('project-123');
    expect(result.project_id).toBe('project-123');
    expect(result.executions).toHaveLength(0);
    expect(result.total_actions).toBe(0);
  });

  it('returns empty result when admin client is unavailable', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null as any);

    const result = await getApprovalActionHistory('project-123');
    expect(result.executions).toHaveLength(0);
    expect(result.total_actions).toBe(0);
  });

  it('returns empty result when Supabase returns an error', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(
      buildMockAdmin(null, { message: 'connection refused' }),
    );

    const result = await getApprovalActionHistory('project-123');
    expect(result.executions).toHaveLength(0);
    expect(result.total_actions).toBe(0);
  });

  it('groups returned rows and returns executions', async () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({ executed_at: base, approval_status: 'blocked' }),
      makeRow({ executed_at: tsOffset(base, -2), approval_status: 'blocked' }),
      makeRow({ executed_at: tsOffset(base, -3), approval_status: 'blocked' }),
    ];

    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(buildMockAdmin(rows));

    const result = await getApprovalActionHistory('project-123');
    expect(result.executions).toHaveLength(1);
    expect(result.executions[0].actions).toHaveLength(3);
    expect(result.total_actions).toBe(3);
  });

  it('respects maxExecutions limit on returned groups', async () => {
    const rows: ReturnType<typeof makeRow>[] = [];
    // Build 5 distinct execution runs (60s apart each)
    for (let i = 0; i < 5; i++) {
      const base = new Date(Date.now() - i * 120_000).toISOString();
      rows.push(makeRow({ executed_at: base }));
      rows.push(makeRow({ executed_at: tsOffset(base, -2) }));
    }

    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(buildMockAdmin(rows));

    const result = await getApprovalActionHistory('project-123', 3);
    expect(result.executions.length).toBeLessThanOrEqual(3);
  });

  it('sets project_id correctly on result', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(buildMockAdmin([]));

    const result = await getApprovalActionHistory('project-xyz');
    expect(result.project_id).toBe('project-xyz');
  });

  it('example flow: blocked run with 3 tasks maps to one execution group', async () => {
    const base = new Date().toISOString();
    const rows = [
      makeRow({
        action_type: 'requires_verification_review',
        invoice_number: 'INV-003',
        amount: 3187500,
        task_outcome: 'created',
        executed_at: base,
      }),
      makeRow({
        action_type: 'flag_project',
        invoice_number: null,
        amount: 3187500,
        task_outcome: 'created',
        executed_at: tsOffset(base, -1),
      }),
      makeRow({
        action_type: 'notify_operator',
        invoice_number: null,
        amount: 3187500,
        task_outcome: 'created',
        executed_at: tsOffset(base, -2),
      }),
    ];

    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(buildMockAdmin(rows));

    const result = await getApprovalActionHistory('project-123');
    expect(result.executions).toHaveLength(1);

    const group = result.executions[0];
    expect(group.approval_status).toBe('blocked');
    expect(group.tasks_created).toBe(3);
    expect(group.failures).toBe(0);

    const reviewAction = group.actions.find(
      (a) => a.action_type === 'requires_verification_review',
    );
    expect(reviewAction?.invoice_number).toBe('INV-003');
    expect(reviewAction?.amount).toBe(3187500);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockAdmin(data: unknown, error: unknown = null) {
  const resolution = { data, error };
  const chain: Record<string, unknown> = {};
  const self = () => chain;
  chain.from = self;
  chain.select = self;
  chain.eq = self;
  chain.order = self;
  chain.limit = () => Promise.resolve(resolution);
  return chain as any;
}
