// lib/server/workflowAssessmentReviewRead.ts
// Read seam for the operator review surface.
//
// Two reads, both strictly read-only: the pending queue, and the immutable
// packet for one assessment. Neither mutates anything, and neither returns raw
// provider output — the assessment they expose was validated against the strict
// schema before it was ever persisted.
//
// Reviewability is derived, never stored. An assessment is pending exactly when
// no review exists for that precise (assessment_id, assessment_version); the
// database computes that, so the queue cannot drift from the evidence.
//
// Nothing here is executable. The packet describes a proposal and an operator's
// judgement of it; no field carries a rule, expression, or runtime artifact.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { loadWorkflowIntakeSubmission } from '@/lib/server/workflowIntakeRead';

/**
 * Table names, restated rather than imported.
 *
 * The assessment and review seams are each confined by an architecture guard to
 * one authorized consumer. Importing either to reuse a string constant would
 * widen a boundary for a name, and importing the module would also hand this
 * read-only seam the write function it must never call. The companion test
 * imports the canonical constants and asserts these match, so a rename fails
 * loudly rather than silently querying a table that no longer exists.
 */
const WORKFLOW_ASSESSMENT_TABLE = 'workflow_assessments' as const;
export const WORKFLOW_ASSESSMENT_REVIEW_TABLE = 'workflow_assessment_reviews' as const;
export const WORKFLOW_ASSESSMENT_STEP_REVIEW_TABLE =
  'workflow_assessment_step_reviews' as const;

export const WORKFLOW_REVIEW_QUEUE_FUNCTION =
  'read_workflow_assessment_review_queue' as const;

export type WorkflowReviewQueueRow = Readonly<{
  assessmentId: string;
  assessmentVersion: number;
  sourceSubmissionId: string;
  createdAt: string;
  summary: string | null;
  stepCount: number;
  qualifiedDeterministicCount: number;
  humanDecisionCount: number;
  reviewState: 'pending_review';
}>;

export type WorkflowReviewQueueResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; rows: readonly WorkflowReviewQueueRow[] }>;

export type WorkflowReviewStepRecord = Readonly<{
  assessmentStepId: string;
  proposedClassification: string;
  reviewedClassification: string | null;
  disposition: string;
  reviewerNotes: string | null;
  acceptedSpecification: Record<string, unknown> | null;
}>;

export type WorkflowExistingReview = Readonly<{
  reviewId: string;
  reviewVersion: number;
  overallDisposition: string;
  reviewerSummary: string | null;
  reviewerActorId: string;
  createdAt: string;
  stepReviews: readonly WorkflowReviewStepRecord[];
}>;

/** Everything the review surface needs, and nothing it does not. */
export type WorkflowReviewPacket = Readonly<{
  assessmentId: string;
  assessmentVersion: number;
  sourceSubmissionId: string;
  createdAt: string;
  /** Pinned literals from the persisted row, not recomputed here. */
  authority: string;
  requiresHumanReview: boolean;
  intake: Readonly<Record<string, string>>;
  assessment: Record<string, unknown>;
  existingReview: WorkflowExistingReview | null;
}>;

export type WorkflowReviewPacketResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'assessment_not_found' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; packet: WorkflowReviewPacket }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * The pending queue, newest first.
 *
 * The projection is computed in the database so assessment payloads never cross
 * this boundary for a list view.
 */
export async function readWorkflowReviewQueue(
  limit = 50,
): Promise<WorkflowReviewQueueResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const { data, error } = await admin.rpc(WORKFLOW_REVIEW_QUEUE_FUNCTION, {
    p_limit: limit,
  });
  if (error) return { status: 'read_failed', reason: error.message };

  const rows = (Array.isArray(data) ? data : []).flatMap((row): WorkflowReviewQueueRow[] => {
    if (!isRecord(row)) return [];
    const assessmentId = str(row.assessment_id);
    const sourceSubmissionId = str(row.source_submission_id);
    const createdAt = str(row.created_at);
    if (!assessmentId || !sourceSubmissionId || !createdAt) return [];
    return [{
      assessmentId,
      assessmentVersion: num(row.assessment_version),
      sourceSubmissionId,
      createdAt,
      summary: str(row.summary),
      stepCount: num(row.step_count),
      qualifiedDeterministicCount: num(row.qualified_deterministic_count),
      humanDecisionCount: num(row.human_decision_count),
      reviewState: 'pending_review',
    }];
  });

  return { status: 'ok', rows };
}

