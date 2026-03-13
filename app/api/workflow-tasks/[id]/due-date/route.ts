// app/api/workflow-tasks/[id]/due-date/route.ts
// PATCH: update workflow task due_at (org-scoped). Accepts { due_at: string | null }.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { processWorkflowTriggers } from '@/lib/server/workflows/processWorkflowTriggers';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: taskId } = await params;
    if (!taskId) return jsonError('Task not found', 404);

    // 1. Authorize
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { actorId, organizationId } = ctx.actor;

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    // 2. Load current row
    const { data: existing, error: fetchError } = await admin
      .from('workflow_tasks')
      .select('id, organization_id, due_at')
      .eq('id', taskId)
      .single();

    if (fetchError || !existing) return jsonError('Task not found', 404);

    // 3. Verify org ownership
    if ((existing.organization_id as string) !== organizationId) {
      return jsonError('Task not found', 404);
    }

    // 4. Validate input
    const body = await req.json().catch(() => ({}));
    const dueAt: string | null | undefined =
      body?.due_at === null
        ? null
        : typeof body?.due_at === 'string'
          ? body.due_at
          : undefined;

    if (dueAt === undefined) return jsonError('Invalid due_at value', 400);
    if (dueAt !== null && isNaN(Date.parse(dueAt)))
      return jsonError('Invalid due_at date', 400);

    const previousDueAt = (existing.due_at as string | null) ?? null;

    // 5. Update task
    const { data: updated, error: updateError } = await admin
      .from('workflow_tasks')
      .update({ due_at: dueAt, updated_at: new Date().toISOString() })
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (updateError)
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    if (!updated) return jsonError('Task not found', 404);

    // 6. Log activity event only when due_at actually changed
    if (previousDueAt !== dueAt) {
      const activityResult = await logActivityEvent({
        organization_id: organizationId,
        entity_type: 'workflow_task',
        entity_id: taskId,
        event_type: 'due_date_changed',
        changed_by: actorId,
        old_value: { due_at: previousDueAt },
        new_value: { due_at: dueAt },
      });

      if (!activityResult.ok) {
        console.error('[workflow-task/due-date] activity event failed:', activityResult.error);
      }

      // 7. Run workflow triggers
      await processWorkflowTriggers({
        organizationId,
        eventType: 'due_date_changed',
        entityType: 'workflow_task',
        entityId: taskId,
        payload: { from: previousDueAt, to: dueAt },
      });
    }

    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
