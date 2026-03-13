// lib/server/workflows/upsertWorkflowTask.ts
// Idempotent workflow task creation and update via the service role client.
// Dedupe rule: one active (open | in_progress | blocked) task per (organization, entity, task_type).

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export type UpsertWorkflowTaskInput = {
  organization_id: string;
  related_entity_type: 'decision' | 'workflow_task';
  related_entity_id: string;
  task_type: string;
  title: string;
  description?: string | null;
  status?: 'open' | 'in_progress' | 'blocked' | 'resolved' | 'cancelled';
  priority?: string | null;
  assigned_to?: string | null;
  due_at?: string | null;
  metadata?: Record<string, unknown>;
};

export type UpsertWorkflowTaskResult =
  | { ok: true; task_id: string; action: 'created' | 'updated' }
  | { ok: false; error: string };

const ACTIVE_STATUSES = ['open', 'in_progress', 'blocked'] as const;

/**
 * Finds an existing active workflow task matching the (organization, related entity, task_type)
 * triple. If one exists, updates it. If none exists, inserts a new one.
 *
 * "Active" means status is open or in_progress — resolved and cancelled tasks are ignored,
 * so closing a task and re-triggering the same condition creates a fresh task.
 */
export async function upsertWorkflowTask(
  input: UpsertWorkflowTaskInput,
): Promise<UpsertWorkflowTaskResult> {
  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, error: 'Server not configured' };
  }

  const now = new Date().toISOString();

  const { data: existing, error: findError } = await admin
    .from('workflow_tasks')
    .select('id')
    .eq('organization_id', input.organization_id)
    .eq('decision_id', input.related_entity_id)
    .eq('task_type', input.task_type)
    .in('status', [...ACTIVE_STATUSES])
    .limit(1)
    .maybeSingle();

  if (findError) {
    return { ok: false, error: findError.message };
  }

  if (existing) {
    const updates: Record<string, unknown> = { updated_at: now };
    if (input.title !== undefined) updates.title = input.title;
    if (input.description !== undefined) updates.description = input.description;
    if (input.status !== undefined) updates.status = input.status;
    if (input.priority !== undefined) updates.priority = input.priority;
    if (input.assigned_to !== undefined) updates.assigned_to = input.assigned_to;
    if (input.due_at !== undefined) updates.due_at = input.due_at;
    if (input.metadata !== undefined) updates.source_metadata = input.metadata;

    const { error: updateError } = await admin
      .from('workflow_tasks')
      .update(updates)
      .eq('id', existing.id);

    if (updateError) {
      return { ok: false, error: updateError.message };
    }

    return { ok: true, task_id: existing.id as string, action: 'updated' };
  }

  const { data: inserted, error: insertError } = await admin
    .from('workflow_tasks')
    .insert({
      organization_id: input.organization_id,
      decision_id: input.related_entity_id,
      task_type: input.task_type,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'open',
      priority: input.priority ?? 'medium',
      assigned_to: input.assigned_to ?? null,
      due_at: input.due_at ?? null,
      source: 'system',
      source_metadata: input.metadata ?? {},
      details: {},
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single();

  if (insertError) {
    return { ok: false, error: insertError.message };
  }

  return { ok: true, task_id: (inserted as { id: string }).id, action: 'created' };
}
