// lib/server/workflowAssessmentReview.ts
// Server seam for recording an operator's review of a workflow assessment.
//
// A review is a judgement ABOUT an immutable proposal, never an edit of it.
// This module writes only through public.record_workflow_assessment_review,
// the SECURITY DEFINER function that is the sole writer of both review tables:
// neither table grants INSERT to any role, so validation and the derived
// overall disposition cannot be bypassed by a future caller.
//
// The reviewed assessment row is never touched. `workflow_assessments` is
// CHECK-pinned and trigger-protected, and nothing here attempts to update it.
//
// `accepted` means accepted as SYSTEM SPECIFICATION. It is not deployment and
// not an executable rule. No production reader consumes review rows, and
// recording one changes no production behavior.

import { z } from 'zod';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import {
  buildReviewedSpecification,
  type ReviewedClassification,
} from '@/lib/server/workflowReviewedSpecification';
import { resolveWorkflowReviewEligibility } from '@/lib/workflowReviewEligibility';

export const WORKFLOW_ASSESSMENT_REVIEW_TABLE = 'workflow_assessment_reviews' as const;
export const WORKFLOW_ASSESSMENT_STEP_REVIEW_TABLE =
  'workflow_assessment_step_reviews' as const;
export const WORKFLOW_ASSESSMENT_REVIEW_WRITE_FUNCTION =
  'record_workflow_assessment_review' as const;

export const WORKFLOW_STEP_DISPOSITIONS = [
  'accepted', 'reclassified', 'modified', 'rejected',
] as const;

export const WORKFLOW_REVIEW_CLASSIFICATIONS = [
  'RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY',
] as const;

export type WorkflowStepDisposition = (typeof WORKFLOW_STEP_DISPOSITIONS)[number];
export type WorkflowOverallDisposition = 'accepted' | 'changes_required' | 'rejected';

const classification = z.enum(WORKFLOW_REVIEW_CLASSIFICATIONS);
const notes = z.string().trim().min(1).max(4000);

/**
 * One disposition per proposed step.
 *
 * The four shapes are mutually exclusive by construction, mirroring the
 * database coherence constraint. Encoding them as a discriminated union means
 * an incoherent review — "rejected" carrying an accepted specification, or a
 * "reclassified" whose reviewed classification equals the proposal — cannot be
 * built in TypeScript, let alone sent.
 */
const stepId = z.string().trim().min(1).max(120);

// The union members stay plain objects because zod's discriminatedUnion only
// accepts ZodObject; the cross-field rules are applied to the union itself.
const stepReviewSchema = z.discriminatedUnion('disposition', [
  z.object({
    disposition: z.literal('accepted'),
    assessmentStepId: stepId,
    proposedClassification: classification,
    reviewedClassification: classification,
    reviewerNotes: notes.optional(),
  }).strict(),
  z.object({
    disposition: z.literal('reclassified'),
    assessmentStepId: stepId,
    proposedClassification: classification,
    reviewedClassification: classification,
    reviewerNotes: notes,
    // Shape is validated against the REVIEWED classification below, not here:
    // which schema applies depends on what the operator settled on.
    acceptedSpecification: z.record(z.unknown()).optional(),
  }).strict(),
  z.object({
    disposition: z.literal('modified'),
    assessmentStepId: stepId,
    proposedClassification: classification,
    reviewedClassification: classification,
    reviewerNotes: notes,
    // Required: "modified" with nothing changed is just "accepted".
    acceptedSpecification: z.record(z.unknown()),
  }).strict(),
  z.object({
    disposition: z.literal('rejected'),
    assessmentStepId: stepId,
    proposedClassification: classification,
    reviewerNotes: notes,
  }).strict(),
]).superRefine((step, ctx) => {
  // Mirrors the database coherence constraint, so an incoherent review is
  // rejected at the seam rather than surfacing as a constraint violation.
  const changed = step.disposition !== 'rejected'
    && step.reviewedClassification !== step.proposedClassification;
  if (step.disposition === 'accepted' && changed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewedClassification'],
      message: 'accepted requires the reviewed classification to equal the proposal',
    });
  }
  if (step.disposition === 'modified' && changed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewedClassification'],
      message: 'modified keeps the classification; use reclassified to change it',
    });
  }
  if (step.disposition === 'reclassified' && !changed) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reviewedClassification'],
      message: 'reclassified requires a classification that differs from the proposal',
    });
  }
});

