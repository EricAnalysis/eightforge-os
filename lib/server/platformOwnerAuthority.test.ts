import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isWorkflowPlatformReviewer,
  resolveWorkflowPlatformReviewAccess,
} from '@/lib/server/workflowPlatformReviewAccess';

describe('platform authority: one platform-owner identity', () => {
  it('allows exactly the platform owner', () => {
    expect(resolveWorkflowPlatformReviewAccess({ email: null, role: 'viewer', platformOwner: true }))
      .toEqual({ allowed: true, basis: 'platform_owner' });
  });

  it.each([
    ['an organization owner', { email: 'a@example.test', role: 'owner' }],
    ['an organization admin', { email: 'a@example.test', role: 'admin' }],
    ['a regular member', { email: 'a@example.test', role: 'member' }],
    ['platformOwner false', { email: 'a@example.test', role: 'admin', platformOwner: false }],
    ['platformOwner null', { email: 'a@example.test', role: 'admin', platformOwner: null }],
    ['a truthy non-boolean flag', { email: 'a@example.test', role: 'admin', platformOwner: 'true' as unknown as boolean }],
  ])('refuses %s', (_label, reviewer) => {
    expect(resolveWorkflowPlatformReviewAccess(reviewer)).toEqual({ allowed: false, reason: 'not_platform_owner' });
    expect(isWorkflowPlatformReviewer(reviewer)).toBe(false);
  });

  it('refuses a missing identity', () => {
    expect(resolveWorkflowPlatformReviewAccess(null)).toEqual({ allowed: false, reason: 'identity_missing' });
    expect(resolveWorkflowPlatformReviewAccess(undefined)).toEqual({ allowed: false, reason: 'identity_missing' });
  });

  it('ignores the retired environment allowlists entirely', () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'a@example.test');
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', 'admin,owner');
    try {
      expect(resolveWorkflowPlatformReviewAccess({ email: 'a@example.test', role: 'admin' }).allowed).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('resolvePlatformOwner (server-side lookup)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  async function lookup(reply: () => Promise<{ data: unknown; error: { message: string; code?: string } | null }>) {
    const { resolvePlatformOwner } = await import('@/lib/server/getActorContext');
    const rpc = vi.fn(reply);
    return { result: await resolvePlatformOwner({ rpc }, 'user-1'), rpc };
  }

  it('asks the ledger for the verified user id and accepts only exactly true', async () => {
    const { result, rpc } = await lookup(async () => ({ data: true, error: null }));
    expect(result).toBe(true);
    expect(rpc).toHaveBeenCalledWith('is_platform_owner', { p_user_id: 'user-1' });
  });

  it.each([
    ['false', async () => ({ data: false, error: null })],
    ['null', async () => ({ data: null, error: null })],
    ['a string', async () => ({ data: 'true', error: null })],
    ['an RPC error (e.g. migration not applied)', async () => ({ data: null, error: { message: 'Could not find the function', code: 'PGRST202' } })],
    ['a thrown network error', async () => { throw new Error('fetch failed'); }],
  ])('fails closed on %s', async (_label, reply) => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = await lookup(reply as never);
    expect(result).toBe(false);
  });
});

describe('getActorContext carries platformOwner without risking sign-in', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function actorWith(ownerReply: () => Promise<unknown>) {
    vi.resetModules();
    vi.stubEnv('SUPABASE_URL', 'https://example.invalid');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'anon');
    vi.doMock('@supabase/supabase-js', () => ({ createClient: () => ({
      auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'u@example.test' } }, error: null }) },
    }) }));
    const profileQuery = {
      select: () => profileQuery,
      eq: () => profileQuery,
      single: async () => ({ data: { organization_id: 'org-1', display_name: 'U', role: 'admin' }, error: null }),
    };
    const rpc = vi.fn(ownerReply);
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => ({ from: () => profileQuery, rpc }) }));
    const { getActorContext } = await import('@/lib/server/getActorContext');
    const result = await getActorContext(new Request('http://localhost/x', { headers: { Authorization: 'Bearer t' } }));
    return { result, rpc };
  }

  it('marks the granted account as platform owner', async () => {
    const { result, rpc } = await actorWith(async () => ({ data: true, error: null }));
    expect(result).toEqual({ ok: true, actor: {
      actorId: 'user-1', organizationId: 'org-1', displayName: 'U', role: 'admin', email: 'u@example.test', platformOwner: true,
    } });
    expect(rpc).toHaveBeenCalledWith('is_platform_owner', { p_user_id: 'user-1' });
  });

  it('an organization admin without a grant is not the platform owner', async () => {
    const { result } = await actorWith(async () => ({ data: false, error: null }));
    expect(result.ok && result.actor.platformOwner).toBe(false);
  });

  it('a failed owner lookup never fails authentication', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { result } = await actorWith(async () => { throw new Error('ledger unavailable'); });
    expect(result.ok).toBe(true);
    expect(result.ok && result.actor.platformOwner).toBe(false);
  });

  it('a request without a session never reaches the ledger', async () => {
    const { getActorContext } = await import('@/lib/server/getActorContext');
    expect(await getActorContext(new Request('http://localhost/x'))).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
  });
});
