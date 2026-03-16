import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: decisionId } = await params;

  const result = await getActorContext(req);
  if (!result.ok) return jsonError(result.error, result.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.is_correct !== 'boolean') {
    return jsonError('is_correct (boolean) is required', 400);
  }

  const { data: decision, error: fetchError } = await admin
    .from('decisions')
    .select('id, organization_id')
    .eq('id', decisionId)
    .single();

  if (fetchError || !decision) return jsonError('Decision not found', 404);

  const dec = decision as { id: string; organization_id: string };
  if (dec.organization_id !== result.actor.organizationId) {
    return jsonError('Decision not found', 404);
  }

  const { error: upsertError } = await admin
    .from('decision_feedback')
    .upsert(
      {
        decision_id: decisionId,
        organization_id: result.actor.organizationId,
        is_correct: body.is_correct,
        reviewed_by: result.actor.actorId,
        created_at: new Date().toISOString(),
      },
      { onConflict: 'decision_id,reviewed_by' },
    );

  if (upsertError) return jsonError(upsertError.message, 500);

  return NextResponse.json({ ok: true });
}
