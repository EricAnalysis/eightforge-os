import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { ValueReadingClient } from '@/lib/server/valueReadingProposals';
import { reviewValueReadingFromWorkspace } from '@/lib/server/valueReadingWorkspace';

/**
 * Reject or defer a Forgewing value reading (B4.4). Neither authorizes a
 * value: using a reading is a reviewed value through the B3 route.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  const body = await req.json().catch(() => null) as unknown;
  const result = await reviewValueReadingFromWorkspace({
    admin: admin as unknown as ValueReadingClient,
    organizationId: ctx.actor.organizationId,
    actorId: ctx.actor.actorId,
    projectId,
    body,
  });
  return NextResponse.json(result.body, { status: result.status });
}
