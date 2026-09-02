// Durable claim, bounded retry, and race safety.
//
// The provider is reachable only while holding a claim, so sweep/sweep,
// sweep/manual and manual/manual double-spend are all closed by one rule.
// Every test here is provider-free.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getAdmin = vi.hoisted(() => vi.fn());
const runAssessment = vi.hoisted(() => vi.fn());
const enabled = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: getAdmin }));
vi.mock('@/lib/server/workflowAssessment', () => ({
  runAndRecordWorkflowAssessment: runAssessment,
  isWorkflowAssessmentEnabled: enabled,
}));

import {
  executeClaimedWorkflowAssessment,
  WORKFLOW_ASSESSMENT_CLAIM_FUNCTION,
  WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION,
  WORKFLOW_ASSESSMENT_MAX_ATTEMPTS,
} from '@/lib/server/workflowAssessmentClaim';

const SUBMISSION = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';

/**
 * A database that grants at most one live claim per submission, mirroring the
 * partial unique index on (source_submission_id) WHERE status = 'claimed'.
 */
function claimingDatabase(options: {
  attemptsUsed?: number;
  alreadyAssessed?: boolean;
} = {}) {
  const state = {
    live: false,
    attempts: options.attemptsUsed ?? 0,
    assessed: options.alreadyAssessed ?? false,
    finalized: [] as Array<{ status: string; failureClass: string | null }>,
  };

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === WORKFLOW_ASSESSMENT_CLAIM_FUNCTION) {
      const max = args.p_max_attempts as number;
      // Exactly the eligibility the SQL enforces.
      if (state.assessed || state.live || state.attempts >= max) {
        return { data: [], error: null };
      }
      state.live = true;
      state.attempts += 1;
      return {
        data: [{
          attempt_id: ATTEMPT,
          source_submission_id: SUBMISSION,
          attempt_number: state.attempts,
        }],
        error: null,
      };
    }
    if (name === WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION) {
      if (!state.live) throw new Error('finalizing an attempt that is not live');
      state.live = false;
      state.finalized.push({
        status: args.p_status as string,
        failureClass: (args.p_failure_class as string | null) ?? null,
      });
      if (args.p_status === 'succeeded') state.assessed = true;
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  getAdmin.mockReturnValue({ rpc });
  return { state, rpc };
}

const recorded = {
  status: 'assessment_recorded', assessmentId: 'a1', sourceSubmissionId: SUBMISSION,
  assessmentVersion: 1, requiresHumanReview: true, authority: 'non_authoritative',
} as const;

