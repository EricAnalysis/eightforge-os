// app/api/workflow-tasks/[id]/status/route.ts
// PATCH: update workflow task status (org-scoped). Sets completed_at when resolved.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { processWorkflowTriggers } from '@/lib/server/workflows/processWorkflowTriggers';

const VALID_STATUSES = ['open', 'in_progress', 'blocked', 'resolved', 'cancelled'] as const;

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
      .select('id, organization_id, status, decision_id')
      .eq('id', taskId)
      .single();

    if (fetchError || !existing) return jsonError('Task not found', 404);

    // 3. Verify org ownership
    if ((existing.organization_id as string) !== organizationId) {
      return jsonError('Task not found', 404);
    }

    // 4. Validate input
    const body = await req.json().catch(() => ({}));
    const newStatus = typeof body?.status === 'string' ? body.status : null;
    if (!newStatus || !VALID_STATUSES.includes(newStatus as (typeof VALID_STATUSES)[number])) {
      return jsonError('Invalid status', 400);
    }

    const previousStatus = (existing.status as string) ?? null;

    // 5. Update task
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      status: newStatus,
      updated_at: now,
      completed_at: newStatus === 'resolved' ? now : null,
    };

    const { data: updated, error: updateError } = await admin
      .from('workflow_tasks')
      .update(updates)
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // 6. Log activity event only when status actually changed
    if (previousStatus !== newStatus) {
      const activityResult = await logActivityEvent({
        organization_id: organizationId,
        entity_type: 'workflow_task',
        entity_id: taskId,
        event_type: 'status_changed',
        changed_by: actorId,
        old_value: { status: previousStatus },
        new_value: { status: newStatus },
      });

      if (!activityResult.ok) {
        console.error('[workflow-task/status] activity event failed:', activityResult.error);
      }

      // 7. Run workflow triggers (Rule 4: task completed → decision advancement check)
      await processWorkflowTriggers({
        organizationId,
        eventType: 'status_changed',
        entityType: 'workflow_task',
        entityId: taskId,
        payload: {
          from: previousStatus,
          to: newStatus,
          related_decision_id: (existing.decision_id as string | null) ?? undefined,
        },
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
