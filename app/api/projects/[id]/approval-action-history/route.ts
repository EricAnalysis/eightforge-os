import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadScopedProject } from '@/lib/server/projectAdmin';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getApprovalActionHistory } from '@/lib/server/approvalActionHistory';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET /api/projects/[id]/approval-action-history
 *
 * Returns grouped approval action execution history for a project,
 * newest first. Each group represents one call to executeApprovalActions()
 * and contains the approval status that triggered it plus every task
 * that was created or updated as a result.
 *
 * Query params:
 *   limit?: number  — max execution groups to return (default 10, max 50)
 *
 * Authorization: org membership verified via loadScopedProject.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project id is required', 400);

  try {
    const ctx = await getActorContext(request);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const project = await loadScopedProject(admin, {
      organizationId: ctx.actor.organizationId,
      projectId,
    });
    if (!project) return jsonError('Project not found', 404);

    // Parse optional limit param — cap at 50 to prevent abuse
    const url = new URL(request.url);
    const rawLimit = parseInt(url.searchParams.get('limit') ?? '10', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 10;

    const history = await getApprovalActionHistory(projectId, limit);

    console.info('[approval-action-history] fetched', {
      projectId,
      executions: history.executions.length,
      total_actions: history.total_actions,
    });

    return NextResponse.json(history);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[approval-action-history] unhandled error', { projectId, error: message });
    return jsonError('Internal server error', 500);
  }
}
