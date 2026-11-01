import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getActorContextMock, getSupabaseAdminMock, readSourcesMock, accessMock, eqMock } = vi.hoisted(() => ({
  getActorContextMock: vi.fn(),
  getSupabaseAdminMock: vi.fn(),
  readSourcesMock: vi.fn(),
  accessMock: vi.fn(),
  eqMock: vi.fn(),
}));

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: getActorContextMock }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getSupabaseAdminMock }));
vi.mock('@/lib/server/projectIntelligenceRead', () => ({ readProjectIntelligenceSources: readSourcesMock }));
vi.mock('@/lib/server/workflowPlatformReviewAccess', () => ({ resolveWorkflowPlatformReviewAccess: accessMock }));

import { GET } from '@/app/api/internal/project-intelligence/signals/route';

const request = (query = '?projectId=project-1') => new Request(`http://localhost/api/internal/project-intelligence/signals${query}`);

const SOURCES = {
  project: { id: 'project-1', name: 'Goodlettsville', validationStatus: 'BLOCKED' },
  findings: {
    latestRunAt: '2026-10-01T00:00:00.000Z',
    open: [{
      id: 'finding-1', severity: 'critical', category: 'required_sources', description: 'Goodlettsville has no contract', blocksProject: true,
      lastRun: 'x', timestamp: 'x', ruleId: 'SOURCES_NO_CONTRACT',
    }],
  },
  documents: [],
  precedence: { families: [], relationships: [] },
  facts: [],
};

beforeEach(() => {
  getActorContextMock.mockResolvedValue({ ok: true, actor: { actorId: 'user-1', organizationId: 'org-1', role: 'admin' } });
  accessMock.mockReturnValue({ allowed: true });
  eqMock.mockReset();
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((column: string, value: unknown) => { eqMock(column, value); return query; }),
    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 'project-1', name: 'Goodlettsville', validation_status: 'BLOCKED', validation_summary_json: null }, error: null }),
  };
  getSupabaseAdminMock.mockReturnValue({ from: vi.fn(() => query) });
  readSourcesMock.mockResolvedValue({ status: 'ok', sources: SOURCES });
});

afterEach(() => {
  for (const mock of [getActorContextMock, getSupabaseAdminMock, readSourcesMock, accessMock]) mock.mockReset();
});

describe('GET /api/internal/project-intelligence/signals', () => {
  it('refuses anyone outside the platform-review allowlist, an org admin included, before reading anything', async () => {
    accessMock.mockReturnValue({ allowed: false, reason: 'not_allowlisted' });
    const response = await GET(request());
    expect(response.status).toBe(403);
    expect(getSupabaseAdminMock).not.toHaveBeenCalled();
    expect(readSourcesMock).not.toHaveBeenCalled();
  });

  it('reads the project through the reviewer\'s own organization', async () => {
    await GET(request());
    expect(eqMock).toHaveBeenCalledWith('organization_id', 'org-1');
    expect(eqMock).toHaveBeenCalledWith('id', 'project-1');
  });

  it('returns codes and references only: no project, title or finding text', async () => {
    const body = await (await GET(request())).json();
    expect(body.signals).toEqual([expect.objectContaining({ category: 'missing_source', code: 'source_absent_from_project', ruleId: 'SOURCES_NO_CONTRACT' })]);
    expect(JSON.stringify(body)).not.toContain('Goodlettsville');
    expect(JSON.stringify(body)).not.toContain('project-1');
  });

  it('needs a project', async () => {
    expect((await GET(request(''))).status).toBe(400);
  });
});
