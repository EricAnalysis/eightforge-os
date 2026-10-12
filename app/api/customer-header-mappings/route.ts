import { getActorContext } from '@/lib/server/getActorContext';
import { readCustomerHeaderMappingHistory } from '@/lib/server/customerHeaderMappingLifecycle';

export async function GET(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ error: actor.error }, { status: actor.status });
  const result = await readCustomerHeaderMappingHistory(actor.actor);
  return Response.json(result, { status: result.status === 'rejected' ? result.httpStatus : 200 });
}
