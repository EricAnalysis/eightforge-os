import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadOperationalQueueModel } from '@/lib/server/operationalQueue';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const model = await loadOperationalQueueModel({
      admin,
      organizationId: ctx.actor.organizationId,
    });

    return NextResponse.json(model);
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : 'Failed to load operational model',
      500,
    );
  }
}
