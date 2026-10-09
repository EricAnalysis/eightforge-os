import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ user: vi.fn(), document: vi.fn(), job: vi.fn() }));
function query(single: () => unknown) {
  const chain = { select: () => chain, eq: () => chain, single };
  return chain;
}
vi.mock('@supabase/supabase-js', () => ({ createClient: () => ({
  auth: { getUser: mocks.user },
  from: (table: string) => query(table === 'documents' ? mocks.document
    : async () => ({ data: { analysis_mode: 'deterministic' }, error: null })),
}) }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => ({
  from: () => query(async () => ({ data: { organization_id: 'org' }, error: null })),
}) }));
vi.mock('@/lib/server/analysisJobService', () => ({ createAnalysisJob: mocks.job }));
import { POST } from '@/app/api/documents/[id]/analyze/route';

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('SUPABASE_URL', 'https://example.invalid');
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'test-anon');
  mocks.user.mockResolvedValue({ data: { user: { id: 'actor' } }, error: null });
  mocks.document.mockResolvedValue({ data: { id: 'document' }, error: null });
  mocks.job.mockResolvedValue({ id: 'job' });
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('authenticated analysis dispatch', () => {
  it('forwards the validated caller credential to the authenticated processor', async () => {
    const dispatch = vi.fn().mockResolvedValue(Response.json({ success: true, extraction: { id: 'extraction' } }));
    vi.stubGlobal('fetch', dispatch);
    const response = await POST(new Request('https://example.invalid/analyze', {
      method: 'POST', headers: { Authorization: 'Bearer test-caller-token' },
    }), { params: Promise.resolve({ id: 'document' }) });
    expect(response.status).toBe(200);
    expect(mocks.job).toHaveBeenCalledWith({ documentId: 'document', organizationId: 'org', analysisMode: 'deterministic', triggeredBy: 'manual' });
    expect(dispatch).toHaveBeenCalledWith(expect.stringContaining('/api/jobs/process/job'), {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-caller-token' },
    });
  });

  it.each(['missing', 'invalid', 'inaccessible'])('does not create or dispatch a job for %s access', async (mode) => {
    const dispatch = vi.fn();
    vi.stubGlobal('fetch', dispatch);
    if (mode === 'invalid') mocks.user.mockResolvedValue({ data: { user: null }, error: { message: 'invalid' } });
    if (mode === 'inaccessible') mocks.document.mockResolvedValue({ data: null, error: { message: 'not found' } });
    const response = await POST(new Request('https://example.invalid/analyze', {
      method: 'POST', headers: mode === 'missing' ? {} : { Authorization: 'Bearer test-caller-token' },
    }), { params: Promise.resolve({ id: 'document' }) });
    expect(response.status).toBe(mode === 'inaccessible' ? 404 : 401);
    expect(mocks.job).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
