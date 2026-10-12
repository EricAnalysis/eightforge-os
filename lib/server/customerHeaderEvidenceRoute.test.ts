import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from '@/app/api/documents/[id]/customer-header-evidence/route';
import { getActorContext } from '@/lib/server/getActorContext';
import { readCustomerHeaderEvidence } from '@/lib/server/customerHeaderEvidenceRead';
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('@/lib/server/customerHeaderEvidenceRead', () => ({ readCustomerHeaderEvidence: vi.fn() }));
const documentId = '00000000-0000-4000-8000-000000000003';
const organizationId = '00000000-0000-4000-8000-000000000001';
const request = (query = '?headerIndex=0') => new Request(`http://localhost/api/documents/${documentId}/customer-header-evidence${query}`);
const params = { params: Promise.resolve({ id: documentId }) };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getActorContext).mockResolvedValue({ ok: true, actor: { actorId: documentId,
    organizationId, displayName: null, email: null, role: 'member' } });
});
describe('customer header evidence GET', () => {
  it('rejects unauthenticated reads before accessing evidence', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await GET(request(), params)).status).toBe(401);
    expect(readCustomerHeaderEvidence).not.toHaveBeenCalled();
  });
  it.each(['', '?headerIndex=-1', '?headerIndex=1.1', '?headerIndex=9007199254740992'])('rejects invalid target %s', async query => {
    expect((await GET(request(query), params)).status).toBe(400);
    expect(readCustomerHeaderEvidence).not.toHaveBeenCalled();
  });
  it('takes organization from the authenticated actor and ignores applicant identities', async () => {
    vi.mocked(readCustomerHeaderEvidence).mockResolvedValue({ status: 'verified', sourceSchemaIdentity: 'schema', bindings: [] });
    expect((await GET(request('?headerIndex=2&organizationId=forged&extractionId=forged'), params)).status).toBe(200);
    expect(readCustomerHeaderEvidence).toHaveBeenCalledWith({ organizationId, documentId, headerIndex: 2 });
  });
  it.each([['not_found', 404], ['read_failed', 503], ['unavailable', 503], ['rejected', 409]] as const)('reports %s without successful evidence', async (status, expected) => {
    vi.mocked(readCustomerHeaderEvidence).mockResolvedValue(status === 'rejected'
      ? { status, reason: 'invalid_context' } : { status });
    expect((await GET(request(), params)).status).toBe(expected);
  });
});