/**
 * The review request carries the decision, never the identity of the person
 * making it.
 *
 * There is deliberately no reviewer field. `.strict()` means supplying one is
 * rejected rather than ignored: a row saying "user X approved this
 * specification" must mean X was authenticated, not that a caller typed X's
 * uuid. Reviewer identity arrives separately, resolved from the operator's
 * session — see SessionDerivedReviewer.
 */
export const workflowAssessmentReviewInputSchema = z.object({
  assessmentId: z.string().uuid(),
  assessmentVersion: z.number().int().min(1),
  reviewerSummary: z.string().trim().min(1).max(4000).optional(),
  // Bounded to the assessment's own step ceiling.
  stepReviews: z.array(stepReviewSchema).min(1).max(40),
}).strict();

/**
 * A reviewer resolved from an authenticated session, never from a payload.
 *
 * The only correct way to obtain one is from `getActorContext`, which validates
 * the caller's JWT through Supabase Auth and loads the matching user_profiles
 * row. This is a distinct argument rather than a request field so that reviewer
 * identity cannot travel through the same channel a caller controls.
 */
export type SessionDerivedReviewer = Readonly<{
  actorId: string;
  /** The role on the reviewer's user_profiles row, for the eligibility recheck. */
  role: string | null;
}>;

export type WorkflowAssessmentReviewInput =
  z.infer<typeof workflowAssessmentReviewInputSchema>;

export type WorkflowAssessmentReviewResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'input_invalid'; reason: string }>
  | Readonly<{ status: 'reviewer_unresolved' }>
  | Readonly<{ status: 'reviewer_not_eligible'; reason: string }>
  | Readonly<{ status: 'specification_invalid'; reason: string }>
  | Readonly<{ status: 'duplicate_step_review'; reason: string }>
  | Readonly<{ status: 'assessment_not_found' }>
  | Readonly<{ status: 'review_rejected'; reason: string }>
  | Readonly<{ status: 'persist_failed'; reason: string }>
  | Readonly<{
      status: 'review_recorded';
      reviewId: string;
      reviewVersion: number;
      overallDisposition: WorkflowOverallDisposition;
      stepReviewCount: number;
      /** A recorded review never executes anything. Pinned, not reported. */
      executable: false;
    }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Postgres surfaces the pinned-version failure as no_data_found. */
const ASSESSMENT_MISSING = /no workflow assessment/i;
/** The reviewer FK: a reviewer id with no user_profiles row. */
const REVIEWER_UNKNOWN = /reviewer_actor_id_fkey|workflow assessment reviewer/i;
/** Coverage, step identity, and proposed-classification mismatches. */
const REVIEW_REJECTED =
  /must disposition every proposed step|absent from assessment|must be a json array/i;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records one review of one pinned assessment version.
 *
 * `reviewer` must come from the authenticated session, not the request body.
 * There is no loader, writer, or admin-client override, so a production caller
 * cannot substitute the validated write path.
 *
 * `service_role` remains the database execution mechanism, but it is never the
 * identity: the recorded reviewer is the authenticated human, and if one cannot
 * be established this fails closed rather than attributing the review to the
 * service account.
 */
