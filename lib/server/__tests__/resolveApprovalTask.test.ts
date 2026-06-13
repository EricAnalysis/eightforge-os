import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveApprovalTask,
  markApprovalTaskInReview,
} from '../resolveApprovalTask';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../approvalActionEngine', () => ({
  executeApprovalActions: vi.fn(async () => ({
    project_id: 'project-123',
    approval_status: 'approved',
    actions_planned: [],
    tasks_created: 0,
    tasks_updated: 2,
    errors: [],
    executed_at: new Date().toISOString(),
  })),
}));

vi.mock('../activity/logActivityEvent', () => ({
  logActivityEvent: vi.fn(async () => ({ ok: true, id: 'event-001' })),
}));

// Supabase admin mock — builder pattern with configurable resolutions
const mockAdminState = {
  selectResult: null as unknown,
  updateResult: null as unknown,
};

vi.mock('../supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(() => buildMockAdmin()),
}));

function buildMockAdmin() {
  // The select chain resolves with mockAdminState.selectResult
  // The update chain resolves with mockAdminState.updateResult
  let isUpdate = false;

  const chain: Record<string, unknown> = {};
  const self = () => chain;

  chain.from = () => {
    isUpdate = false;
    return chain;
  };
  chain.select = self;
  chain.update = () => { isUpdate = true; return chain; };
  chain.eq = self;
  chain.single = () => {
    if (isUpdate) return Promise.resolve(mockAdminState.updateResult);
    return Promise.resolve(mockAdminState.selectResult);
  };

  return chain as any;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeSelectResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'task-001',
      organization_id: 'org-abc',
      project_id: 'project-123',
      status: 'open',
      task_type: 'approval_requires_verification',
      title: 'Review invoice INV-003',
      resolution_state: null,
      ...overrides,
    },
    error: null,
  };
}

function makeUpdateResult(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      id: 'task-001',
      status: 'resolved',
      resolution_state: 'resolved',
      resolved_by: 'user-xyz',
      resolved_at: new Date().toISOString(),
      resolution_note: null,
      project_id: 'project-123',
      task_type: 'approval_requires_verification',
      title: 'Review invoice INV-003',
      ...overrides,
    },
    error: null,
  };
}

// ---------------------------------------------------------------------------
// resolveApprovalTask tests
// ---------------------------------------------------------------------------

