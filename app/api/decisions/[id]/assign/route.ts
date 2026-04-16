// app/api/decisions/[id]/assign/route.ts
// PATCH: assign decision to a user (org-scoped).

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
    const { id: decisionId } = await params;
    if (!decisionId) return jsonError('Decision not found', 404);

    // 1. Authorize
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { actorId, organizationId } = ctx.actor;

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    // 2. Load current row
    const { data: existing, error: fetchError } = await admin
      .from('decisions')
      .select('id, organization_id, assigned_to')
      .eq('id', decisionId)
      .single();

    if (fetchError || !existing) return jsonError('Decision not found', 404);

    // 3. Verify org ownership
    if ((existing.organization_id as string) !== organizationId) {
      return jsonError('Decision not found', 404);
    }

    // 4. Validate input
    const body = await req.json().catch(() => ({}));
    const assignedTo: string | null =
      typeof body?.assigned_to === 'string' && body.assigned_to.length > 0
        ? body.assigned_to
        : null;

    if (assignedTo) {
      const { data: target, error: targetError } = await admin
        .from('user_profiles')
        .select('id')
        .eq('id', assignedTo)
        .eq('organization_id', organizationId)
        .single();
      if (targetError || !target) return jsonError('Assignee not in organization', 400);
    }

    const previousAssignee = (existing.assigned_to as string | null) ?? null;

    // 5. Update decision
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      assigned_to: assignedTo,
      assigned_at: assignedTo ? now : null,
      assigned_by: assignedTo ? actorId : null,
      updated_at: now,
    };

    const { data: updated, error: updateError } = await admin
      .from('decisions')
      .update(updates)
      .eq('id', decisionId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    // 6. Log activity event only when assignment actually changed
    if (previousAssignee !== assignedTo) {
      const activityResult = await logActivityEvent({
        organization_id: organizationId,
        entity_type: 'decision',
        entity_id: decisionId,
        event_type: 'assignment_changed',
        changed_by: actorId,
        old_value: { assigned_to: previousAssignee },
        new_value: { assigned_to: assignedTo },
      });

      if (!activityResult.ok) {
        console.error('[decision/assign] activity event failed:', activityResult.error);
      }

      // 7. Run workflow triggers
      await processWorkflowTriggers({
        organizationId,
        eventType: 'assignment_changed',
        entityType: 'decision',
        entityId: decisionId,
        payload: { from: previousAssignee, to: assignedTo },
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
