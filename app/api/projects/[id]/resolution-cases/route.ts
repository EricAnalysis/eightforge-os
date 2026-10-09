import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { readResolutionQueue } from '@/lib/server/resolutionQueueRead';

/**
 * The project's resolution queue (Forgewing resolution layer B5-A). Read-only.
 * Every case and every action is derived on the server; the client can only
 * act on what is listed here, through the write paths each action names.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });

  const result = await readResolutionQueue({ organizationId: ctx.actor.organizationId, projectId });
  switch (result.status) {
    case 'ok':
      return NextResponse.json(result.queue);
    case 'not_found':
      return NextResponse.json({ error: 'Project not found' }, { status: 404 });
    case 'not_configured':
      return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
    default:
      return NextResponse.json({ error: 'Resolution queue could not be read', code: result.reason }, { status: 500 });
  }
}
