import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));

import { GET } from '@/app/api/documents/[id]/file/route';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function request(query = '') {
  return new Request(`http://localhost/api/documents/doc-1/file${query}`) as never;
}

describe('GET /api/documents/[id]/file', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 401 without an authenticated actor even when orgId is supplied', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const response = await GET(request('?orgId=attacker-org'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });
    expect(response.status).toBe(401);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it('scopes the document lookup to the authenticated organization', async () => {
    vi.mocked(getActorContext).mockResolvedValue({
      ok: true,
      actor: { actorId: 'user-1', organizationId: 'session-org', displayName: null,
        role: null, email: null },
    });
    const eq = vi.fn();
    const query = {
      select: vi.fn(), eq,
      maybeSingle: vi.fn().mockResolvedValue({
        data: { storage_path: 'session-org/source.pdf', name: 'source.pdf' }, error: null,
      }),
    };
    query.select.mockReturnValue(query);
    eq.mockReturnValue(query);
    const createSignedUrl = vi.fn().mockResolvedValue({
      data: { signedUrl: 'https://signed.example/source.pdf' }, error: null,
    });
    vi.mocked(getSupabaseAdmin).mockReturnValue({
      from: vi.fn().mockReturnValue(query),
      storage: { from: vi.fn().mockReturnValue({ createSignedUrl }) },
    } as never);

    const response = await GET(request('?orgId=attacker-org'), {
      params: Promise.resolve({ id: 'doc-1' }),
    });
    expect(response.status).toBe(200);
    expect(eq).toHaveBeenCalledWith('organization_id', 'session-org');
    expect(eq).not.toHaveBeenCalledWith('organization_id', 'attacker-org');
  });
});
