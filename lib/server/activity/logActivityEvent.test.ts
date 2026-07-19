import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSupabaseAdminMock } = vi.hoisted(() => ({
  getSupabaseAdminMock: vi.fn(),
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: getSupabaseAdminMock,
}));

import {
  ACTIVITY_EVENT_DELIVERY_FAILURE_CODE,
  logActivityEvent,
  type ActivityInput,
} from './logActivityEvent';

const input: ActivityInput = {
  organization_id: 'org-1',
  project_id: 'project-1',
  entity_type: 'execution_item',
  entity_id: 'execution-1',
  event_type: 'status_changed',
  changed_by: 'user-1',
  old_value: { status: 'resolved' },
  new_value: {
    status: 'superseded',
    superseded_by_run_id: 'run-2',
  },
};

function adminReturning(result: {
  data: { id: string } | null;
  error: { message: string } | null;
}) {
  const single = vi.fn().mockResolvedValue(result);
  const select = vi.fn(() => ({ single }));
  const insert = vi.fn(() => ({ select }));
  const from = vi.fn(() => ({ insert }));
  return { admin: { from }, from, insert, select, single };
}

describe('logActivityEvent', () => {
  beforeEach(() => {
    getSupabaseAdminMock.mockReset();
    vi.restoreAllMocks();
  });

  it('preserves the activity event payload on successful delivery', async () => {
    const query = adminReturning({ data: { id: 'activity-1' }, error: null });
    getSupabaseAdminMock.mockReturnValue(query.admin);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(logActivityEvent(input)).resolves.toEqual({
      ok: true,
      id: 'activity-1',
    });
    expect(query.from).toHaveBeenCalledWith('activity_events');
    expect(query.insert).toHaveBeenCalledWith({
      organization_id: 'org-1',
      project_id: 'project-1',
      entity_type: 'execution_item',
      entity_id: 'execution-1',
      event_type: 'status_changed',
      changed_by: 'user-1',
      old_value: { status: 'resolved' },
      new_value: {
        status: 'superseded',
        superseded_by_run_id: 'run-2',
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('surfaces returned insert failures with a deterministic diagnostic', async () => {
    const query = adminReturning({
      data: null,
      error: { message: 'activity insert rejected' },
    });
    getSupabaseAdminMock.mockReturnValue(query.admin);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await logActivityEvent(input);

    expect(result).toEqual({
      ok: false,
      error: 'activity insert rejected',
      diagnostic: {
        code: ACTIVITY_EVENT_DELIVERY_FAILURE_CODE,
        organization_id: 'org-1',
        project_id: 'project-1',
        entity_type: 'execution_item',
        entity_id: 'execution-1',
        event_type: 'status_changed',
        error: 'activity insert rejected',
      },
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[activity-event-delivery]',
      result.ok ? undefined : result.diagnostic,
    );
  });

  it('surfaces missing configuration instead of failing silently', async () => {
    getSupabaseAdminMock.mockReturnValue(null);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await logActivityEvent(input);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected delivery failure');
    expect(result.diagnostic.code).toBe(ACTIVITY_EVENT_DELIVERY_FAILURE_CODE);
    expect(result.error).toBe('Server not configured');
    expect(consoleError).toHaveBeenCalledOnce();
  });

  it('converts thrown client failures into the same observable result', async () => {
    getSupabaseAdminMock.mockImplementation(() => {
      throw new Error('client initialization failed');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await logActivityEvent(input);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('Expected delivery failure');
    expect(result.error).toBe('client initialization failed');
    expect(result.diagnostic).toMatchObject({
      code: ACTIVITY_EVENT_DELIVERY_FAILURE_CODE,
      entity_id: 'execution-1',
      event_type: 'status_changed',
    });
    expect(consoleError).toHaveBeenCalledWith(
      '[activity-event-delivery]',
      result.diagnostic,
    );
  });
});
