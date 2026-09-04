import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readWorkflowImplementationPlan } from './workflowImplementationPlanRead';

const mocks = vi.hoisted(() => ({ read: vi.fn(), build: vi.fn() }));
vi.mock('@/lib/server/workflowEffectiveReviewedSpecificationRead', () => ({
  readEffectiveReviewedSpecification: mocks.read,
}));
vi.mock('@/lib/workflowImplementationPlan', () => ({ buildWorkflowImplementationPlan: mocks.build }));

const pin = {
  assessmentId: '11111111-1111-4111-8111-111111111111', assessmentVersion: 3,
  reviewId: '22222222-2222-4222-8222-222222222222', reviewVersion: 7,
};

describe('trusted implementation plan composition', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('provider/network forbidden'); }));
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('passes the same returned artifact directly, after awaiting the exact pinned read', async () => {
    const request = new Request('http://localhost/');
    const artifact = Object.freeze({ digest: { value: 'resolver digest' }, sentinel: {} });
    const plan = Object.freeze({ ok: true, artifact: { digest: { value: 'plan digest' } } });
    let finish!: (value: unknown) => void;
    mocks.read.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    mocks.build.mockReturnValue(plan);
    const pending = readWorkflowImplementationPlan(request, pin);
    expect(mocks.read).toHaveBeenCalledExactlyOnceWith(request, pin);
    expect(mocks.read.mock.calls[0]![1]).toBe(pin);
    expect(mocks.build).not.toHaveBeenCalled();
    finish({ ok: true, artifact });
    expect(await pending).toBe(plan);
    expect(mocks.build).toHaveBeenCalledOnce();
    expect(mocks.build.mock.calls[0]![0]).toBe(artifact);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    'unauthorized', 'reviewer_not_eligible', 'not_configured', 'invalid_pin',
    'assessment_not_found', 'review_not_found', 'read_failed', 'invalid_json',
    'invalid_evidence', 'assessment_pin_mismatch', 'review_pin_mismatch',
    'missing_step_review', 'proposal_not_composable', 'invalid_specification',
  ])('passes through %s without building a partial plan', async (code) => {
    const failure = { ok: false, code };
    mocks.read.mockResolvedValue(failure);
    expect(await readWorkflowImplementationPlan(new Request('http://localhost/'), pin)).toBe(failure);
    expect(mocks.build).not.toHaveBeenCalled();
  });

  it('fails closed and logs only a fixed message when the builder rejects trusted input', async () => {
    mocks.read.mockResolvedValue({ ok: true, artifact: {} });
    mocks.build.mockReturnValue({ ok: false, code: 'invalid_artifact' });
    expect(await readWorkflowImplementationPlan(new Request('http://localhost/'), pin))
      .toEqual({ ok: false, code: 'plan_not_composable' });
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[workflowImplementationPlan] trusted artifact not composable');
  });

  it.each(['read', 'build'] as const)('contains an unexpected %s exception without leaking evidence', async (stage) => {
    mocks.read.mockResolvedValue({ ok: true, artifact: {} });
    mocks[stage].mockImplementation(() => { throw new Error('private evidence'); });
    expect(await readWorkflowImplementationPlan(new Request('http://localhost/'), pin))
      .toEqual({ ok: false, code: 'plan_not_composable' });
    expect(console.error).toHaveBeenCalledExactlyOnceWith('[workflowImplementationPlan] composition failed');
  });
});
