import { NextRequest, NextResponse } from 'next/server';

import { parseResolutionPreviewInput } from '@/lib/resolution/resolutionPreviewInput';
import { getActorContext } from '@/lib/server/getActorContext';
import { previewResolutionImpact } from '@/lib/server/resolutionImpactPreview';

/**
 * The deterministic impact of one candidate resolution action (Forgewing
 * resolution layer B5-C). Read-only: it validates the project in memory with
 * and without the action and returns the difference. POST only because the
 * candidate decision is in the body; nothing is recorded. The body carries a
 * case id and the operator's decision, never an impact.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const body = await req.json().catch(() => null) as { caseId?: unknown; input?: unknown } | null;
  const caseId = typeof body?.caseId === 'string' && body.caseId.length <= 1000 ? body.caseId : null;
  const input = parseResolutionPreviewInput(body?.input);
  if (!caseId || !input) return NextResponse.json({ error: 'caseId and a valid input are required' }, { status: 400 });

  const result = await previewResolutionImpact({
    organizationId: ctx.actor.organizationId,
    actorId: ctx.actor.actorId,
    projectId,
    caseId,
    input,
  });
  if (result.status === 'ok') return NextResponse.json(result.impact);
  return result.status === 'not_found'
    ? NextResponse.json({ error: 'Project not found' }, { status: 404 })
    : NextResponse.json({ error: 'Impact could not be computed' }, { status: 500 });
}
