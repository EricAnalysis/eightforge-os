import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createClient: vi.fn(() => ({ rpc: vi.fn() })) }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
import { createForgewingEngineeringWorkerClient } from './forgewingEngineeringWorkerClient';

function token(role: string): string {
  return `${Buffer.from('{}').toString('base64url')}.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
}

describe('Forgewing engineering worker database identity', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('creates a non-persistent client only for the dedicated role token', () => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'public-key');
    vi.stubEnv('FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN', token('forgewing_engineering_worker'));
    expect(createForgewingEngineeringWorkerClient()).not.toBeNull();
    expect(mocks.createClient).toHaveBeenCalledWith('https://example.supabase.co', 'public-key', expect.objectContaining({
      accessToken: expect.any(Function),
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }));
  });

  it.each(['service_role', 'authenticated', 'anon', '', 'malformed'])('rejects %s before client creation', (role) => {
    vi.stubEnv('SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'public-key');
    vi.stubEnv('FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN', role === 'malformed' ? role : token(role));
    mocks.createClient.mockClear();
    expect(createForgewingEngineeringWorkerClient()).toBeNull();
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
});
