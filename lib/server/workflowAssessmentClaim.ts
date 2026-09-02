// lib/server/workflowAssessmentClaim.ts
// The one path to a workflow assessment provider call.
//
// Both the scheduled sweep and the manual trigger converge here. Neither may
// reach the provider without first holding a claim, which is what closes
// sweep/sweep, sweep/manual and manual/manual double-spend with a single rule
// rather than three.
//
// The claim is acquired atomically in the database before any provider access,
// and released to a terminal state afterwards. A caller that loses the race
// receives `already_claimed` and does nothing.
//
// Attempts are operational coordination state. Nothing here writes canonical
// truth, Validator state, Project Truth, decisions, actions, or any executable
// rule, and an attempt row is never reviewed-specification authority.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  isWorkflowAssessmentEnabled,
  runAndRecordWorkflowAssessment,
  type WorkflowAssessmentRunResult,
} from '@/lib/server/workflowAssessment';

export const WORKFLOW_ASSESSMENT_CLAIM_FUNCTION =
  'claim_workflow_assessment_attempt' as const;
export const WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION =
  'finalize_workflow_assessment_attempt' as const;

/**
 * Total attempts per submission: one execution plus one automatic retry.
 *
 * Deliberately small. This is the first path from a public submission to
 * provider spend, and one retry absorbs a transient failure without funding
 * repeated attempts on a submission that will never succeed. After the second
 * failure the submission is exhausted and excluded from automatic execution, so
 * a permanently failing row cannot starve later work.
 *
 * Server-side only. It is never read from client input and never appears in
 * provider output, so neither can widen it.
 */
export const WORKFLOW_ASSESSMENT_MAX_ATTEMPTS = 2;

/**
 * Maximum provider attempts one scheduled sweep may make.
 *
 * The cron is daily, so this is the scheduled ceiling on provider spend: at
 * most three attempts per day, independent of how many submissions are waiting.
 * It counts ATTEMPTS, not successes -- three failures consume the batch just as
 * three successes would.
 *
 * It does not interact with the per-submission ceiling. A submission still gets
 * at most WORKFLOW_ASSESSMENT_MAX_ATTEMPTS across its whole lifetime, and never
 * more than one attempt within a single sweep.
 *
 * A V1 safety constant rather than a tuned value: it exists to bound exposure
 * before there is any usage, latency, failure-rate or cost measurement to tune
 * against. Server-side only, never client- or provider-configurable.
 */
export const WORKFLOW_ASSESSMENT_SWEEP_BATCH_SIZE = 3;

export type WorkflowAssessmentExecutionResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'assessment_disabled' }>
  | Readonly<{ status: 'nothing_claimable' }>
  | Readonly<{ status: 'claim_failed'; reason: string }>
  | Readonly<{
      status: 'attempt_completed';
      attemptId: string;
      submissionId: string;
      attemptNumber: number;
      outcome: WorkflowAssessmentRunResult['status'];
      recorded: boolean;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Claims one submission, assesses it, and finalizes the attempt.
 *
 * `submissionId` narrows the claim to a specific submission for the manual
 * trigger. It does not relax eligibility: an exhausted or already-claimed
 * submission is refused identically, so manual execution cannot bypass the
 * retry cap that bounds the sweep.
 */
export async function executeClaimedWorkflowAssessment(
  submissionId?: string,
  excludeSubmissionIds: readonly string[] = [],
): Promise<WorkflowAssessmentExecutionResult> {
  // Checked before the claim: a disabled deployment must not create attempt
  // rows, let alone approach the provider.
  if (!isWorkflowAssessmentEnabled()) return { status: 'assessment_disabled' };

  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const claim = await admin.rpc(WORKFLOW_ASSESSMENT_CLAIM_FUNCTION, {
    p_max_attempts: WORKFLOW_ASSESSMENT_MAX_ATTEMPTS,
    p_submission_id: submissionId ?? null,
    // Submissions already attempted in this sweep. A failed attempt is terminal
    // and leaves the submission eligible again, so without this the next claim
    // in the same invocation could immediately spend its second attempt.
    p_exclude_submission_ids: excludeSubmissionIds.length > 0
      ? [...excludeSubmissionIds] : null,
  });
  if (claim.error) return { status: 'claim_failed', reason: claim.error.message };

  const row = Array.isArray(claim.data) ? claim.data[0] : claim.data;
  // No row means nothing was eligible: already assessed, already claimed by a
  // concurrent caller, or out of attempts. In every case, no provider call.
  if (!isRecord(row)) return { status: 'nothing_claimable' };

  const attemptId = row.attempt_id;
  const claimedSubmission = row.source_submission_id;
  const attemptNumber = row.attempt_number;
  if (typeof attemptId !== 'string' || typeof claimedSubmission !== 'string') {
    return { status: 'claim_failed', reason: 'claim_row_malformed' };
  }

  // The provider call happens here, and only here, while the claim is held.
  let outcome: WorkflowAssessmentRunResult;
  try {
    outcome = await runAndRecordWorkflowAssessment(claimedSubmission);
  } catch {
    await admin.rpc(WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION, {
      p_attempt_id: attemptId,
      p_status: 'failed',
      p_failure_class: 'execution_threw',
    });
    return {
      status: 'attempt_completed',
      attemptId,
      submissionId: claimedSubmission,
      attemptNumber: typeof attemptNumber === 'number' ? attemptNumber : 0,
      outcome: 'assessment_not_produced',
      // The error itself is never surfaced: it may quote provider output.
      recorded: false,
    };
  }

  const recorded = outcome.status === 'assessment_recorded';
  await admin.rpc(WORKFLOW_ASSESSMENT_FINALIZE_FUNCTION, {
    p_attempt_id: attemptId,
    p_status: recorded ? 'succeeded' : 'failed',
    // Reason code only, never provider or intake prose.
    p_failure_class: recorded ? null : outcome.status,
  });

  return {
    status: 'attempt_completed',
    attemptId,
    submissionId: claimedSubmission,
    attemptNumber: typeof attemptNumber === 'number' ? attemptNumber : 0,
    outcome: outcome.status,
    recorded,
  };
}

export type WorkflowAssessmentSweepResult = Readonly<{
  attempted: number;
  recorded: number;
  outcomes: readonly WorkflowAssessmentExecutionResult[];
  stoppedBecause: 'batch_full' | 'nothing_claimable' | 'disabled' | 'not_configured'
    | 'claim_failed';
}>;

/**
 * One scheduled sweep: claim, assess, finalize, repeat, up to the batch cap.
 *
 * Deliberately "find next eligible, claim, process" rather than "select three
 * then process those three". A projection taken up front goes stale the moment
 * a concurrent sweep claims one of them, and acting on it would either waste
 * the batch or authorize a second call on a submission already being assessed.
 * The database claim is consulted afresh each iteration and remains the only
 * thing that authorizes provider access.
 *
 * Sequential, never parallel: three concurrent provider calls would be three
 * simultaneous costs and a much wider failure window.
 *
 * A failing submission does not abort the batch. Its attempt is recorded as
 * failed and the sweep moves to the next eligible submission, so one bad row
 * cannot starve everything behind it.
 */
export async function sweepWorkflowAssessments(): Promise<WorkflowAssessmentSweepResult> {
  const outcomes: WorkflowAssessmentExecutionResult[] = [];
  const attemptedSubmissions: string[] = [];

  for (let index = 0; index < WORKFLOW_ASSESSMENT_SWEEP_BATCH_SIZE; index += 1) {
    const result = await executeClaimedWorkflowAssessment(undefined, attemptedSubmissions);

    if (result.status !== 'attempt_completed') {
      // Nothing left to claim, or a condition that applies to the whole sweep.
      return {
        attempted: outcomes.length,
        recorded: outcomes.filter((entry) =>
          entry.status === 'attempt_completed' && entry.recorded).length,
        outcomes,
        stoppedBecause: result.status === 'nothing_claimable' ? 'nothing_claimable'
          : result.status === 'assessment_disabled' ? 'disabled'
          : result.status === 'not_configured' ? 'not_configured'
          : 'claim_failed',
      };
    }

    outcomes.push(result);
    attemptedSubmissions.push(result.submissionId);
  }

  return {
    attempted: outcomes.length,
    recorded: outcomes.filter((entry) =>
      entry.status === 'attempt_completed' && entry.recorded).length,
    outcomes,
    stoppedBecause: 'batch_full',
  };
}
