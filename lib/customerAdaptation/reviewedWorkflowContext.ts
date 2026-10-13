import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import {
  resolveEffectiveReviewedSpecification,
  type EffectiveReviewedSpecificationArtifact,
} from '@/lib/workflowEffectiveReviewedSpecification';

export type ReviewedWorkflowAdaptationContext = Readonly<{
  domain: 'eightforge.reviewed-workflow-adaptation-context';
  schemaVersion: 1;
  authority: 'non_authoritative';
  executable: false;
  grantsExecutionAuthority: false;
  grantsMappingActivationAuthority: false;
  requiresSeparateAdaptationApproval: true;
  source: Readonly<{
    pin: EffectiveReviewedSpecificationArtifact['pin'];
    effectiveReviewedSpecificationDigestSha256: string;
  }>;
  reviewedSteps: EffectiveReviewedSpecificationArtifact['effectiveImplementationSet'];
  digest: EffectiveReviewedSpecificationArtifact['digest'];
}>;

export type ReviewedWorkflowAdaptationContextResult =
  | Readonly<{ ok: true; context: ReviewedWorkflowAdaptationContext }>
  | Readonly<{ ok: false; code: 'invalid_reviewed_artifact' | 'no_reviewed_context' }>;

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/**
 * Proposal context only. Re-resolve the immutable evidence and compare the full
 * artifact before projecting; a typed object or a digest alone is not a review.
 * Only effective step specifications are reviewed. Top-level provider summary,
 * intake answers and tenant identity are deliberately absent from this seam.
 */
export function buildReviewedWorkflowAdaptationContext(
  input: unknown,
): ReviewedWorkflowAdaptationContextResult {
  try {
    if (input === null || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, code: 'invalid_reviewed_artifact' };
    }
    const artifact = input as EffectiveReviewedSpecificationArtifact;
    const resolved = resolveEffectiveReviewedSpecification({
      pin: artifact.pin,
      assessmentRow: artifact.evidence?.assessment,
      reviewRow: artifact.evidence?.parentReview,
      stepReviewRows: artifact.evidence?.stepReviews,
    });
    if (!resolved.ok || canonicalJson(input) !== canonicalJson(resolved.artifact)) {
      return { ok: false, code: 'invalid_reviewed_artifact' };
    }
    if (resolved.artifact.effectiveImplementationSet.length === 0) {
      return { ok: false, code: 'no_reviewed_context' };
    }
    const envelope = {
      domain: 'eightforge.reviewed-workflow-adaptation-context' as const,
      schemaVersion: 1 as const,
      authority: 'non_authoritative' as const,
      executable: false as const,
      grantsExecutionAuthority: false as const,
      grantsMappingActivationAuthority: false as const,
      requiresSeparateAdaptationApproval: true as const,
      source: { pin: resolved.artifact.pin,
        effectiveReviewedSpecificationDigestSha256: resolved.artifact.digest.value },
      reviewedSteps: resolved.artifact.effectiveImplementationSet,
    };
    return { ok: true, context: freeze({ ...envelope,
      digest: { algorithm: 'sha256' as const,
        encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } }) };
  } catch {
    return { ok: false, code: 'invalid_reviewed_artifact' };
  }
}
