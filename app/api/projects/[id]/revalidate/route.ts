import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';

function jsonError(message: string, status: number) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  if (!projectId) return jsonError('Project not found', 404);

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const { data: projectRow, error: projectError } = await admin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('organization_id', organizationId)
    .maybeSingle();

  if (projectError) return jsonError(projectError.message, 500);
  if (!projectRow) return jsonError('Project not found', 404);

  const result = await triggerProjectValidation(projectId, 'manual', actorId);
  return NextResponse.json({ ok: true, result });
}

