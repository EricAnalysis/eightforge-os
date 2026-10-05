import { NextRequest, NextResponse } from 'next/server';

import { offeredAction } from '@/lib/resolution/resolutionActionRequest';
import { getActorContext } from '@/lib/server/getActorContext';
import { readResolutionQueue } from '@/lib/server/resolutionQueueRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { runValueReading, type ValueReadingEngineClient } from '@/lib/server/valueReadingEngine';

/** Operator request only. Evidence and capability are re-derived on the server. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id: projectId } = await params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'caseId' && key !== 'requestKey')
    || typeof body.caseId !== 'string' || !body.caseId.trim() || body.caseId.length > 500
    || typeof body.requestKey !== 'string' || !body.requestKey.trim() || body.requestKey.length > 200) {
    return NextResponse.json({ error: 'caseId and requestKey are required' }, { status: 400 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  try {
    const read = await readResolutionQueue({ organizationId: ctx.actor.organizationId, projectId });
    if (read.status === 'not_found') return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (read.status !== 'ok') return NextResponse.json({ error: 'Resolution queue unavailable' }, { status: 503 });
    const entry = read.queue.cases.find((candidate) => candidate.caseId === body.caseId);
    if (!entry || !offeredAction(entry, 'request_value_reading')) {
      return NextResponse.json({ error: 'Value reading is no longer offered', code: 'action_not_offered' }, { status: 409 });
    }
    const result = await runValueReading(admin as unknown as ValueReadingEngineClient, {
      organizationId: ctx.actor.organizationId, projectId, caseId: entry.caseId,
      requestedBy: ctx.actor.actorId, requestKey: body.requestKey, includeTextExcerpts: false,
    });
    if (result.status === 'not_resolved') {
      return NextResponse.json({ error: 'The current source target is unavailable', code: result.reason },
        { status: result.reason === 'read_failed' ? 503 : 409 });
    }
    return NextResponse.json(result, { status: result.outcomeRecorded ? 200 : 503 });
  } catch {
    return NextResponse.json({ error: 'Value reading unavailable' }, { status: 503 });
  }
}
