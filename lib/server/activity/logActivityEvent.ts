// lib/server/activity/logActivityEvent.ts
// Server-only: inserts a row into public.activity_events using the service role client.
// Designed for use inside API routes after a successful mutation.
//
// Real DB schema (columns): id, organization_id, entity_type, entity_id,
// event_type, old_value, new_value, changed_by, created_at.
//
// CHECK constraints enforced by the database:
//   entity_type IN ('decision', 'workflow_task')
//   event_type  IN ('created', 'status_changed', 'assignment_changed', 'due_date_changed')

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export type ActivityEntityType = 'decision' | 'workflow_task';

export type ActivityEventType =
  | 'created'
  | 'status_changed'
  | 'assignment_changed'
  | 'due_date_changed';

export type ActivityInput = {
  organization_id: string;
  entity_type: ActivityEntityType;
  entity_id: string;
  event_type: ActivityEventType;
  changed_by: string | null;
  old_value?: Record<string, unknown> | null;
  new_value?: Record<string, unknown> | null;
};

export type ActivityEventResult =
  | { ok: true; id: string }
  | { ok: false; error: string };

/**
 * Inserts a single activity event row. Uses the service role client so it
 * bypasses RLS — the browser should never call this directly.
 *
 * Returns the inserted row id on success, or an error string on failure.
 * Does not throw; callers should log failures and continue.
 */
export async function logActivityEvent(
  input: ActivityInput,
): Promise<ActivityEventResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: 'Server not configured' };
  }

  const { data, error } = await admin
    .from('activity_events')
    .insert({
      organization_id: input.organization_id,
      entity_type: input.entity_type,
      entity_id: input.entity_id,
      event_type: input.event_type,
      changed_by: input.changed_by,
      old_value: input.old_value ?? null,
      new_value: input.new_value ?? null,
    })
    .select('id')
    .single();

  if (error) {
    return { ok: false, error: error.message };
  }

  return { ok: true, id: (data as { id: string }).id };
}
