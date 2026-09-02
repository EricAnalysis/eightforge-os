// Bounded daily batch: at most three provider attempts per scheduled sweep.
//
// The cron is daily because the hosting plan permits nothing finer, so this
// constant is the scheduled ceiling on provider spend. It counts attempts, not
// successes, and never relaxes the per-submission lifetime cap.
//
// Every test is provider-free.
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
  sweepWorkflowAssessments,
  WORKFLOW_ASSESSMENT_CLAIM_FUNCTION,
  WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION,
  WORKFLOW_ASSESSMENT_MAX_ATTEMPTS,
  WORKFLOW_ASSESSMENT_SWEEP_BATCH_SIZE,
} from '@/lib/server/workflowAssessmentClaim';

type Submission = {
  id: string;
  attempts: number;
  assessed: boolean;
  live: boolean;
};

/** A database mirroring the claim function's eligibility rules exactly. */
function database(submissions: Submission[]) {
  const providerCalls: string[] = [];
  const finalized: Array<{ id: string; status: string }> = [];

  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === WORKFLOW_ASSESSMENT_CLAIM_FUNCTION) {
      const max = args.p_max_attempts as number;
      const only = args.p_submission_id as string | null;
      const excluded = (args.p_exclude_submission_ids as string[] | null) ?? [];
      const eligible = submissions.find((s) =>
        (only === null || s.id === only)
        && !excluded.includes(s.id)
        && !s.assessed
        && !s.live
        && s.attempts < max);
      if (!eligible) return { data: [], error: null };
      eligible.live = true;
      eligible.attempts += 1;
      return {
        data: [{
          attempt_id: `att-${eligible.id}-${eligible.attempts}`,
          source_submission_id: eligible.id,
          attempt_number: eligible.attempts,
        }],
        error: null,
      };
    }
    if (name === WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION) {
      const id = String(args.p_attempt_id).split('-')[1]!;
      const row = submissions.find((s) => s.id === id);
      if (row) {
        row.live = false;
        if (args.p_status === 'succeeded') row.assessed = true;
      }
      finalized.push({ id, status: args.p_status as string });
      return { data: null, error: null };
    }
    throw new Error(`unexpected rpc ${name}`);
  });

  getAdmin.mockReturnValue({ rpc });
  runAssessment.mockImplementation(async (submissionId: string) => {
    providerCalls.push(submissionId);
    return { status: 'assessment_recorded', assessmentId: 'a', sourceSubmissionId: submissionId,
      assessmentVersion: 1, requiresHumanReview: true, authority: 'non_authoritative' };
  });

  return { providerCalls, finalized, rpc };
}

const pending = (...ids: string[]): Submission[] =>
  ids.map((id) => ({ id, attempts: 0, assessed: false, live: false }));

