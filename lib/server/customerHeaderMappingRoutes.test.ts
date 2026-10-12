import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as approve } from '@/app/api/customer-header-mappings/approve/route';
import { POST as activate } from '@/app/api/customer-header-mappings/[id]/activate/route';
import { POST as withdraw } from '@/app/api/customer-header-mappings/[id]/withdraw/route';
import { GET as history } from '@/app/api/customer-header-mappings/route';
import { getActorContext } from './getActorContext';
import { approveCustomerHeaderMapping, transitionCustomerHeaderMapping, readCustomerHeaderMappingHistory } from './customerHeaderMappingLifecycle';
vi.mock('./getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('./customerHeaderMappingLifecycle', () => ({ approveCustomerHeaderMapping: vi.fn(), transitionCustomerHeaderMapping: vi.fn(), readCustomerHeaderMappingHistory: vi.fn() }));
const actor = { actorId: '00000000-0000-4000-8000-000000000009', organizationId: '00000000-0000-4000-8000-000000000001', role: 'admin', email: null, displayName: null };
const params = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000020' }) };
const request = () => new Request('http://localhost/api/customer-header-mappings', { method: 'POST', body: JSON.stringify({ digest: 'a'.repeat(64) }) });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getActorContext).mockResolvedValue({ ok: true, actor }); });
describe('customer mapping lifecycle HTTP authority boundary', () => {
  it('requires authentication for every lifecycle action and history read', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    for (const response of [await approve(request()), await activate(request(), params), await withdraw(request(), params), await history(request())]) expect(response.status).toBe(401);
    expect(approveCustomerHeaderMapping).not.toHaveBeenCalled(); expect(transitionCustomerHeaderMapping).not.toHaveBeenCalled(); expect(readCustomerHeaderMappingHistory).not.toHaveBeenCalled();
  });
  it('forwards authenticated actor and distinct activation/withdrawal actions', async () => {
    vi.mocked(transitionCustomerHeaderMapping).mockResolvedValue({ status: 'activated', revisionId: 'r', digest: 'a'.repeat(64), eventId: 'e', occurredAt: '2026-10-12T00:00:00Z' });
    expect((await activate(request(), params)).status).toBe(200);
    expect((await withdraw(request(), params)).status).toBe(200);
    expect(vi.mocked(transitionCustomerHeaderMapping).mock.calls.map(call => [call[0], call[2]])).toEqual([[actor, 'activate'], [actor, 'withdraw']]);
  });
  it('returns lifecycle conflicts without treating them as successful approval', async () => {
    vi.mocked(approveCustomerHeaderMapping).mockResolvedValue({ status: 'rejected', httpStatus: 409, reason: 'binding_mismatch' });
    expect((await approve(request())).status).toBe(409);
    expect(approveCustomerHeaderMapping).toHaveBeenCalledWith(actor, { digest: 'a'.repeat(64) });
  });
});
