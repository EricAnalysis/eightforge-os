import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';

function jsonError(message: string, code: string, status: number) {
  return NextResponse.json({ ok: false, code, error: message }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project not found', 'PROJECT_NOT_FOUND', 404);

  const ctx = await getActorContext(request);
  if (!ctx.ok) {
    return jsonError(
      ctx.status === 401 ? 'Not signed in' : ctx.error,
      ctx.status === 401 ? 'UNAUTHORIZED' : 'ACTOR_CONTEXT_FAILED',
      ctx.status,
    );
  }
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 'SERVER_NOT_CONFIGURED', 503);

  const { data: projectRow, error: projectError } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (projectError) return jsonError(projectError.message, 'PROJECT_LOOKUP_FAILED', 500);
  if (!projectRow) return jsonError('Not authorized for project', 'PROJECT_ACCESS_DENIED', 403);

  const result = await triggerProjectValidation(projectId, 'manual', actorId);
  console.info('[projects/revalidate] trigger result', {
    projectId,
    actorId,
    status: result.status,
    reason: result.status === 'skipped' ? result.reason : null,
    mode: result.status === 'triggered' ? result.mode : null,
  });
  return NextResponse.json({ ok: true, result });
}

