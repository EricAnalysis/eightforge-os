import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

type Filter = [string, string, unknown];

function chain(result: { data: unknown; error: { message: string } | null }) {
  const calls: { update?: Record<string, unknown>; filters: Filter[]; select?: string } = { filters: [] };
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: vi.fn((columns: string) => { calls.select = columns; return builder; }),
    update: vi.fn((values: Record<string, unknown>) => { calls.update = values; return builder; }),
    eq: vi.fn((column: string, value: unknown) => { calls.filters.push(['eq', column, value]); return builder; }),
    is: vi.fn((column: string, value: unknown) => { calls.filters.push(['is', column, value]); return builder; }),
    in: vi.fn((column: string, value: unknown) => { calls.filters.push(['in', column, value]); return builder; }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
  });
  return { builder, calls };
}

async function post(tables: {
  documents: unknown[];
  jobs: unknown[];
  updated?: unknown[];
  updateError?: { message: string } | null;
}) {
  const reads = chain({ data: tables.documents, error: null });
  const jobs = chain({ data: tables.jobs, error: null });
  const write = chain({ data: tables.updated ?? [], error: tables.updateError ?? null });
  let documentCalls = 0;
  const admin = {
    from: vi.fn((table: string) => {
      if (table === 'document_analysis_jobs') return jobs.builder;
      documentCalls += 1;
      return documentCalls === 1 ? reads.builder : write.builder;
    }),
    rpc: vi.fn(),
  };
  vi.doMock('@/lib/server/getActorContext', () => ({
    getActorContext: vi.fn(async () => ({ ok: true, actor: { organizationId: 'org-1' } })),
  }));
  vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn(() => admin) }));
  const { POST } = await import('@/app/api/admin/reset-stuck-documents/route');
  const response = await POST(new Request('http://localhost/api/admin/reset-stuck-documents', { method: 'POST' }));
  return { response, reads: reads.calls, jobs: jobs.calls, write: write.calls, admin };
}

describe('reset stuck documents', () => {
  it("resets only the caller's live documents whose latest job started over 15 minutes ago", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const { response, reads, jobs, write, admin } = await post({
      documents: [
        { id: 'stuck', created_at: '2026-10-01T00:00:00Z' },
        { id: 'recent', created_at: '2026-10-01T00:00:00Z' },
        { id: 'no-job-old', created_at: '2026-10-10T11:00:00Z' },
      ],
      jobs: [
        { document_id: 'stuck', started_at: '2026-10-10T11:30:00Z', created_at: '2026-10-10T11:30:00Z' },
        { document_id: 'recent', started_at: '2026-10-10T10:00:00Z', created_at: '2026-10-10T10:00:00Z' },
        { document_id: 'recent', started_at: '2026-10-10T11:55:00Z', created_at: '2026-10-10T11:55:00Z' },
      ],
      updated: [{ id: 'stuck' }, { id: 'no-job-old' }],
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, reset: 2 });
    expect(admin.rpc).not.toHaveBeenCalled();
    expect(reads.filters).toEqual([
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'processing_status', 'processing'],
      ['is', 'deleted_at', null],
    ]);
    expect(jobs.filters).toEqual([
      ['eq', 'organization_id', 'org-1'],
      ['in', 'document_id', ['stuck', 'recent', 'no-job-old']],
    ]);
    // 'recent' has a job started 5 minutes ago, so it is not stuck even though an older job exists.
    expect(write.filters).toEqual([
      ['eq', 'organization_id', 'org-1'],
      ['eq', 'processing_status', 'processing'],
      ['in', 'id', ['stuck', 'no-job-old']],
    ]);
    // documents has no updated_at column: never written.
    expect(write.update).toEqual({ processing_status: 'failed', processing_error: expect.any(String) });
  });

  it('writes nothing when no document is stuck', async () => {
    const { response, write } = await post({ documents: [], jobs: [] });
    await expect(response.json()).resolves.toEqual({ ok: true, reset: 0 });
    expect(write.update).toBeUndefined();
  });

  it('reports a database error without claiming a reset', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
    const { response } = await post({
      documents: [{ id: 'stuck', created_at: '2026-10-01T00:00:00Z' }], jobs: [],
      updateError: { message: 'permission denied' },
    });
    expect(response.status).toBe(500);
  });
});
