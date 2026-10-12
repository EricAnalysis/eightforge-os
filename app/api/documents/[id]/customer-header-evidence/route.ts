import { getActorContext } from '@/lib/server/getActorContext';
import { readCustomerHeaderEvidence } from '@/lib/server/customerHeaderEvidenceRead';
import { z } from 'zod';

/** Read-only prerequisite surface. No approval/activation or mapping writes. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ error: actor.error }, { status: actor.status });
  const { id: documentId } = await params;
  const rawIndex = new URL(request.url).searchParams.get('headerIndex');
  if (!z.string().uuid().safeParse(documentId).success || rawIndex === null || !/^\d+$/.test(rawIndex)
    || !Number.isSafeInteger(Number(rawIndex))) return Response.json({ error: 'invalid_header_target' }, { status: 400 });
  const result = await readCustomerHeaderEvidence({ organizationId: actor.actor.organizationId,
    documentId, headerIndex: Number(rawIndex) });
  return Response.json(result, { status: result.status === 'verified' ? 200
    : result.status === 'not_found' ? 404 : result.status === 'rejected' ? 409 : 503 });
}
