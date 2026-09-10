import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ actor: vi.fn(), create: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: mocks.actor }));
vi.mock('@/lib/server/workflowRepositoryPlanRuns', () => ({
  createWorkflowRepositoryPlanRun: mocks.create,
  readWorkflowRepositoryPlanRun: mocks.read,
}));

import * as collection from '@/app/api/internal/repository-plan-runs/route';
import * as member from '@/app/api/internal/repository-plan-runs/[jobId]/route';

const actor = {
  actorId: '11111111-1111-4111-8111-111111111111', organizationId: 'org',
  displayName: 'Operator', role: 'reviewer', email: 'operator@example.test',
};
const identity = {
  assessmentId: '22222222-2222-4222-8222-222222222222', assessmentVersion: 3,
  reviewId: '33333333-3333-4333-8333-333333333333', reviewVersion: 4,
  classification: 'RULE' as const,
};
const jobId = '44444444-4444-4444-8444-444444444444';

function post(body: unknown): Request {
  return new Request('https://example.test/api/internal/repository-plan-runs', {
    method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function get(suffix = ''): Request {
  return new Request(`https://example.test/api/internal/repository-plan-runs/${jobId}${suffix}`, {
    headers: { authorization: 'Bearer token' },
  });
}
const context = { params: Promise.resolve({ jobId }) };

describe('repository Plan run operator routes', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS = actor.email;
    delete process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES;
    mocks.actor.mockResolvedValue({ ok: true, actor });
    mocks.create.mockResolvedValue({ ok: true, job: { jobId, status: 'pending', classification: 'RULE' } });
    mocks.read.mockResolvedValue({ ok: true, job: { jobId, status: 'pending', classification: 'RULE' } });
  });

  it('authenticates, authorizes, and forwards only the strict five-field identity plus session actor', async () => {
    const response = await collection.POST(post(identity));
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(identity, {
      actorId: actor.actorId, email: actor.email, role: actor.role,
    });
    await expect(response.json()).resolves.toEqual({
      ok: true, job: { jobId, status: 'pending', classification: 'RULE' },
    });
  });

  it.each([
    'planV1', 'planV2', 'foundation', 'contentBundle', 'files', 'evidence', 'repositoryRoot',
    'commitSha', 'branch', 'provider', 'model', 'prompt', 'tokenBudget', 'retryCount',
    'rawOutput', 'latest', 'actorId', 'operatorId', 'reviewerActorId', 'unknown',
  ])('rejects unknown key %s without creating a job', async (key) => {
    const response = await collection.POST(post({ ...identity, [key]: 'injected' }));
    expect(response.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies and incomplete or invalid identities', async () => {
    for (const body of [null, [], 'value', { ...identity, reviewId: undefined },
      { ...identity, assessmentVersion: 0 }, { ...identity, classification: 'ALL' }]) {
      expect((await collection.POST(post(body))).status).toBe(400);
    }
    const malformed = new Request('https://example.test/api/internal/repository-plan-runs', {
      method: 'POST', headers: { authorization: 'Bearer token' }, body: '{',
    });
    expect((await collection.POST(malformed)).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('resolves authentication and authorization before parsing', async () => {
    mocks.actor.mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await collection.POST(post({ injected: true }))).status).toBe(401);
    mocks.actor.mockResolvedValue({ ok: true, actor: { ...actor, email: 'other@example.test', role: 'admin' } });
    expect((await collection.POST(post({ injected: true }))).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([['invalid_pin', 400], ['classification_not_present', 400], ['not_configured', 503], ['create_failed', 500]])(
    'maps create failure %s without exposing details', async (code, status) => {
      mocks.create.mockResolvedValue({ ok: false, code, reason: 'private evidence' });
      const response = await collection.POST(post(identity));
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, error: code });
    },
  );

  it('reads an exact job without query, body, or side effects', async () => {
    const response = await member.GET(get(), context);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(jobId);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('rejects malformed job identity and every query key before reads', async () => {
    expect((await member.GET(get('?latest=true'), context)).status).toBe(400);
    expect((await member.GET(get(), { params: Promise.resolve({ jobId: 'not-a-uuid' }) })).status).toBe(400);
    const bodyRequest = get();
    Object.defineProperty(bodyRequest, 'body', { value: new ReadableStream() });
    expect((await member.GET(bodyRequest, context)).status).toBe(400);
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it.each([
    { jobId, classification: 'RULE', status: 'pending' },
    { jobId, classification: 'RULE', status: 'claimed' },
    { jobId, classification: 'RULE', status: 'failed', failureCode: 'provider_disabled' },
    { jobId, classification: 'RULE', status: 'succeeded', result: {
      planV2RunId: '55555555-5555-4555-8555-555555555555',
      planV2DigestSha256: 'a'.repeat(64), repositoryCommitSha: 'b'.repeat(40), providerCallCount: 1,
    } },
  ])('returns only the bounded $status envelope', async (job) => {
    mocks.read.mockResolvedValue({ ok: true, job: { ...job, privateSource: 'never expose' } });
    const response = await member.GET(get(), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.job).not.toHaveProperty('privateSource');
    expect(body).toEqual({ ok: true, job });
  });

  it.each([['not_found', 404], ['not_configured', 503], ['read_failed', 500]])(
    'maps read failure %s', async (code, status) => {
      mocks.read.mockResolvedValue({ ok: false, code, reason: 'private' });
      const response = await member.GET(get(), context);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ ok: false, error: code });
    },
  );

  it('exports only the intended methods and explicit uncached Node configuration', () => {
    expect(Object.keys(collection).sort()).toEqual(['POST', 'dynamic', 'runtime']);
    expect(Object.keys(member).sort()).toEqual(['GET', 'dynamic', 'runtime']);
  });
});
