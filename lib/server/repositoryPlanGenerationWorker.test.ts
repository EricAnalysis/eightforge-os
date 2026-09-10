import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolve: vi.fn(), buildPlan: vi.fn(), foundation: vi.fn(), prepare: vi.fn(),
}));
vi.mock('@/lib/workflowEffectiveReviewedSpecification', () => ({
  resolveEffectiveReviewedSpecification: mocks.resolve,
}));
vi.mock('@/lib/workflowImplementationPlan', () => ({
  buildWorkflowImplementationPlan: mocks.buildPlan,
}));
vi.mock('@/lib/repositoryPlanFoundation', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repositoryPlanFoundation')>(),
  buildRepositoryPlanFoundation: mocks.foundation,
}));
vi.mock('@/lib/repositoryPlanGuidance', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/repositoryPlanGuidance')>(),
  prepareRepositoryPlanGuidance: mocks.prepare,
}));

import { runOneRepositoryPlanGenerationJob } from '@/lib/server/repositoryPlanGenerationWorker';

const job = {
  job_id: '11111111-1111-4111-8111-111111111111',
  claim_token: '22222222-2222-4222-8222-222222222222', claim_status: 'acquired' as const,
  assessment_id: '33333333-3333-4333-8333-333333333333', assessment_version: 1,
  review_id: '44444444-4444-4444-8444-444444444444', review_version: 2,
  classification: 'RULE' as const, implementation_plan_v1_digest_sha256: 'a'.repeat(64),
};
const snapshot = { commitSha: 'b'.repeat(40) };
const plan = { digest: { value: 'a'.repeat(64) }, plannedSteps: [{ effectiveClassification: 'RULE' }] };
const generated = { status: 'completed' as const, mode: 'provider_validated' as const,
  rawProviderEvidence: { raw: true }, planV2: { providerProvenance: { callCount: 1 }, digest: { value: 'c'.repeat(64) } } };

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    client: { rpc: vi.fn() },
    claim: vi.fn().mockResolvedValue({ ok: true, job }),
    readSource: vi.fn().mockResolvedValue({ ok: true, source: {
      assessment_row: {}, review_row: {}, step_review_rows: [],
    } }),
    verifySnapshot: vi.fn().mockReturnValue({ ok: true, snapshot }),
    loadCatalog: vi.fn().mockReturnValue({ ok: true, catalogDigestSha256: 'e'.repeat(64),
      manifest: [], evidence: [] }),
    collectContent: vi.fn().mockReturnValue({ ok: true, bundle: { content: true } }),
    beginProvider: vi.fn().mockResolvedValue({ ok: true }),
    runGuidance: vi.fn(async (_input, options) => {
      await options.beforeProviderCall?.();
      return generated;
    }),
    persist: vi.fn().mockResolvedValue({ status: 'recorded',
      planV2RunId: '55555555-5555-4555-8555-555555555555' }),
    succeed: vi.fn().mockResolvedValue({ ok: true }),
    fail: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  } as never;
}

describe('runOneRepositoryPlanGenerationJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockReturnValue({ ok: true, artifact: { reviewed: true } });
    mocks.buildPlan.mockReturnValue({ ok: true, artifact: plan });
    mocks.foundation.mockReturnValue({ ok: true, artifact: { foundation: true } });
    mocks.prepare.mockReturnValue({ ok: true, status: 'ready', artifact: { input: true } });
  });

  it('returns idle without reading trusted sources or a repository', async () => {
    const readSource = vi.fn();
    const verifySnapshot = vi.fn();
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo', dependencies({
      claim: vi.fn().mockResolvedValue({ ok: true, job: null }), readSource, verifySnapshot,
    }));
    expect(result).toEqual({ status: 'idle' });
    expect(readSource).not.toHaveBeenCalled();
    expect(verifySnapshot).not.toHaveBeenCalled();
  });

  it('durably marks the call before one provider invocation, persists, then succeeds', async () => {
    const beginProvider = vi.fn().mockResolvedValue({ ok: true });
    const persist = vi.fn().mockResolvedValue({ status: 'recorded',
      planV2RunId: '55555555-5555-4555-8555-555555555555' });
    const succeed = vi.fn().mockResolvedValue({ ok: true });
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo',
      dependencies({ beginProvider, persist, succeed }));
    expect(result).toMatchObject({ status: 'succeeded', providerCallCount: 1 });
    expect(beginProvider).toHaveBeenCalledExactlyOnceWith(expect.anything(), job.job_id, job.claim_token);
    expect(mocks.foundation).toHaveBeenCalledWith(expect.objectContaining({
      repositoryEvidenceCatalogDigestSha256: 'e'.repeat(64),
    }));
    expect(persist).toHaveBeenCalledOnce();
    expect(succeed).toHaveBeenCalledExactlyOnceWith(expect.anything(), job.job_id, job.claim_token,
      '55555555-5555-4555-8555-555555555555');
    expect(beginProvider.mock.invocationCallOrder[0]).toBeLessThan(persist.mock.invocationCallOrder[0]!);
  });

  it('does not invoke provider or persistence when the durable marker fails', async () => {
    const persist = vi.fn();
    const provider = vi.fn(async (_input, options) => {
      await options.beforeProviderCall?.();
      throw new Error('provider must not be reached');
    });
    const fail = vi.fn().mockResolvedValue({ ok: true });
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo', dependencies({
      beginProvider: vi.fn().mockResolvedValue({ ok: false, code: 'database_failed' }),
      runGuidance: provider, persist, fail,
    }));
    expect(result).toEqual({ status: 'failed', jobId: job.job_id, code: 'worker_failed' });
    expect(persist).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(expect.anything(), job.job_id, job.claim_token, 'worker_failed');
  });

  it('fails closed before repository access when the exact Plan V1 digest changes', async () => {
    mocks.buildPlan.mockReturnValue({ ok: true, artifact: { ...plan, digest: { value: 'd'.repeat(64) } } });
    const verifySnapshot = vi.fn();
    const fail = vi.fn().mockResolvedValue({ ok: true });
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo',
      dependencies({ verifySnapshot, fail }));
    expect(result).toEqual({ status: 'failed', jobId: job.job_id, code: 'trusted_source_invalid' });
    expect(verifySnapshot).not.toHaveBeenCalled();
  });

  it('does not call the provider marker for deterministic guidance', async () => {
    const beginProvider = vi.fn();
    const deterministic = { ...generated, mode: 'advisory' as const,
      rawProviderEvidence: null, planV2: { ...generated.planV2,
        providerProvenance: { callCount: 0 as const } } };
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo', dependencies({
      beginProvider,
      runGuidance: vi.fn().mockResolvedValue(deterministic),
    }));
    expect(result).toMatchObject({ status: 'succeeded', providerCallCount: 0 });
    expect(beginProvider).not.toHaveBeenCalled();
  });

  it.each([
    ['repository mismatch', { verifySnapshot: vi.fn().mockReturnValue({ ok: false, code: 'head_mismatch' }) }, 'repository_mismatch'],
    ['B1 failure', {}, 'trusted_source_invalid'],
    ['B1.5 failure', { collectContent: vi.fn().mockReturnValue({ ok: false, code: 'object_missing' }) }, 'repository_mismatch'],
  ])('fails before B2b on %s with zero provider calls', async (_name, override, code) => {
    if (_name === 'B1 failure') mocks.foundation.mockReturnValueOnce({ ok: false, code: 'invalid_plan_v1' });
    const runGuidance = vi.fn();
    const persist = vi.fn();
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo',
      dependencies({ ...override, runGuidance, persist }));
    expect(result).toMatchObject({ status: 'failed', code });
    expect(runGuidance).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it('persists an insufficient-evidence zero-call result without marking provider start', async () => {
    const beginProvider = vi.fn();
    const deterministic = { ...generated, mode: 'insufficient_evidence' as const,
      rawProviderEvidence: null, planV2: { ...generated.planV2,
        providerProvenance: { callCount: 0 as const } } };
    const persist = vi.fn().mockResolvedValue({ status: 'recorded',
      planV2RunId: '55555555-5555-4555-8555-555555555555' });
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo', dependencies({
      beginProvider, persist, runGuidance: vi.fn().mockResolvedValue(deterministic),
    }));
    expect(result).toMatchObject({ status: 'succeeded', providerCallCount: 0 });
    expect(beginProvider).not.toHaveBeenCalled();
    expect(persist).toHaveBeenCalledOnce();
  });

  it.each([
    ['forgewing_disabled', 0, 'provider_disabled'],
    ['provider_timeout', 1, 'provider_timeout'],
    ['invalid_model_output', 1, 'invalid_provider_output'],
  ] as const)('fails %s without persistence or worker-layer retry', async (reason, callCount, code) => {
    const beginProvider = vi.fn().mockResolvedValue({ ok: true });
    const runGuidance = vi.fn(async (_input, options) => {
      if (callCount === 1) await options.beforeProviderCall?.();
      return reason === 'forgewing_disabled'
        ? { status: 'skipped' as const, reason }
        : { status: 'failed' as const, reason, callCount, rawProviderEvidence: null };
    });
    const persist = vi.fn();
    const fail = vi.fn().mockResolvedValue({ ok: true });
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo',
      dependencies({ beginProvider, runGuidance, persist, fail }));
    expect(result).toMatchObject({ status: 'failed', code });
    expect(beginProvider).toHaveBeenCalledTimes(callCount);
    expect(runGuidance).toHaveBeenCalledOnce();
    expect(persist).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledOnce();
  });

  it('marks the job failed after one B3a attempt without another provider attempt', async () => {
    const runGuidance = vi.fn(async (_input, options) => {
      await options.beforeProviderCall?.();
      return generated;
    });
    const persist = vi.fn().mockResolvedValue({ status: 'persist_failed' });
    const fail = vi.fn().mockResolvedValue({ ok: true });
    const result = await runOneRepositoryPlanGenerationJob('C:\\repo',
      dependencies({ runGuidance, persist, fail }));
    expect(result).toEqual({ status: 'failed', jobId: job.job_id, code: 'persistence_failed' });
    expect(runGuidance).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
    expect(fail).toHaveBeenCalledOnce();
  });
});
