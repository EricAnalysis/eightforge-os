import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/server/intelligencePersistence', () => ({
  generateAndPersistCanonicalIntelligence: vi.fn(),
}));
vi.mock('@/lib/server/ruleEngine', () => ({
  loadFactsWithDerived: vi.fn(), loadRules: vi.fn(), evaluateRule: vi.fn(),
}));
vi.mock('@/lib/server/decisionEngine', () => ({ createDecisionsFromRules: vi.fn() }));
vi.mock('@/lib/server/workflowEngine', () => ({ createTasksFromDecisions: vi.fn() }));
vi.mock('@/lib/server/activity/logActivityEvent', () => ({ logActivityEvent: vi.fn() }));

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { generateAndPersistCanonicalIntelligence } from '@/lib/server/intelligencePersistence';
import { POST } from '@/app/api/documents/[id]/evaluate/route';

const DOCUMENT = {
  id: 'doc-1', organization_id: 'org-1', domain: 'contracts',
  document_type: 'contract', processing_status: 'extracted',
};

function adminStub() {
  const from = vi.fn(() => {
    const query = {
      select: () => query,
      eq: () => query,
      update: () => query,
      single: async () => ({ data: DOCUMENT, error: null }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: null, error: null }),
    };
    return query;
  });
  return { from };
}

function call() {
  return POST(new Request('http://localhost/api/documents/doc-1/evaluate', { method: 'POST' }) as never,
    { params: Promise.resolve({ id: 'doc-1' }) });
}

describe('POST /api/documents/[id]/evaluate actor gate', () => {
  let admin: ReturnType<typeof adminStub>;
  beforeEach(() => {
    vi.clearAllMocks();
    admin = adminStub();
    vi.mocked(getSupabaseAdmin).mockReturnValue(admin as never);
    vi.mocked(generateAndPersistCanonicalIntelligence).mockResolvedValue({
      handled: true, family: 'contract', intelligence: { decisions: [] },
      decisions_created: 0, decisions_updated: 0, decisions_preserved: 0,
      tasks_created: 0, tasks_updated: 0, tasks_preserved: 0,
    } as never);
  });

  it('rejects an unresolved actor before any document read or provider-capable evaluation', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    const response = await call();
    expect(response.status).toBe(401);
    expect(admin.from).not.toHaveBeenCalled();
    expect(generateAndPersistCanonicalIntelligence).not.toHaveBeenCalled();
  });

  it('hides a document from another organization and evaluates nothing', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: true, actor: {
      actorId: 'user-2', organizationId: 'org-2', displayName: null, role: null, email: null,
    } });
    const response = await call();
    expect(response.status).toBe(404);
    expect(generateAndPersistCanonicalIntelligence).not.toHaveBeenCalled();
  });

  it('still evaluates for an actor in the owning organization', async () => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: true, actor: {
      actorId: 'user-1', organizationId: 'org-1', displayName: null, role: null, email: null,
    } });
    const response = await call();
    expect(response.status).toBe(200);
    expect(generateAndPersistCanonicalIntelligence).toHaveBeenCalledOnce();
  });
});
