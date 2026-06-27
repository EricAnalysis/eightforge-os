// app/api/decisions/[id]/status/route.ts
// PATCH: update decision status (org-scoped). Sets resolved_at when status is resolved.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { logDecisionFeedback } from '@/lib/server/decisionFeedback';
import { closeDecisionLinkedWork } from '@/lib/server/decisionClosure';
import { processWorkflowTriggers } from '@/lib/server/workflows/processWorkflowTriggers';
import { requestDecisionStatusRevalidation } from '@/lib/validator/revalidationRequests';

const VALID_STATUSES = ['open', 'in_review', 'resolved', 'suppressed'] as const;
const VALID_OPERATOR_ACTIONS = ['approve', 'confirm', 'correct', 'override', 'needs_review', 'escalate', 'verify'] as const;

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
      .select('id, organization_id, project_id, document_id, status, severity')
      .eq('id', decisionId)
      .single();

    if (fetchError || !existing) return jsonError('Decision not found', 404);

    // 3. Verify org ownership (do not trust browser-supplied org)
    if ((existing.organization_id as string) !== organizationId) {
      return jsonError('Decision not found', 404);
    }

    // 4. Validate input
    const body = await req.json().catch(() => ({}));
    const newStatus = typeof body?.status === 'string' ? body.status : null;
    if (!newStatus || !VALID_STATUSES.includes(newStatus as (typeof VALID_STATUSES)[number])) {
      return jsonError('Invalid status', 400);
    }
    const operatorAction =
      typeof body?.operator_action === 'string' && VALID_OPERATOR_ACTIONS.includes(body.operator_action)
        ? body.operator_action
        : null;
    if (
      (newStatus === 'resolved' || newStatus === 'suppressed') &&
      (operatorAction === 'approve' || operatorAction === 'correct' || operatorAction === 'override')
    ) {
      return jsonError(
        'Approval-impacting outcomes must be finalized through Execution.',
        409,
      );
    }

    const previousStatus = (existing.status as string) ?? null;

    // 5. Update decision
    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      status: newStatus,
      updated_at: now,
      resolved_at: newStatus === 'resolved' ? now : null,
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

    let closureResult: Awaited<ReturnType<typeof closeDecisionLinkedWork>> | null = null;
    if (newStatus === 'resolved' || newStatus === 'suppressed') {
      closureResult = await closeDecisionLinkedWork({
        admin,
        decisionId,
        organizationId,
        projectId: typeof existing.project_id === 'string' ? existing.project_id : null,
        documentId: typeof existing.document_id === 'string' ? existing.document_id : null,
        actorId,
        status: newStatus,
        now,
      });
      if (closureResult.errors.length > 0) {
        console.error(
          '[decision/status] linked closure completed with errors:',
          closureResult.errors,
        );
      }
    }

    // 6. Log activity event only when status actually changed
    if (previousStatus !== newStatus) {
      const activityResult = await logActivityEvent({
        organization_id: organizationId,
        project_id: typeof existing.project_id === 'string' ? existing.project_id : null,
        entity_type: 'decision',
        entity_id: decisionId,
        event_type: 'status_changed',
        changed_by: actorId,
        old_value: { status: previousStatus },
        new_value: {
          status: newStatus,
          operator_action: operatorAction,
          linked_closure: closureResult
            ? {
                findings: closureResult.closedFindingIds.length,
                workflow_tasks: closureResult.closedWorkflowTaskIds.length,
                execution_items: closureResult.closedExecutionItemIds.length,
                document_status_recomputed: closureResult.recomputedDocumentStatus,
                errors: closureResult.errors,
              }
            : null,
        },
      });

      if (!activityResult.ok) {
        console.error('[decision/status] activity event failed:', activityResult.error);
      }

      // Legacy audit log — keep until fully migrated to activity_events
      const feedbackResult = await logDecisionFeedback(admin, {
        organization_id: organizationId,
        decision_id: decisionId,
        new_status: newStatus,
        previous_status: previousStatus,
        created_by: actorId,
      });
      if (!feedbackResult.ok) {
        console.error('[decision/status] feedback insert failed:', feedbackResult.error);
      }

      // 7. Run workflow triggers after successful write + activity event
      await processWorkflowTriggers({
        organizationId,
        eventType: 'status_changed',
        entityType: 'decision',
        entityId: decisionId,
        payload: {
          from: previousStatus,
          to: newStatus,
          severity: existing.severity as string | null,
        },
      });

      void requestDecisionStatusRevalidation({
        projectId: typeof existing.project_id === 'string' ? existing.project_id : null,
        actorId,
        newStatus,
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