describe('bounded daily sweep batch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enabled.mockReturnValue(true);
  });

  it('caps a scheduled sweep at three attempts', () => {
    expect(WORKFLOW_ASSESSMENT_SWEEP_BATCH_SIZE).toBe(3);
    // Independent of the per-submission lifetime ceiling.
    expect(WORKFLOW_ASSESSMENT_MAX_ATTEMPTS).toBe(2);
  });

  // 1. zero pending -> zero provider attempts
  it('makes no provider call when nothing is pending', async () => {
    const { providerCalls } = database([]);
    const result = await sweepWorkflowAssessments();
    expect(result).toMatchObject({ attempted: 0, stoppedBecause: 'nothing_claimable' });
    expect(providerCalls).toEqual([]);
  });

  // 2. one pending -> one attempt
  it('attempts exactly one when one is pending', async () => {
    const { providerCalls } = database(pending('a'));
    const result = await sweepWorkflowAssessments();
    expect(result).toMatchObject({ attempted: 1, recorded: 1 });
    expect(providerCalls).toEqual(['a']);
  });

  // 3/4. three pending -> three; four+ -> still three
  it.each([
    ['three pending', ['a', 'b', 'c'], ['a', 'b', 'c']],
    ['five pending', ['a', 'b', 'c', 'd', 'e'], ['a', 'b', 'c']],
  ])('%s attempts at most three, oldest first', async (_label, ids, expected) => {
    const { providerCalls } = database(pending(...ids));
    const result = await sweepWorkflowAssessments();
    expect(providerCalls).toEqual(expected);
    expect(result.attempted).toBe(3);
    expect(result.stoppedBecause).toBe('batch_full');
  });

  // 5. first item fails -> later eligible items still run
  it('continues past a failure instead of aborting the batch', async () => {
    const { providerCalls, finalized } = database(pending('a', 'b', 'c'));
    runAssessment.mockImplementation(async (submissionId: string) => {
      providerCalls.push(submissionId);
      if (submissionId === 'a') return { status: 'provider_failed', reason: 'timeout' };
      return { status: 'assessment_recorded', assessmentId: 'x',
        sourceSubmissionId: submissionId, assessmentVersion: 1,
        requiresHumanReview: true, authority: 'non_authoritative' };
    });
    const result = await sweepWorkflowAssessments();
    expect(providerCalls).toEqual(['a', 'b', 'c']);
    expect(result).toMatchObject({ attempted: 3, recorded: 2 });
    expect(finalized[0]).toEqual({ id: 'a', status: 'failed' });
  });

  // 9. no submission receives two attempts in one sweep
  it('never attempts the same submission twice in one sweep', async () => {
    // Only 'a' is pending and it fails, leaving it eligible again with one
    // lifetime attempt remaining. Without exclusion the next claim would take
    // it straight back and spend its final attempt in the same invocation.
    const { providerCalls } = database(pending('a'));
    runAssessment.mockImplementation(async (submissionId: string) => {
      providerCalls.push(submissionId);
      return { status: 'provider_failed', reason: 'timeout' };
    });
    const result = await sweepWorkflowAssessments();
    expect(providerCalls).toEqual(['a']);
    expect(result).toMatchObject({ attempted: 1, stoppedBecause: 'nothing_claimable' });
  });

  // 6. exhausted oldest item -> later items run
  it('skips an exhausted oldest submission and runs the next', async () => {
    const submissions: Submission[] = [
      { id: 'old', attempts: WORKFLOW_ASSESSMENT_MAX_ATTEMPTS, assessed: false, live: false },
      ...pending('next'),
    ];
    const { providerCalls } = database(submissions);
    await sweepWorkflowAssessments();
    expect(providerCalls).toEqual(['next']);
  });

  // 7. actively claimed item -> skipped without provider spend
  it('skips a submission another sweep already claimed', async () => {
    const submissions: Submission[] = [
      { id: 'claimed', attempts: 1, assessed: false, live: true },
      ...pending('free'),
    ];
    const { providerCalls } = database(submissions);
    await sweepWorkflowAssessments();
    expect(providerCalls).toEqual(['free']);
  });

  // 8. already-assessed item -> skipped
  it('skips a submission that already has an assessment', async () => {
    const submissions: Submission[] = [
      { id: 'done', attempts: 1, assessed: true, live: false },
      ...pending('todo'),
    ];
    const { providerCalls } = database(submissions);
    await sweepWorkflowAssessments();
    expect(providerCalls).toEqual(['todo']);
  });

  // 10. concurrent sweeps cannot double-claim
  it('lets two concurrent sweeps share the work without overlap', async () => {
    const { providerCalls } = database(pending('a', 'b', 'c', 'd', 'e', 'f'));
    await Promise.all([sweepWorkflowAssessments(), sweepWorkflowAssessments()]);
    // Six attempts across two sweeps, each capped at three, none repeated.
    expect(providerCalls).toHaveLength(6);
    expect(new Set(providerCalls).size).toBe(6);
  });

  // 11. feature flag off -> zero claims and zero provider attempts
  it('claims nothing while the feature is disabled', async () => {
    const { providerCalls, rpc } = database(pending('a', 'b', 'c'));
    enabled.mockReturnValue(false);
    const result = await sweepWorkflowAssessments();
    expect(result).toMatchObject({ attempted: 0, stoppedBecause: 'disabled' });
    expect(rpc).not.toHaveBeenCalled();
    expect(providerCalls).toEqual([]);
  });

  it('stops the batch without spending when a claim errors', async () => {
    getAdmin.mockReturnValue({
      rpc: vi.fn(async () => ({ data: null, error: { message: 'deadlock' } })),
    });
    const result = await sweepWorkflowAssessments();
    expect(result).toMatchObject({ attempted: 0, stoppedBecause: 'claim_failed' });
    expect(runAssessment).not.toHaveBeenCalled();
  });

  it('processes sequentially rather than in parallel', async () => {
    const { providerCalls } = database(pending('a', 'b', 'c'));
    let concurrent = 0;
    let peak = 0;
    runAssessment.mockImplementation(async (submissionId: string) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => { setTimeout(resolve, 1); });
      concurrent -= 1;
      providerCalls.push(submissionId);
      return { status: 'assessment_recorded', assessmentId: 'a',
        sourceSubmissionId: submissionId, assessmentVersion: 1,
        requiresHumanReview: true, authority: 'non_authoritative' };
    });
    await sweepWorkflowAssessments();
    // Three simultaneous provider calls would be three simultaneous costs.
    expect(peak).toBe(1);
  });
});
