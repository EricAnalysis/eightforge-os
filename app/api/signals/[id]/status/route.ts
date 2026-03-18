// app/api/signals/[id]/status/route.ts
// PATCH: update signal status (active → resolved | ignored).
// Scoped to caller's organization.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const VALID_STATUSES = ['active', 'resolved', 'ignored'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id: signalId } = await params;
    if (!signalId) return jsonError('Signal not found', 404);

    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { organizationId } = ctx.actor;

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const body = await req.json().catch(() => ({}));
    const newStatus = body?.status as string | undefined;

    if (!newStatus || !VALID_STATUSES.includes(newStatus as typeof VALID_STATUSES[number])) {
      return jsonError(`status must be one of: ${VALID_STATUSES.join(', ')}`, 400);
    }

    // Verify signal belongs to caller's org
    const { data: existing, error: fetchError } = await admin
      .from('signals')
      .select('id, organization_id, status')
      .eq('id', signalId)
      .single();

    if (fetchError || !existing) return jsonError('Signal not found', 404);
    if ((existing.organization_id as string) !== organizationId) return jsonError('Signal not found', 404);

    const { data: updated, error: updateError } = await admin
      .from('signals')
      .update({ status: newStatus })
      .eq('id', signalId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (updateError) return jsonError(updateError.message, 500);

    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