export async function recordWorkflowAssessmentReview(
  input: WorkflowAssessmentReviewInput,
  reviewer: SessionDerivedReviewer,
): Promise<WorkflowAssessmentReviewResult> {
  // Defence in depth: the route resolves this from the session, so a malformed
  // value means the identity path itself is broken. Recording the review anyway
  // would preserve a false attribution immutably.
  if (!reviewer || typeof reviewer.actorId !== 'string' || !UUID.test(reviewer.actorId)) {
    return { status: 'reviewer_unresolved' };
  }

  // Authorization is rechecked here, not only at the route. Hiding an action in
  // a UI is convenience; this is the server-side authority, and it holds for
  // any caller the architecture guard permits.
  const eligibility = resolveWorkflowReviewEligibility(reviewer.role);
  if (!eligibility.eligible) {
    return { status: 'reviewer_not_eligible', reason: eligibility.reason };
  }

  const parsed = workflowAssessmentReviewInputSchema.safeParse(input);
  if (!parsed.success) {
    // Issue paths only. Reviewer prose describes a visitor's business process
    // and is never logged or echoed from here.
    return {
      status: 'input_invalid',
      reason: parsed.error.issues.map((issue) => issue.path.join('.')).join(',') || 'invalid',
    };
  }

  // One disposition per step. The database enforces this too, via the unique
  // index on (review_id, assessment_step_id); catching it here turns a
  // constraint violation into a named result.
  const stepIds = parsed.data.stepReviews.map((step) => step.assessmentStepId);
  if (new Set(stepIds).size !== stepIds.length) {
    return { status: 'duplicate_step_review', reason: 'assessmentStepId repeated' };
  }

  // Reviewed specifications are rebuilt from typed schemas, never passed
  // through. Which schema applies is decided by the REVIEWED classification:
  // a RULE downgraded to HUMAN must carry a human-decision specification, or a
  // rejected automation could survive in the rule shape that was refused.
  const specifications = new Map<string, Record<string, unknown>>();
  for (const step of parsed.data.stepReviews) {
    if (step.disposition !== 'modified' && step.disposition !== 'reclassified') continue;
    if (step.acceptedSpecification === undefined) continue;
    const built = buildReviewedSpecification(
      step.reviewedClassification as ReviewedClassification,
      step.acceptedSpecification,
    );
    if (!built.ok) {
      return {
        status: 'specification_invalid',
        reason: `${step.assessmentStepId}:${built.reason}`,
      };
    }
    specifications.set(step.assessmentStepId, built.specification);
  }

  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const { data, error } = await admin.rpc(WORKFLOW_ASSESSMENT_REVIEW_WRITE_FUNCTION, {
    p_assessment_id: parsed.data.assessmentId,
    p_assessment_version: parsed.data.assessmentVersion,
    // Session-derived, never from the request body.
    p_reviewer_actor_id: reviewer.actorId,
    p_reviewer_summary: parsed.data.reviewerSummary ?? null,
    p_step_reviews: parsed.data.stepReviews.map((step) => ({
      assessment_step_id: step.assessmentStepId,
      proposed_classification: step.proposedClassification,
      reviewed_classification:
        step.disposition === 'rejected' ? null : step.reviewedClassification,
      disposition: step.disposition,
      reviewer_notes: step.reviewerNotes ?? null,
      // Only the deterministically constructed object reaches the database.
      accepted_specification: specifications.get(step.assessmentStepId) ?? null,
    })),
  });

  if (error) {
    if (ASSESSMENT_MISSING.test(error.message)) return { status: 'assessment_not_found' };
    // A reviewer the database does not recognise is an identity failure, not a
    // generic persistence failure.
    if (REVIEWER_UNKNOWN.test(error.message)) return { status: 'reviewer_unresolved' };
    if (REVIEW_REJECTED.test(error.message)) {
      return { status: 'review_rejected', reason: error.message };
    }
    return { status: 'persist_failed', reason: error.message };
  }

  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)
    || typeof row.review_id !== 'string'
    || typeof row.review_version !== 'number'
    || typeof row.overall_disposition !== 'string') {
    return { status: 'persist_failed', reason: 'review_write_returned_no_row' };
  }

  return {
    status: 'review_recorded',
    reviewId: row.review_id,
    reviewVersion: row.review_version,
    overallDisposition: row.overall_disposition as WorkflowOverallDisposition,
    stepReviewCount: typeof row.step_review_count === 'number'
      ? row.step_review_count
      : parsed.data.stepReviews.length,
    executable: false,
  };
}
