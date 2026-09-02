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
): Promise<WorkflowAssessmentExecutionResult> {
  // Checked before the claim: a disabled deployment must not create attempt
  // rows, let alone approach the provider.
  if (!isWorkflowAssessmentEnabled()) return { status: 'assessment_disabled' };

  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const claim = await admin.rpc(WORKFLOW_ASSESSMENT_CLAIM_FUNCTION, {
    p_max_attempts: WORKFLOW_ASSESSMENT_MAX_ATTEMPTS,
    p_submission_id: submissionId ?? null,
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
