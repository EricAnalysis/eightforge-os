import { describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ read: vi.fn(), build: vi.fn() }));
vi.mock('@/lib/server/workflowEffectiveReviewedSpecificationRead', () => ({ readEffectiveReviewedSpecification: mocks.read }));
vi.mock('@/lib/customerAdaptation/reviewedWorkflowContext', () => ({ buildReviewedWorkflowAdaptationContext: mocks.build }));
import { readReviewedWorkflowAdaptationContext } from './reviewedWorkflowAdaptationContextRead';

describe('adaptation context reuses authenticated reviewed-specification reads', () => {
  it.each(['unauthorized', 'reviewer_not_eligible', 'invalid_pin', 'review_not_found'])('preserves %s before projection', async (code) => {
    mocks.build.mockClear();
    mocks.read.mockResolvedValue({ ok: false, code });
    const request = new Request('https://example.test');
    const pin = { reviewId: 'exact-pin' };
    expect(await readReviewedWorkflowAdaptationContext(request, pin)).toEqual({ ok: false, code });
    expect(mocks.read).toHaveBeenLastCalledWith(request, pin);
    expect(mocks.build).not.toHaveBeenCalled();
  });
  it('passes only the resolved artifact, with no caller customer identity', async () => {
    const artifact = { immutable: 'trusted-artifact' };
    mocks.read.mockResolvedValue({ ok: true, artifact });
    mocks.build.mockReturnValue({ ok: true, context: { reviewed: true } });
    expect(await readReviewedWorkflowAdaptationContext(new Request('https://example.test'), { reviewId: 'pin' }))
      .toEqual({ ok: true, context: { reviewed: true } });
    expect(mocks.build).toHaveBeenLastCalledWith(artifact);
  });
});
