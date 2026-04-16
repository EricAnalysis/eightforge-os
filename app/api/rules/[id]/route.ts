import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const result = await getActorContext(req);
  if (!result.ok) return jsonError(result.error, result.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const { data: existing, error: fetchError } = await admin
    .from('rules')
    .select('id, organization_id')
    .eq('id', id)
    .single();

  if (fetchError || !existing) return jsonError('Rule not found', 404);

  const rule = existing as { id: string; organization_id: string | null };
  if (rule.organization_id && rule.organization_id !== result.actor.organizationId) {
    return jsonError('Rule not found', 404);
  }

  const updatePayload: Record<string, unknown> = {};
  const allowedFields = [
    'domain', 'document_type', 'rule_group', 'name', 'description',
    'decision_type', 'severity', 'priority', 'status',
    'condition_json', 'action_json',
  ];

  for (const field of allowedFields) {
    if (body[field] !== undefined) {
      updatePayload[field] = body[field];
    }
  }
  updatePayload.updated_by = result.actor.actorId;

  const { error: updateError } = await admin
    .from('rules')
    .update(updatePayload)
    .eq('id', id);

  if (updateError) return jsonError(updateError.message, 500);

  return NextResponse.json({ ok: true });
}
