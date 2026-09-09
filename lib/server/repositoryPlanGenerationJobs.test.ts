import { describe, expect, it, vi } from 'vitest';

import {
  BEGIN_REPOSITORY_PLAN_PROVIDER_RPC, CLAIM_REPOSITORY_PLAN_JOB_RPC,
  CREATE_REPOSITORY_PLAN_JOB_RPC, FAIL_REPOSITORY_PLAN_JOB_RPC,
  READ_REPOSITORY_PLAN_JOB_RPC, READ_REPOSITORY_PLAN_SOURCE_RPC, SUCCEED_REPOSITORY_PLAN_JOB_RPC,
  beginRepositoryPlanProviderCall, claimRepositoryPlanGenerationJob,
  createRepositoryPlanGenerationJob, failRepositoryPlanGenerationJob,
  readRepositoryPlanGenerationJob, readRepositoryPlanGenerationSource,
  succeedRepositoryPlanGenerationJob,
} from '@/lib/server/repositoryPlanGenerationJobs';

const ids = {
  assessmentId: '11111111-1111-4111-8111-111111111111',
  reviewId: '22222222-2222-4222-8222-222222222222',
  actorId: '33333333-3333-4333-8333-333333333333',
  jobId: '44444444-4444-4444-8444-444444444444',
  token: '55555555-5555-4555-8555-555555555555',
  runId: '66666666-6666-4666-8666-666666666666',
};
const identity = { assessmentId: ids.assessmentId, assessmentVersion: 2,
  reviewId: ids.reviewId, reviewVersion: 3, classification: 'RULE' as const,
  implementationPlanV1DigestSha256: 'a'.repeat(64) };

describe('repository plan generation job RPC adapter', () => {
  it('creates through only the control RPC with derived exact identity', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ job_id: ids.jobId, job_status: 'pending',
      created_at: '2026-09-08T18:00:00Z' }], error: null });
    await expect(createRepositoryPlanGenerationJob({ ...identity, requestedByActorId: ids.actorId },
      { control: { rpc } })).resolves.toMatchObject({ ok: true, jobId: ids.jobId, status: 'pending' });
    expect(rpc).toHaveBeenCalledWith(CREATE_REPOSITORY_PLAN_JOB_RPC, expect.objectContaining({
      p_requested_by_actor_id: ids.actorId, p_implementation_plan_v1_digest_sha256: 'a'.repeat(64),
    }));
  });

  it('rejects unknown and caller-controlled fields before database access', async () => {
    const rpc = vi.fn();
    for (const extra of ['repositoryRoot','commitSha','provider','model','retryCount','planV2']) {
      await expect(createRepositoryPlanGenerationJob({ ...identity, requestedByActorId: ids.actorId,
        [extra]: 'forbidden' }, { control: { rpc } })).resolves.toEqual({ ok: false, code: 'invalid_input' });
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('claims through only the worker RPC and accepts no-work as a clean result', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [{ job_id: ids.jobId, claim_token: ids.token,
      claim_status: 'acquired', assessment_id: ids.assessmentId, assessment_version: 2,
      review_id: ids.reviewId, review_version: 3, classification: 'RULE',
      implementation_plan_v1_digest_sha256: 'a'.repeat(64) }], error: null })
      .mockResolvedValueOnce({ data: [], error: null });
    await expect(claimRepositoryPlanGenerationJob({ rpc })).resolves.toMatchObject({
      ok: true, job: { job_id: ids.jobId, claim_token: ids.token } });
    await expect(claimRepositoryPlanGenerationJob({ rpc })).resolves.toEqual({ ok: true, job: null });
    expect(rpc).toHaveBeenNthCalledWith(1, CLAIM_REPOSITORY_PLAN_JOB_RPC);
  });

  it('uses token-bound worker RPCs for provider start and terminal transitions', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null }); const worker = { rpc };
    await expect(beginRepositoryPlanProviderCall(worker, ids.jobId, ids.token))
      .resolves.toEqual({ ok: true });
    await expect(succeedRepositoryPlanGenerationJob(worker, ids.jobId, ids.token, ids.runId))
      .resolves.toEqual({ ok: true });
    await expect(failRepositoryPlanGenerationJob(worker, ids.jobId, ids.token, 'provider_timeout'))
      .resolves.toEqual({ ok: true });
    expect(rpc.mock.calls.map((call) => call[0])).toEqual([
      BEGIN_REPOSITORY_PLAN_PROVIDER_RPC, SUCCEED_REPOSITORY_PLAN_JOB_RPC, FAIL_REPOSITORY_PLAN_JOB_RPC,
    ]);
  });

  it('reads exact source rows only through the token-bound worker RPC', async () => {
    const source = { assessment_row: { id: ids.assessmentId }, review_row: { id: ids.reviewId },
      step_review_rows: [{ id: '77777777-7777-4777-8777-777777777777' }] };
    const rpc = vi.fn().mockResolvedValue({ data: [source], error: null });
    await expect(readRepositoryPlanGenerationSource({ rpc }, ids.jobId, ids.token))
      .resolves.toEqual({ ok: true, source });
    expect(rpc).toHaveBeenCalledWith(READ_REPOSITORY_PLAN_SOURCE_RPC,
      { p_job_id: ids.jobId, p_claim_token: ids.token });
  });

  it('reads exact bounded state and fails closed for malformed receipts', async () => {
    const row = { job_id: ids.jobId, assessment_id: ids.assessmentId, assessment_version: 2,
      review_id: ids.reviewId, review_version: 3, classification: 'RULE',
      implementation_plan_v1_digest_sha256: 'a'.repeat(64), authority: 'non_authoritative',
      purpose: 'repository_plan_generation', requires_human_review: true, job_status: 'pending',
      provider_call_count: 0, plan_v2_run_id: null, plan_v2_digest_sha256: null,
      repository_commit_sha: null, failure_code: null, created_at: '2026-09-08T18:00:00Z',
      updated_at: '2026-09-08T18:00:00Z', completed_at: null };
    const rpc = vi.fn().mockResolvedValueOnce({ data: [row], error: null })
      .mockResolvedValueOnce({ data: [{ ...row, raw_output: 'forbidden' }], error: null });
    await expect(readRepositoryPlanGenerationJob(ids.jobId, { control: { rpc } }))
      .resolves.toMatchObject({ ok: true, job: { job_status: 'pending' } });
    await expect(readRepositoryPlanGenerationJob(ids.jobId, { control: { rpc } }))
      .resolves.toEqual({ ok: false, code: 'invalid_receipt' });
    expect(rpc).toHaveBeenCalledWith(READ_REPOSITORY_PLAN_JOB_RPC, { p_job_id: ids.jobId });
  });
});
