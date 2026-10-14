import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { readProposalForLink, recordRelationshipProposalReview } from '@/lib/server/relationshipProposals';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Reject or defer a relationship proposal (P3.2). Writes only the review
 * record; no relationship is created or removed. Acceptance is not offered
 * here: a proposal is accepted only by linking it through the
 * document-precedence `link_relationship` action.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; proposalId: string }> }) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id: projectId, proposalId } = await params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const disposition = body?.disposition;
  const reason = typeof body?.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 2000) : null;
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'disposition' && key !== 'reason')
    || (disposition !== 'rejected' && disposition !== 'deferred')) {
    return NextResponse.json({ error: 'disposition must be rejected or deferred' }, { status: 400 });
  }
  if (disposition === 'rejected' && !reason) {
    return NextResponse.json({ error: 'A reason is required to reject a proposal' }, { status: 400 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  try {
    const proposal = await readProposalForLink(admin, { organizationId: ctx.actor.organizationId, projectId, proposalId });
    if (!proposal) return NextResponse.json({ error: 'Proposal not found' }, { status: 404 });
    const result = await recordRelationshipProposalReview(admin, {
      organizationId: ctx.actor.organizationId, proposalId, disposition, relationshipId: null, reason,
      reviewerActorId: ctx.actor.actorId,
    });
    if (result.status === 'recorded') return NextResponse.json({ status: 'recorded', reviewId: result.reviewId });
    if (result.status === 'already_decided') return NextResponse.json({ error: 'This proposal is already decided' }, { status: 409 });
    return NextResponse.json({ error: 'Review rejected' }, { status: 422 });
  } catch {
    return NextResponse.json({ error: 'Relationship proposals unavailable' }, { status: 503 });
  }
}
