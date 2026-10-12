import { getActorContext } from '@/lib/server/getActorContext';
import { transitionCustomerHeaderMapping } from '@/lib/server/customerHeaderMappingLifecycle';

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ error: actor.error }, { status: actor.status });
  const result = await transitionCustomerHeaderMapping(actor.actor, (await params).id, 'withdraw', await request.json().catch(() => null));
  return Response.json(result, { status: result.status === 'rejected' ? result.httpStatus : 200 });
}
