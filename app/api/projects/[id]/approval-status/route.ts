import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getProjectApprovalStatus } from '@/lib/server/approvalEnforcement';
import { loadScopedProject } from '@/lib/server/projectAdmin';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project id is required', 400);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  // Verify project exists and user has access
  const project = await loadScopedProject(admin, {
    organizationId: ctx.actor.organizationId,
    projectId,
  });
  if (!project) return jsonError('Project not found', 404);

  try {
    const approvalStatus = await getProjectApprovalStatus(projectId);
    return NextResponse.json({ approval_status: approvalStatus });
  } catch (error) {
    console.error('[approval-status] Failed to fetch approval status:', {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return jsonError('Failed to fetch approval status', 500);
  }
}
