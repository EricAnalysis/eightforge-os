import { NextRequest, NextResponse } from 'next/server';

import { offeredAction } from '@/lib/resolution/resolutionActionRequest';
import { getActorContext } from '@/lib/server/getActorContext';
import { readResolutionQueue } from '@/lib/server/resolutionQueueRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { recordValueReadingReview, type ValueReadingClient } from '@/lib/server/valueReadingProposals';

/** Immutable reject/defer history only. This route cannot promote a proposal. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id: projectId } = await params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !['caseId', 'proposalId', 'proposalDigestSha256', 'disposition', 'rationale', 'idempotencyKey'].includes(key))
    || typeof body.caseId !== 'string' || !body.caseId.trim() || body.caseId.length > 500
    || typeof body.proposalId !== 'string' || !/^forgewing-proposal-value-reading-[0-9a-f]{64}$/.test(body.proposalId)
    || typeof body.proposalDigestSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(body.proposalDigestSha256)
    || (body.disposition !== 'rejected' && body.disposition !== 'deferred')
    || typeof body.rationale !== 'string' || !body.rationale.trim() || body.rationale.trim().length > 4000
    || typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) {
    return NextResponse.json({ error: 'caseId, rejected/deferred disposition, rationale and idempotencyKey are required' }, { status: 400 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  try {
    const read = await readResolutionQueue({ organizationId: ctx.actor.organizationId, projectId });
    if (read.status === 'not_found') return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    if (read.status !== 'ok') return NextResponse.json({ error: 'Resolution queue unavailable' }, { status: 503 });
    const entry = read.queue.cases.find((candidate) => candidate.caseId === body.caseId);
    const action = entry ? offeredAction(entry, 'review_value_reading') : null;
    if (!action || action.proposalId !== body.proposalId || action.proposalDigestSha256 !== body.proposalDigestSha256
      || !action.dispositions.includes(body.disposition)) {
      return NextResponse.json({ error: 'Suggestion review is no longer offered', code: 'action_not_offered' }, { status: 409 });
    }
    const result = await recordValueReadingReview(admin as unknown as ValueReadingClient, {
      organizationId: ctx.actor.organizationId, reviewerActorId: ctx.actor.actorId,
      proposalId: action.proposalId, proposalDigestSha256: action.proposalDigestSha256,
      disposition: body.disposition, rationale: body.rationale.trim(), idempotencyKey: body.idempotencyKey,
    });
    if (result.status !== 'recorded') {
      return NextResponse.json({ error: 'Suggestion review was refused', code: 'review_refused' }, { status: 409 });
    }
    return NextResponse.json(result, { status: result.inserted ? 201 : 200 });
  } catch {
    return NextResponse.json({ error: 'Suggestion review unavailable' }, { status: 503 });
  }
}
