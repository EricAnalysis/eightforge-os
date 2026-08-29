import { afterEach, describe, expect, it, vi } from 'vitest';

const cleanupReasoningShadowArtifacts = vi.hoisted(() => vi.fn<() => Promise<{
  status: 'completed' | 'failed';
  scanned: number;
  deleted: number;
  failedBatches: number;
  truncated: boolean;
  warningCodes: string[];
}>>(async () => ({
  status: 'completed',
  scanned: 2,
  deleted: 1,
  failedBatches: 0,
  truncated: false,
  warningCodes: [],
})));

vi.mock('@/lib/extraction/persistence/forgewingShadowCleanup', () => ({
  cleanupReasoningShadowArtifacts,
}));

import { GET } from '@/app/api/internal/forgewing-shadow-cleanup/route';

function request(authorization?: string): Request {
  return new Request('https://example.test/api/internal/forgewing-shadow-cleanup', {
    headers: authorization ? { authorization } : {},
  });
}

describe('reasoning shadow cleanup route', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    cleanupReasoningShadowArtifacts.mockClear();
  });

  it('is unavailable when the server secret is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '');
    expect((await GET(request())).status).toBe(503);
    expect(cleanupReasoningShadowArtifacts).not.toHaveBeenCalled();
  });

  it('rejects missing and incorrect bearer authorization', async () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret');
    expect((await GET(request())).status).toBe(401);
    expect((await GET(request('Bearer wrong-secret'))).status).toBe(401);
    expect(cleanupReasoningShadowArtifacts).not.toHaveBeenCalled();
  });

  it('runs cleanup for the exact bearer secret', async () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret');
    const response = await GET(request('Bearer correct-secret'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, status: 'completed' });
    expect(cleanupReasoningShadowArtifacts).toHaveBeenCalledOnce();
  });

  it('reports contained cleanup failure without exposing a secret', async () => {
    vi.stubEnv('CRON_SECRET', 'correct-secret');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    cleanupReasoningShadowArtifacts.mockResolvedValueOnce({
      status: 'failed', scanned: 0, deleted: 0, failedBatches: 0, truncated: false,
      warningCodes: ['forgewing_shadow_cleanup_list_failed'],
    });
    const response = await GET(request('Bearer correct-secret'));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('correct-secret');
  });
});
