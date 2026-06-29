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

  if (projectError) {
    console.error('[projects/revalidate] project lookup failed', { projectId, error: projectError.message });
    return jsonError('Failed to look up project', 'PROJECT_LOOKUP_FAILED', 500);
  }
  if (!projectRow) return jsonError('Not authorized for project', 'PROJECT_ACCESS_DENIED', 403);

  try {
    const result = await triggerProjectValidation(projectId, 'manual', actorId, { force: true });
    console.info('[projects/revalidate] trigger result', {
      projectId,
      actorId,
      status: result.status,
      reason: result.status === 'skipped' ? result.reason : null,
      mode: result.status === 'triggered' ? result.mode : null,
    });
    return NextResponse.json({ ok: true, result });
  } catch (err) {
    console.error('[projects/revalidate] validation trigger failed', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonError('Validation run failed to complete', 'VALIDATION_TRIGGER_FAILED', 500);
  }
}

