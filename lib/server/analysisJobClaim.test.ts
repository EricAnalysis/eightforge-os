import { afterEach, describe, expect, it, vi } from 'vitest';

function claimAdmin(rows: unknown[] | null, error: { message: string } | null = null) {
  const calls: { update?: unknown; eq: [string, unknown][] } = { eq: [] };
  const chain = {
    update: vi.fn((values: unknown) => { calls.update = values; return chain; }),
    eq: vi.fn((column: string, value: unknown) => { calls.eq.push([column, value]); return chain; }),
    select: vi.fn(async () => ({ data: rows, error })),
  };
  return { admin: { from: vi.fn(() => chain) }, calls };
}

describe('claimQueuedJob', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('claims only a job that is still queued, in one conditional update', async () => {
    const { admin, calls } = claimAdmin([{ id: 'job-1' }]);
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => admin }));
    const { claimQueuedJob } = await import('@/lib/server/analysisJobService');

    await expect(claimQueuedJob({ jobId: 'job-1', attemptCount: 2, startedAt: '2026-10-10T00:00:00Z' }))
      .resolves.toBe(true);
    expect(calls.update).toEqual({ status: 'running', started_at: '2026-10-10T00:00:00Z', attempt_count: 3 });
    expect(calls.eq).toEqual([['id', 'job-1'], ['status', 'queued']]);
  });

  it('reports a lost race when no queued row was updated', async () => {
    const { admin } = claimAdmin([]);
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => admin }));
    const { claimQueuedJob } = await import('@/lib/server/analysisJobService');

    await expect(claimQueuedJob({ jobId: 'job-1', attemptCount: 0, startedAt: 'now' })).resolves.toBe(false);
  });

  it('fails loudly when the claim itself errors', async () => {
    const { admin } = claimAdmin(null, { message: 'connection reset' });
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => admin }));
    const { claimQueuedJob } = await import('@/lib/server/analysisJobService');

    await expect(claimQueuedJob({ jobId: 'job-1', attemptCount: 0, startedAt: 'now' }))
      .rejects.toThrow('job claim failed: connection reset');
  });
});

// The route's first import loads the full extraction module graph.
describe('job processing route claim', { timeout: 30_000 }, () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  async function postWithClaim(claim: () => Promise<boolean>) {
    const download = vi.fn();
    const documentChain = {
      eq: vi.fn(),
      single: vi.fn(async () => ({
        data: { id: 'document-1', storage_path: 'org-1/a.pdf', organization_id: 'org-1', project_id: null },
        error: null,
      })),
    };
    documentChain.eq.mockReturnValue(documentChain);
    const admin = {
      from: vi.fn(() => ({ select: vi.fn(() => documentChain) })),
      storage: { from: vi.fn(() => ({ download })) },
    };
    const updateJobStatus = vi.fn(async () => undefined);
    const setDocumentStatus = vi.fn(async () => undefined);
    vi.doMock('@/lib/server/getActorContext', () => ({
      getActorContext: vi.fn(async () => ({ ok: true, actor: { organizationId: 'org-1' } })),
    }));
    vi.doMock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn(() => admin) }));
    vi.doMock('@/lib/server/analysisJobService', () => ({
      getJob: vi.fn(async () => ({
        id: 'job-1', document_id: 'document-1', organization_id: 'org-1',
        status: 'queued', analysis_mode: 'deterministic', attempt_count: 0,
      })),
      claimQueuedJob: vi.fn(claim),
      updateJobStatus,
      setDocumentStatus,
    }));
    const { POST } = await import('@/app/api/jobs/process/[jobId]/route');
    const response = await POST(
      new Request('http://localhost/api/jobs/process/job-1', { method: 'POST' }),
      { params: Promise.resolve({ jobId: 'job-1' }) },
    );
    return { response, download, updateJobStatus, setDocumentStatus };
  }

  it('does not process or touch a job another dispatch claimed first', async () => {
    const { response, download, updateJobStatus, setDocumentStatus } = await postWithClaim(async () => false);

    expect(response.status).toBe(409);
    expect(download).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(setDocumentStatus).not.toHaveBeenCalled();
  });

  it('never marks a job failed when its claim outcome is unknown', async () => {
    const { response, download, updateJobStatus, setDocumentStatus } = await postWithClaim(async () => {
      throw new Error('job claim failed: timeout');
    });

    expect(response.status).toBe(503);
    expect(download).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
    expect(setDocumentStatus).not.toHaveBeenCalled();
  });
});