describe('resolveApprovalTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminState.selectResult = makeSelectResult();
    mockAdminState.updateResult = makeUpdateResult();
  });

  it('returns ok:false with 503 when admin client is unavailable', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null as any);

    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('returns ok:false with 404 when task is not found', async () => {
    mockAdminState.selectResult = { data: null, error: { message: 'not found' } };

    const result = await resolveApprovalTask({
      taskId: 'task-999',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('returns ok:false with 404 when task belongs to different org', async () => {
    mockAdminState.selectResult = makeSelectResult({ organization_id: 'org-other' });

    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('returns ok:false with 409 when task is already resolved in a different state', async () => {
    mockAdminState.selectResult = makeSelectResult({
      status: 'resolved',
      resolution_state: 'resolved',
    });

    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'accepted_exception',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it('resolves a task with resolution_state = resolved', async () => {
    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
      note: 'Rate confirmed by PM',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.task.resolution_state).toBe('resolved');
      expect(result.task.status).toBe('resolved');
    }
  });

  it('triggers executeApprovalActions recompute for resolution = resolved', async () => {
    const { executeApprovalActions } = await import('../approvalActionEngine');

    await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(executeApprovalActions).toHaveBeenCalledOnce();
    expect(executeApprovalActions).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'project-123', organizationId: 'org-abc' }),
    );
  });

  it('returns recompute result for resolution = resolved', async () => {
    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recompute).not.toBeNull();
      expect(result.recompute?.approval_status).toBe('approved');
    }
  });

  it('does NOT trigger recompute for accepted_exception', async () => {
    const { executeApprovalActions } = await import('../approvalActionEngine');
    mockAdminState.updateResult = makeUpdateResult({ resolution_state: 'accepted_exception' });

    await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'accepted_exception',
      resolvedBy: 'user-xyz',
      note: 'Risk accepted by director',
    });

    expect(executeApprovalActions).not.toHaveBeenCalled();
  });

  it('returns recompute = null for accepted_exception', async () => {
    mockAdminState.updateResult = makeUpdateResult({ resolution_state: 'accepted_exception' });

    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'accepted_exception',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.recompute).toBeNull();
    }
  });

  it('skips recompute when task has no project_id', async () => {
    const { executeApprovalActions } = await import('../approvalActionEngine');
    mockAdminState.selectResult = makeSelectResult({ project_id: null });

    await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    // No project_id → no recompute
    expect(executeApprovalActions).not.toHaveBeenCalled();
  });

  it('logs an activity event on successful resolution', async () => {
    const { logActivityEvent } = await import('../activity/logActivityEvent');

    await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(logActivityEvent).toHaveBeenCalledOnce();
    expect(logActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_type: 'workflow_task',
        entity_id: 'task-001',
        event_type: 'status_changed',
        changed_by: 'user-xyz',
      }),
    );
  });

  it('returns ok:false with 500 when DB update fails', async () => {
    mockAdminState.updateResult = { data: null, error: { message: 'connection error' } };

    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain('connection error');
    }
  });

  it('idempotent: returns ok for task already in same resolution state', async () => {
    // Task is already resolved as 'resolved' — re-resolving as 'resolved' is idempotent
    mockAdminState.selectResult = makeSelectResult({
      status: 'resolved',
      resolution_state: 'resolved',
    });
    // second select (for idempotent path) returns same
    mockAdminState.updateResult = makeUpdateResult();

    const result = await resolveApprovalTask({
      taskId: 'task-001',
      organizationId: 'org-abc',
      resolution: 'resolved',
      resolvedBy: 'user-xyz',
    });

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// markApprovalTaskInReview tests
// ---------------------------------------------------------------------------

describe('markApprovalTaskInReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdminState.selectResult = makeSelectResult();
    mockAdminState.updateResult = { data: { id: 'task-001', status: 'in_review' }, error: null };
  });

  it('returns ok:false with 503 when admin unavailable', async () => {
    const { getSupabaseAdmin } = await import('../supabaseAdmin');
    vi.mocked(getSupabaseAdmin).mockReturnValueOnce(null as any);

    const result = await markApprovalTaskInReview('task-001', 'org-abc', 'user-xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(503);
  });

  it('returns ok:false with 404 when task not found', async () => {
    mockAdminState.selectResult = { data: null, error: { message: 'not found' } };

    const result = await markApprovalTaskInReview('task-999', 'org-abc', 'user-xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(404);
  });

  it('returns ok:false with 409 when task is already resolved', async () => {
    mockAdminState.selectResult = makeSelectResult({ status: 'resolved' });

    const result = await markApprovalTaskInReview('task-001', 'org-abc', 'user-xyz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.status).toBe(409);
  });

  it('is idempotent when task is already in_review', async () => {
    mockAdminState.selectResult = makeSelectResult({ status: 'in_review' });

    const result = await markApprovalTaskInReview('task-001', 'org-abc', 'user-xyz');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.status).toBe('in_review');
  });

  it('updates status to in_review for an open task', async () => {
    const result = await markApprovalTaskInReview('task-001', 'org-abc', 'user-xyz');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.task.status).toBe('in_review');
  });

  it('logs an activity event on in_review transition', async () => {
    const { logActivityEvent } = await import('../activity/logActivityEvent');

    await markApprovalTaskInReview('task-001', 'org-abc', 'user-xyz');

    expect(logActivityEvent).toHaveBeenCalledOnce();
    expect(logActivityEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'status_changed',
        entity_id: 'task-001',
        changed_by: 'user-xyz',
      }),
    );
  });
});
