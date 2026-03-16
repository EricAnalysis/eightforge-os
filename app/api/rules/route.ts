import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const result = await getActorContext(req);
  if (!result.ok) return jsonError(result.error, result.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body) return jsonError('Invalid JSON body', 400);

  const {
    domain, document_type, rule_group, name, description,
    decision_type, severity, priority, status,
    condition_json, action_json,
  } = body;

  if (!domain || !document_type || !name || !decision_type) {
    return jsonError('domain, document_type, name, and decision_type are required', 400);
  }

  const { data, error } = await admin
    .from('rules')
    .insert({
      organization_id: result.actor.organizationId,
      domain,
      document_type,
      rule_group: rule_group || null,
      name,
      description: description || null,
      decision_type,
      severity: severity || 'medium',
      priority: typeof priority === 'number' ? priority : 100,
      status: status || 'active',
      condition_json: condition_json ?? {},
      action_json: action_json ?? {},
      created_by: result.actor.actorId,
      updated_by: result.actor.actorId,
    })
    .select('id')
    .single();

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({ ok: true, id: (data as { id: string }).id });
}
