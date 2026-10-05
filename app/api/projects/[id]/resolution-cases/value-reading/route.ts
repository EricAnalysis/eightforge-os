import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { ValueReadingEngineClient } from '@/lib/server/valueReadingEngine';
import { requestValueReadingFromWorkspace } from '@/lib/server/valueReadingWorkspace';

/**
 * Ask Forgewing to read one unread priced line (B4.4). The body carries only
 * the server-given case id and the operator's request key. Every valid request
 * records exactly one durable outcome; nothing here writes truth.
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
  const result = await requestValueReadingFromWorkspace({
    admin: admin as unknown as ValueReadingEngineClient,
    organizationId: ctx.actor.organizationId,
    actorId: ctx.actor.actorId,
    projectId,
    body,
  });
  return NextResponse.json(result.body, { status: result.status });
}
