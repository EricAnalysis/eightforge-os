import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadScopedProject } from '@/lib/server/projectAdmin';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { executeApprovalActions } from '@/lib/server/approvalActionEngine';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * POST /api/projects/[id]/execute-approval-actions
 *
 * Manually re-trigger the approval action engine for a project.
 * Reads the latest approval snapshot and creates / updates workflow tasks
 * deterministically.
 *
 * Useful for:
 *  - Re-running after a snapshot is corrected
 *  - Recovering from a failed automatic execution
 *  - Testing the operator graph end-to-end
 *
 * Authorization: org membership verified via loadScopedProject.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project id is required', 400);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const project = await loadScopedProject(admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });
  if (!project) return jsonError('Project not found', 404);

  console.info('[execute-approval-actions] triggered', {
    projectId,
    organizationId: ctx.actor.organizationId,
    actorId: ctx.actor.actorId,
  });

  const result = await executeApprovalActions({
    projectId,
    organizationId: ctx.actor.organizationId,
  });

  if (result.errors.length > 0) {
    console.error('[execute-approval-actions] completed with errors', {
      projectId,
      approval_status: result.approval_status,
      tasks_created: result.tasks_created,
      tasks_updated: result.tasks_updated,
      errors: result.errors,
    });
  } else {
    console.info('[execute-approval-actions] completed successfully', {
      projectId,
      approval_status: result.approval_status,
      tasks_created: result.tasks_created,
      tasks_updated: result.tasks_updated,
      actions_planned: result.actions_planned.length,
    });
  }

  // Return 200 even when partial errors occur — result.errors describes them.
  // Callers should inspect errors[] to determine if a retry is needed.
  return NextResponse.json(result);
}
