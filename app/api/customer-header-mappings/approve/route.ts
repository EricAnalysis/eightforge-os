import { getActorContext } from '@/lib/server/getActorContext';
import { approveCustomerHeaderMapping } from '@/lib/server/customerHeaderMappingLifecycle';

export async function POST(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ error: actor.error }, { status: actor.status });
  const result = await approveCustomerHeaderMapping(actor.actor, await request.json().catch(() => null));
  return Response.json(result, { status: result.status === 'rejected' ? result.httpStatus : 201 });
}
