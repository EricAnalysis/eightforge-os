import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

async function post(rows: unknown[] | null, error: { message: string } | null = null) {
  const calls: { update?: Record<string, unknown>; filters: [string, string, unknown][] } = { filters: [] };
  const chain = {
    update: vi.fn((values: Record<string, unknown>) => { calls.update = values; return chain; }),
    eq: vi.fn((column: string, value: unknown) => { calls.filters.push(['eq', column, value]); return chain; }),
    lt: vi.fn((column: string, value: unknown) => { calls.filters.push(['lt', column, value]); return chain; }),
    select: vi.fn(async () => ({ data: rows, error })),
  };
  const admin = { from: vi.fn(() => chain), rpc: vi.fn() };
  vi.doMock('@/lib/server/getActorContext', () => ({
    getActorContext: vi.fn(async () => ({ ok: true, actor: { organizationId: 'org-1' } })),
  }));
  vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn(() => admin) }));
  const { POST } = await import('@/app/api/admin/reset-stuck-documents/route');
  const response = await POST(new Request('http://localhost/api/admin/reset-stuck-documents', { method: 'POST' }));
  return { response, calls, admin };
}

describe('reset stuck documents', () => {
  it("resets only the caller's organization's documents stuck in processing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const { response, calls, admin } = await post([{ id: 'doc-1' }, { id: 'doc-2' }]);
    vi.useRealTimers();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, reset: 2 });
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(calls.filters).toEqual([
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'processing_status', 'processing'],
      ['lt', 'updated_at', '2026-10-10T11:45:00.000Z'],
    ]);
    expect(calls.update).toMatchObject({ processing_status: 'failed' });
  });

  it('reports a database error without claiming a reset', async () => {
    const { response } = await post(null, { message: 'permission denied' });
    expect(response.status).toBe(500);
  });
});
