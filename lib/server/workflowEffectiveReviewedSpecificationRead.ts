import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';
import {
  effectiveReviewedSpecificationPinSchema,
  resolveEffectiveReviewedSpecification,
} from '@/lib/workflowEffectiveReviewedSpecification';

type ReadFailureCode = 'unauthorized' | 'reviewer_not_eligible' | 'not_configured'
  | 'read_failed' | 'assessment_not_found' | 'review_not_found' | 'invalid_pin';

export type EffectiveReviewedSpecificationReadResult =
  | ReturnType<typeof resolveEffectiveReviewedSpecification>
  | Readonly<{ ok: false; code: ReadFailureCode }>;

/**
 * Resolve one explicitly pinned immutable review for a verified platform actor.
 * The three evidence tables already grant service_role SELECT. This seam uses
 * only those reads; immutable parent/child linkage supplies a stable snapshot
 * without choosing a latest review or loading the source intake submission.
 * Raw persisted values reach the pure resolver unchanged, including malformed
 * evidence that it must reject rather than repair.
 */
export async function readEffectiveReviewedSpecification(
  request: Request,
  pin: unknown,
): Promise<EffectiveReviewedSpecificationReadResult> {
  try {
    const context = await getActorContext(request);
    if (!context.ok) {
      return { ok: false, code: context.status === 503 ? 'not_configured' : 'unauthorized' };
    }
    if (!resolveWorkflowPlatformReviewAccess(context.actor).allowed) {
      return { ok: false, code: 'reviewer_not_eligible' };
    }

    const parsed = effectiveReviewedSpecificationPinSchema.safeParse(pin);
    if (!parsed.success) return { ok: false, code: 'invalid_pin' };
    const admin = getSupabaseAdmin();
    if (!admin) return { ok: false, code: 'not_configured' };

    const assessment = await admin.from('workflow_assessments')
      .select('id, assessment_version, source_submission_id, assessment, authority, requires_human_review, created_at')
      .eq('id', parsed.data.assessmentId)
      .eq('assessment_version', parsed.data.assessmentVersion)
      .maybeSingle();
    if (assessment.error) return { ok: false, code: 'read_failed' };
    if (assessment.data === null) return { ok: false, code: 'assessment_not_found' };

    const review = await admin.from('workflow_assessment_reviews')
      .select('id, assessment_id, assessment_version, source_submission_id, review_version, reviewer_actor_id, overall_disposition, reviewer_summary, created_at')
      .eq('id', parsed.data.reviewId)
      .eq('review_version', parsed.data.reviewVersion)
      .eq('assessment_id', parsed.data.assessmentId)
      .eq('assessment_version', parsed.data.assessmentVersion)
      .maybeSingle();
    if (review.error) return { ok: false, code: 'read_failed' };
    if (review.data === null) return { ok: false, code: 'review_not_found' };

    const steps = await admin.from('workflow_assessment_step_reviews')
      .select('id, review_id, assessment_step_id, proposed_classification, reviewed_classification, disposition, reviewer_notes, accepted_specification, created_at')
      .eq('review_id', parsed.data.reviewId);
    if (steps.error) return { ok: false, code: 'read_failed' };

    return resolveEffectiveReviewedSpecification({
      pin: parsed.data,
      assessmentRow: assessment.data,
      reviewRow: review.data,
      stepReviewRows: steps.data,
    });
  } catch {
    // Database/auth transport details may contain sensitive evidence. Expose a
    // typed failure, never a partial artifact or raw exception message.
    return { ok: false, code: 'read_failed' };
  }
}
