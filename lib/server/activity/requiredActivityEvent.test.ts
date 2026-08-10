import { describe, expect, it, vi } from 'vitest';

import { enforceRequiredActivityEvent } from './requiredActivityEvent';

describe('enforceRequiredActivityEvent', () => {
  it('keeps the mutation when the required audit event is retained', async () => {
    const rollback = vi.fn();

    await expect(enforceRequiredActivityEvent({
      activityResult: { ok: true, id: 'event-1' },
      rollback,
      auditFailureMessage: 'audit failed',
      rollbackFailurePrefix: 'rollback failed',
    })).resolves.toEqual({ ok: true });
    expect(rollback).not.toHaveBeenCalled();
  });

  it('compensates the truth mutation when required audit delivery fails', async () => {
    const rollback = vi.fn().mockResolvedValue({ error: null });

    await expect(enforceRequiredActivityEvent({
      activityResult: {
        ok: false,
        error: 'activity unavailable',
        diagnostic: {
          code: 'ACTIVITY_EVENT_DELIVERY_FAILED',
          organization_id: 'org-1',
          project_id: 'project-1',
          entity_type: 'document',
          entity_id: 'duplicate-document',
          event_type: 'document_relationship_created',
          error: 'activity unavailable',
        },
      },
      rollback,
      auditFailureMessage: 'duplicate disposition was not retained',
      rollbackFailurePrefix: 'duplicate disposition rollback failed',
    })).resolves.toEqual({
      ok: false,
      status: 503,
      error: 'duplicate disposition was not retained',
    });
    expect(rollback).toHaveBeenCalledOnce();
  });

  it('surfaces a failed compensation instead of claiming the mutation was reverted', async () => {
    const rollback = vi.fn().mockResolvedValue({ error: { message: 'database unavailable' } });

    await expect(enforceRequiredActivityEvent({
      activityResult: {
        ok: false,
        error: 'activity unavailable',
        diagnostic: {
          code: 'ACTIVITY_EVENT_DELIVERY_FAILED',
          organization_id: 'org-1',
          project_id: 'project-1',
          entity_type: 'document',
          entity_id: 'duplicate-document',
          event_type: 'document_relationship_changed',
          error: 'activity unavailable',
        },
      },
      rollback,
      auditFailureMessage: 'duplicate reversal was not retained',
      rollbackFailurePrefix: 'duplicate reversal rollback failed',
    })).resolves.toEqual({
      ok: false,
      status: 500,
      error: 'duplicate reversal rollback failed: database unavailable',
    });
  });
});
