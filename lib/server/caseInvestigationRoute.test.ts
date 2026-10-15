import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  run: vi.fn(),
  admin: { from: vi.fn() } as unknown,
  record: vi.fn(async () => ({ status: 'recorded', recordId: 'record-1', inserted: true })),
  list: vi.fn(async () => [{ id: 'record-1', diagnosis: 'd' }]),
}));

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: mocks.actor }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => mocks.admin }));
vi.mock('@/lib/server/caseInvestigationRunner', () => ({ runProviderCaseInvestigation: mocks.run }));
vi.mock('@/lib/server/caseInvestigationRecords', () => ({
  recordCaseInvestigation: mocks.record, listCaseInvestigations: mocks.list,
}));

import { GET, POST } from '@/app/api/projects/[id]/resolution-cases/investigation/route';

const call = (body: unknown) => POST(new Request('http://localhost/api/projects/p1/resolution-cases/investigation', {
  method: 'POST', body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: 'p1' }) });

afterEach(() => { vi.unstubAllEnvs(); mocks.run.mockReset(); mocks.actor.mockReset(); });

describe('case investigation route (P3b)', () => {
  it('passes only server-derived identity, and a provider only for a qualified model', async () => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { organizationId: 'org-1', actorId: 'user-1' } });
    mocks.run.mockResolvedValue({ status: 'gated', reason: 'activation_disabled' });
    vi.stubEnv('ANTHROPIC_API_KEY', 'test-key');

    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-4-6');
    const gated = await call({ caseId: 'finding:f1' });
    expect(gated.status).toBe(503);
    expect(await gated.json()).toEqual({ status: 'gated', reason: 'activation_disabled' });
    const [query, deps] = mocks.run.mock.calls.at(-1)!;
    expect(query).toEqual({ organizationId: 'org-1', projectId: 'p1', caseId: 'finding:f1', requestedBy: 'user-1' });
    expect(deps.provider?.providerModel).toBe('claude-sonnet-4-6');
    expect(deps.admin).toBe(mocks.admin);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-5-5');
    await call({ caseId: 'finding:f1' });
    expect(mocks.run.mock.calls.at(-1)![1].provider).toBeNull();
  });

  it('rejects client-supplied evidence, identity or anything but a case id', async () => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { organizationId: 'org-1', actorId: 'user-1' } });
    for (const body of [{}, { caseId: '' }, { caseId: 'x', actorId: 'someone' }, { caseId: 'x', context: [] }]) {
      expect((await call(body)).status).toBe(400);
    }
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('returns the non-authoritative proposal as is, and maps refusals to typed codes', async () => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { organizationId: 'org-1', actorId: 'user-1' } });
    const investigation = { authority: 'non_authoritative', diagnosis: 'd', rankedActionKinds: ['open_document'],
      rationale: 'r', evidenceRefs: [{ sliceKind: 'validator_findings', recordId: 'c' }], promptVersion: 'v',
      providerModel: 'm', requestDigestSha256: 'a'.repeat(64) };
    mocks.run.mockResolvedValueOnce({ status: 'proposed', investigation });
    const ok = await call({ caseId: 'finding:f1' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ status: 'proposed', investigation, recorded: true, recordId: 'record-1' });
    // P3c: kept as immutable evidence history, attributed to the requesting operator.
    expect(mocks.record).toHaveBeenCalledWith(mocks.admin, {
      organizationId: 'org-1', projectId: 'p1', caseId: 'finding:f1', requestedBy: 'user-1', investigation });

    // A recording failure never changes the investigation the operator receives.
    mocks.run.mockResolvedValueOnce({ status: 'proposed', investigation });
    mocks.record.mockResolvedValueOnce({ status: 'not_recorded', reason: 'rpc_error' } as never);
    const unrecorded = await call({ caseId: 'finding:f1' });
    expect(unrecorded.status).toBe(200);
    expect(await unrecorded.json()).toEqual({ status: 'proposed', investigation, recorded: false });

    mocks.run.mockResolvedValueOnce({ status: 'case_kind_not_supported' });
    expect((await call({ caseId: 'withheld:x' })).status).toBe(409);
    mocks.run.mockResolvedValueOnce({ status: 'budget_exhausted' });
    expect((await call({ caseId: 'finding:f1' })).status).toBe(429);
  });

  it('requires a signed-in operator', async () => {
    mocks.actor.mockResolvedValue({ ok: false, error: 'Unauthorized', status: 401 });
    expect((await call({ caseId: 'finding:f1' })).status).toBe(401);
    expect(mocks.run).not.toHaveBeenCalled();
  });
});

describe('case investigation history (P3c)', () => {
  it('lists the case history for the operator, scoped to the session organization', async () => {
    mocks.actor.mockResolvedValue({ ok: true, actor: { organizationId: 'org-1', actorId: 'user-1' } });
    const response = await GET(Object.assign(new Request('http://localhost/x'), {
      nextUrl: new URL('http://localhost/api/projects/p1/resolution-cases/investigation?caseId=finding:f1') }) as never,
      { params: Promise.resolve({ id: 'p1' }) });
    expect(response.status).toBe(200);
    expect(mocks.list).toHaveBeenCalledWith(mocks.admin, { organizationId: 'org-1', projectId: 'p1', caseId: 'finding:f1' });
    expect(await response.json()).toEqual({ investigations: [{ id: 'record-1', diagnosis: 'd' }] });
  });
});
