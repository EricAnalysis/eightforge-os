import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ create: vi.fn(), read: vi.fn(), resolve: vi.fn(), build: vi.fn() }));
vi.mock('@/lib/server/repositoryPlanGenerationJobs', () => ({
  createRepositoryPlanGenerationJob: mocks.create,
  readRepositoryPlanGenerationJob: mocks.read,
}));
vi.mock('@/lib/workflowEffectiveReviewedSpecification', () => ({
  resolveEffectiveReviewedSpecification: mocks.resolve,
}));
vi.mock('@/lib/workflowImplementationPlan', () => ({ buildWorkflowImplementationPlan: mocks.build }));

import { createWorkflowRepositoryPlanRun, readWorkflowRepositoryPlanRun } from '@/lib/server/workflowRepositoryPlanRuns';

const request = {
  assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 1,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 2,
  classification: 'RULE' as const,
};
const actor = { actorId: '33333333-3333-4333-8333-333333333333', email: null, role: null };

function query(result: { data: unknown; error: unknown }) {
  const chain = {
    select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(),
    then: (resolve: (value: typeof result) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject),
  };
  chain.select.mockReturnValue(chain); chain.eq.mockReturnValue(chain);
  chain.maybeSingle.mockResolvedValue(result);
  return chain;
}

function admin() {
  const rows = new Map([
    ['workflow_assessments', query({ data: { assessment: true }, error: null })],
    ['workflow_assessment_reviews', query({ data: { review: true }, error: null })],
    ['workflow_assessment_step_reviews', query({ data: [{ step: true }], error: null })],
  ]);
  return { from: vi.fn((table: string) => rows.get(table)), rpc: vi.fn() } as never;
}

describe('workflow repository Plan run service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockReturnValue({ ok: true, artifact: { resolved: true } });
    mocks.build.mockReturnValue({ ok: true, artifact: { digest: { value: 'a'.repeat(64) },
      plannedSteps: [{ effectiveClassification: 'RULE' }] } });
    mocks.create.mockResolvedValue({ ok: true,
      jobId: '44444444-4444-4444-8444-444444444444', status: 'pending' });
  });

  it('derives the exact Plan V1 digest and classification from trusted rows before queueing', async () => {
    const control = admin();
    const result = await createWorkflowRepositoryPlanRun(request, actor, { admin: control });
    expect(result).toMatchObject({ ok: true, job: { status: 'pending', classification: 'RULE' } });
    expect(mocks.resolve).toHaveBeenCalledWith(expect.objectContaining({ pin: request }));
    expect(mocks.create).toHaveBeenCalledWith({ ...request, requestedByActorId: actor.actorId,
      implementationPlanV1DigestSha256: 'a'.repeat(64) }, { control });
  });

  it('rejects classifications absent from the trusted Plan V1', async () => {
    const result = await createWorkflowRepositoryPlanRun({ ...request, classification: 'VERIFY' }, actor,
      { admin: admin() });
    expect(result).toEqual({ ok: false, code: 'classification_not_present' });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('maps a complete exact success row to the bounded result identity', async () => {
    mocks.read.mockResolvedValue({ ok: true, job: {
      job_id: '44444444-4444-4444-8444-444444444444', classification: 'RULE', job_status: 'succeeded',
      plan_v2_run_id: '55555555-5555-4555-8555-555555555555', plan_v2_digest_sha256: 'c'.repeat(64),
      repository_commit_sha: 'd'.repeat(40), provider_call_count: 1,
    } });
    await expect(readWorkflowRepositoryPlanRun('44444444-4444-4444-8444-444444444444', { admin: admin() }))
      .resolves.toMatchObject({ ok: true, job: { status: 'succeeded', result: {
        providerCallCount: 1, repositoryCommitSha: 'd'.repeat(40),
      } } });
  });

  it('fails closed when a terminal success row lacks its exact persisted identity', async () => {
    mocks.read.mockResolvedValue({ ok: true, job: {
      job_id: '44444444-4444-4444-8444-444444444444', classification: 'RULE', job_status: 'succeeded',
      plan_v2_run_id: null, plan_v2_digest_sha256: null, repository_commit_sha: null, provider_call_count: 0,
    } });
    await expect(readWorkflowRepositoryPlanRun('44444444-4444-4444-8444-444444444444', { admin: admin() }))
      .resolves.toEqual({ ok: false, code: 'read_failed' });
  });

  it('maps database-only crash codes into the closed public failure vocabulary', async () => {
    mocks.read.mockResolvedValue({ ok: true, job: {
      job_id: '44444444-4444-4444-8444-444444444444', classification: 'RULE', job_status: 'failed',
      failure_code: 'provider_claim_expired', provider_call_count: 1,
    } });
    await expect(readWorkflowRepositoryPlanRun('44444444-4444-4444-8444-444444444444', { admin: admin() }))
      .resolves.toMatchObject({ ok: true, job: { status: 'failed', failureCode: 'worker_failed' } });
  });
});
