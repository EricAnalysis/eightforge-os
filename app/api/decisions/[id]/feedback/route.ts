// app/api/decisions/[id]/feedback/route.ts
// POST: submit human feedback on a decision.
// Accepts { is_correct, feedback_type?, notes?, disposition?, corrected_value? }.
// Upserts on (decision_id, reviewer_id) — one feedback record per reviewer per decision.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const VALID_FEEDBACK_TYPES = ['correct', 'incorrect', 'needs_review', 'override'] as const;
const VALID_DISPOSITIONS = ['accept', 'reject', 'escalate', 'suppress'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: decisionId } = await params;

  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body || typeof body.is_correct !== 'boolean') {
    return jsonError('is_correct (boolean) is required', 400);
  }

  // Validate optional fields
  const feedbackType: string =
    typeof body.feedback_type === 'string' && VALID_FEEDBACK_TYPES.includes(body.feedback_type)
      ? body.feedback_type
      : body.is_correct ? 'correct' : 'incorrect';

  const disposition: string | null =
    typeof body.disposition === 'string' && VALID_DISPOSITIONS.includes(body.disposition)
      ? body.disposition
      : null;

  const notes: string | null =
    typeof body.notes === 'string' && body.notes.trim().length > 0
      ? body.notes.trim()
      : null;

  const correctedValue: Record<string, unknown> | null =
    body.corrected_value && typeof body.corrected_value === 'object'
      ? (body.corrected_value as Record<string, unknown>)
      : null;

  // Verify decision exists and belongs to caller's org
  const { data: decision, error: fetchError } = await admin
    .from('decisions')
    .select('id, organization_id, status')
    .eq('id', decisionId)
    .single();

  if (fetchError || !decision) return jsonError('Decision not found', 404);

  const dec = decision as { id: string; organization_id: string; status: string };
  if (dec.organization_id !== organizationId) {
    return jsonError('Decision not found', 404);
  }

  const now = new Date().toISOString();

  // Upsert feedback — one record per (decision_id, reviewer_id)
  const { error: upsertError } = await admin
    .from('decision_feedback')
    .upsert(
      {
        decision_id: decisionId,
        organization_id: organizationId,
        is_correct: body.is_correct,
        feedback_type: feedbackType,
        disposition,
        notes,
        corrected_value: correctedValue,
        reviewer_id: actorId,
        created_by: actorId,
        created_at: now,
      },
      { onConflict: 'decision_id,reviewer_id' },
    );

  if (upsertError) return jsonError(upsertError.message, 500);

  // If reviewer marks incorrect, auto-move decision to in_review if currently open
  if (!body.is_correct && dec.status === 'open') {
    await admin
      .from('decisions')
      .update({ status: 'in_review', updated_at: now })
      .eq('id', decisionId)
      .eq('organization_id', organizationId);
  }

  return NextResponse.json({ ok: true, feedback_type: feedbackType });
}