describe('workflow assessment claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enabled.mockReturnValue(true);
    runAssessment.mockResolvedValue(recorded);
  });

  it('is bounded to two attempts: one execution plus one retry', () => {
    expect(WORKFLOW_ASSESSMENT_MAX_ATTEMPTS).toBe(2);
  });

  // 1. pending submission claimed once
  it('claims a submission and calls the provider exactly once', async () => {
    const { rpc } = claimingDatabase();
    const result = await executeClaimedWorkflowAssessment();
    expect(result).toMatchObject({ status: 'attempt_completed', recorded: true });
    expect(runAssessment).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_max_attempts: 2 });
  });

  // 2/3/4/5. concurrent claims: sweep/sweep, sweep/manual, manual/manual
  it.each([
    ['sweep vs sweep', undefined, undefined],
    ['sweep vs manual', undefined, SUBMISSION],
    ['manual vs manual', SUBMISSION, SUBMISSION],
  ])('%s: only one caller reaches the provider', async (_label, a, b) => {
    const { state } = claimingDatabase();
    // Both start before either finalizes: the second finds a live claim.
    let releaseFirst: () => void = () => {};
    runAssessment.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return recorded;
    });

    const first = executeClaimedWorkflowAssessment(a);
    await Promise.resolve();
    const second = await executeClaimedWorkflowAssessment(b);

    expect(second.status).toBe('nothing_claimable');
    releaseFirst();
    expect((await first).status).toBe('attempt_completed');
    // One provider call across both callers.
    expect(runAssessment).toHaveBeenCalledTimes(1);
    expect(state.attempts).toBe(1);
  });

  // 6. provider success finalizes the attempt
  it('finalizes a successful attempt as succeeded with no failure class', async () => {
    const { state } = claimingDatabase();
    await executeClaimedWorkflowAssessment();
    expect(state.finalized).toEqual([{ status: 'succeeded', failureClass: null }]);
  });

  // 7. provider failure records a failed attempt
  it('finalizes a failed attempt with a reason code only', async () => {
    const { state } = claimingDatabase();
    runAssessment.mockResolvedValue({ status: 'assessment_not_produced', reason: 'x' });
    const result = await executeClaimedWorkflowAssessment();
    expect(result).toMatchObject({ recorded: false });
    expect(state.finalized).toEqual([
      { status: 'failed', failureClass: 'assessment_not_produced' },
    ]);
  });

  it('finalizes as failed when the runner throws, without surfacing the error', async () => {
    const { state } = claimingDatabase();
    runAssessment.mockRejectedValue(new Error('provider said something quotable'));
    const result = await executeClaimedWorkflowAssessment();
    expect(result).toMatchObject({ recorded: false });
    expect(state.finalized).toEqual([
      { status: 'failed', failureClass: 'execution_threw' },
    ]);
    expect(JSON.stringify(result)).not.toContain('quotable');
  });

  // 8/9. bounded retry, then exhaustion
  it('retries once and then refuses to claim again', async () => {
    const { state } = claimingDatabase();
    runAssessment.mockResolvedValue({ status: 'provider_failed', reason: 'timeout' });

    const first = await executeClaimedWorkflowAssessment();
    const second = await executeClaimedWorkflowAssessment();
    const third = await executeClaimedWorkflowAssessment();

    expect(first.status).toBe('attempt_completed');
    expect(second.status).toBe('attempt_completed');
    // Exhausted: no third provider call, ever.
    expect(third.status).toBe('nothing_claimable');
    expect(runAssessment).toHaveBeenCalledTimes(WORKFLOW_ASSESSMENT_MAX_ATTEMPTS);
    expect(state.attempts).toBe(2);
  });

  it('never claims a submission that already has an assessment', async () => {
    claimingDatabase({ alreadyAssessed: true });
    const result = await executeClaimedWorkflowAssessment();
    expect(result.status).toBe('nothing_claimable');
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('never claims an exhausted submission, even manually', async () => {
    claimingDatabase({ attemptsUsed: WORKFLOW_ASSESSMENT_MAX_ATTEMPTS });
    // The manual trigger uses the same eligibility, so it cannot revive it.
    const manual = await executeClaimedWorkflowAssessment(SUBMISSION);
    expect(manual.status).toBe('nothing_claimable');
    expect(runAssessment).not.toHaveBeenCalled();
  });

  // 14. feature flag off prevents claim and provider
  it('creates no attempt row at all while the feature is disabled', async () => {
    const { rpc } = claimingDatabase();
    enabled.mockReturnValue(false);
    const result = await executeClaimedWorkflowAssessment();
    expect(result.status).toBe('assessment_disabled');
    expect(rpc).not.toHaveBeenCalled();
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('reports not_configured without a service client', async () => {
    getAdmin.mockReturnValue(null);
    await expect(executeClaimedWorkflowAssessment())
      .resolves.toEqual({ status: 'not_configured' });
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('does not call the provider when claim acquisition errors', async () => {
    getAdmin.mockReturnValue({
      rpc: vi.fn(async () => ({ data: null, error: { message: 'deadlock detected' } })),
    });
    const result = await executeClaimedWorkflowAssessment();
    expect(result.status).toBe('claim_failed');
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('does not call the provider when the claim row is malformed', async () => {
    getAdmin.mockReturnValue({
      rpc: vi.fn(async () => ({ data: [{ attempt_id: 42 }], error: null })),
    });
    const result = await executeClaimedWorkflowAssessment();
    expect(result).toMatchObject({ status: 'claim_failed' });
    expect(runAssessment).not.toHaveBeenCalled();
  });

  // 10. an exhausted submission does not starve later work
  it('lets a later submission proceed after an earlier one is exhausted', async () => {
    const OTHER = '33333333-3333-4333-8333-333333333333';
    let exhausted = 0;
    getAdmin.mockReturnValue({
      rpc: vi.fn(async (name: string) => {
        if (name === WORKFLOW_ASSESSMENT_CLAIM_FUNCTION) {
          // The SQL skips the exhausted row and returns the next eligible one.
          exhausted += 1;
          return {
            data: [{ attempt_id: ATTEMPT, source_submission_id: OTHER, attempt_number: 1 }],
            error: null,
          };
        }
        return { data: null, error: null };
      }),
    });
    const result = await executeClaimedWorkflowAssessment();
    expect(result).toMatchObject({ submissionId: OTHER });
    expect(exhausted).toBe(1);
  });
});