/**
 * One immutable review packet: what the user described, what Forgewing
 * proposed, and any review already recorded against this exact version.
 *
 * `existingReview` is what makes the surface read-only after submission: a
 * completed review is evidence, and the page renders it rather than offering to
 * edit it.
 */
export async function readWorkflowReviewPacket(
  assessmentId: string,
): Promise<WorkflowReviewPacketResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const assessmentRow = await admin
    .from(WORKFLOW_ASSESSMENT_TABLE)
    .select('id, source_submission_id, assessment_version, assessment, authority,'
      + ' requires_human_review, created_at')
    .eq('id', assessmentId)
    .maybeSingle();
  if (assessmentRow.error) {
    return { status: 'read_failed', reason: assessmentRow.error.message };
  }
  const row = assessmentRow.data;
  if (!isRecord(row) || !isRecord(row.assessment)) return { status: 'assessment_not_found' };

  const sourceSubmissionId = str(row.source_submission_id);
  const createdAt = str(row.created_at);
  if (!sourceSubmissionId || !createdAt) return { status: 'assessment_not_found' };

  // The intake is read through the same SECURITY DEFINER seam the assessment
  // itself used; the table grants INSERT only, so there is no other path.
  const submission = await loadWorkflowIntakeSubmission(sourceSubmissionId, admin);
  if (!submission) return { status: 'assessment_not_found' };

  const assessmentVersion = num(row.assessment_version);

  const reviewRow = await admin
    .from(WORKFLOW_ASSESSMENT_REVIEW_TABLE)
    .select('id, review_version, overall_disposition, reviewer_summary,'
      + ' reviewer_actor_id, created_at')
    .eq('assessment_id', assessmentId)
    .eq('assessment_version', assessmentVersion)
    .order('review_version', { ascending: false })
    .limit(1);
  if (reviewRow.error) return { status: 'read_failed', reason: reviewRow.error.message };

  const review = Array.isArray(reviewRow.data) ? reviewRow.data[0] : null;
  let existingReview: WorkflowExistingReview | null = null;

  if (isRecord(review) && typeof review.id === 'string') {
    const stepRows = await admin
      .from(WORKFLOW_ASSESSMENT_STEP_REVIEW_TABLE)
      .select('assessment_step_id, proposed_classification, reviewed_classification,'
        + ' disposition, reviewer_notes, accepted_specification')
      .eq('review_id', review.id);
    if (stepRows.error) return { status: 'read_failed', reason: stepRows.error.message };

    existingReview = {
      reviewId: review.id,
      reviewVersion: num(review.review_version),
      overallDisposition: str(review.overall_disposition) ?? 'unknown',
      reviewerSummary: str(review.reviewer_summary),
      reviewerActorId: str(review.reviewer_actor_id) ?? '',
      createdAt: str(review.created_at) ?? '',
      stepReviews: (Array.isArray(stepRows.data) ? stepRows.data : [])
        .flatMap((step): WorkflowReviewStepRecord[] => {
          if (!isRecord(step)) return [];
          const stepId = str(step.assessment_step_id);
          if (!stepId) return [];
          return [{
            assessmentStepId: stepId,
            proposedClassification: str(step.proposed_classification) ?? '',
            reviewedClassification: str(step.reviewed_classification),
            disposition: str(step.disposition) ?? '',
            reviewerNotes: str(step.reviewer_notes),
            acceptedSpecification: isRecord(step.accepted_specification)
              ? step.accepted_specification
              : null,
          }];
        }),
    };
  }

  return {
    status: 'ok',
    packet: {
      assessmentId,
      assessmentVersion,
      sourceSubmissionId,
      createdAt,
      authority: str(row.authority) ?? 'non_authoritative',
      requiresHumanReview: row.requires_human_review !== false,
      intake: submission.answers,
      assessment: row.assessment,
      existingReview,
    },
  };
}
