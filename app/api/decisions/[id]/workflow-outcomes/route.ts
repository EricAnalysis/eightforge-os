// app/api/decisions/[id]/workflow-outcomes/route.ts
// GET: return workflow execution outcomes for a decision.
//
// Data returned:
//   1. workflow_tasks linked to this decision (rule engine triggers)
//   2. approval_action_log entries for the project, scoped to a window
//      that starts at the decision's created_at (max 20 entries)
//
// Org ownership is verified server-side via getActorContext.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export type WorkflowOutcomesResult = {
  decision_id: string;
  project_id: string | null;
  // Tasks created directly from this decision (rule engine)
  triggered_tasks: Array<{
    id: string;
    task_type: string;
    title: string;
    status: string;
    priority: string;
    created_at: string;
    source_metadata: Record<string, unknown> | null;
  }>;
  // Approval engine log entries for the project (approval engine actions)
  approval_engine_actions: Array<{
    id: string;
    action_type: string;
    approval_status: string;
    task_outcome: string;
    invoice_number: string | null;
    amount: number | null;
    reason: string | null;
    priority: string;
    task_id: string | null;
    error: string | null;
    executed_at: string;
  }>;
};

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: decisionId } = await params;
  if (!decisionId) return jsonError('Decision not found', 404);

  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  // Verify org ownership + get project_id and created_at
  const { data: decision, error: decisionError } = await admin
    .from('decisions')
    .select('id, organization_id, project_id, created_at')
    .eq('id', decisionId)
    .single();

  if (decisionError || !decision) {
    if (decisionError) console.error('[workflow-outcomes] decision fetch error:', decisionError.message);
    return jsonError('Decision not found', 404);
  }
  if ((decision.organization_id as string) !== organizationId) {
    return jsonError('Decision not found', 404);
  }

  const projectId = (decision.project_id as string | null) ?? null;
  const decisionCreatedAt = decision.created_at as string;

  // 1. Workflow tasks linked to this decision
  const { data: tasksData } = await admin
    .from('workflow_tasks')
    .select('id, task_type, title, status, priority, created_at, source_metadata')
    .eq('decision_id', decisionId)
    .order('created_at', { ascending: true })
    .limit(20);

  // 2. Approval engine actions for the project, from decision creation onward
  let approvalActions: WorkflowOutcomesResult['approval_engine_actions'] = [];
  if (projectId) {
    const { data: actionData } = await admin
      .from('approval_action_log')
      .select(
        'id, action_type, approval_status, task_outcome, invoice_number, amount, reason, priority, task_id, error, executed_at',
      )
      .eq('project_id', projectId)
      .gte('executed_at', decisionCreatedAt)
      .order('executed_at', { ascending: true })
      .limit(20);

    approvalActions = (actionData ?? []) as WorkflowOutcomesResult['approval_engine_actions'];
  }

  const result: WorkflowOutcomesResult = {
    decision_id: decisionId,
    project_id: projectId,
    triggered_tasks: (tasksData ?? []) as WorkflowOutcomesResult['triggered_tasks'],
    approval_engine_actions: approvalActions,
  };

  return NextResponse.json(result);
}
