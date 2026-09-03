import { z } from 'zod';
import {
  composeAcceptedWorkflowProposals,
  type AcceptedWorkflowProposalSource,
} from '@/lib/workflowAssessmentProposalClosure';
import {
  REVIEWED_SPECIFICATION_SCHEMAS,
  type ReviewedClassification,
  type ReviewedSpecification,
} from '@/lib/workflowReviewedSpecification';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';

export const EFFECTIVE_REVIEWED_SPECIFICATION_DOMAIN = 'eightforge.effective-reviewed-specification' as const;
export const EFFECTIVE_REVIEWED_SPECIFICATION_VERSION = 1 as const;

const uuid = z.string().uuid();
const version = z.number().int().positive().max(2147483647);
export const effectiveReviewedSpecificationPinSchema = z.object({
  assessmentId: uuid, assessmentVersion: version, reviewId: uuid, reviewVersion: version,
}).strict();
export type EffectiveReviewedSpecificationPin = z.infer<typeof effectiveReviewedSpecificationPinSchema>;

const classification = z.enum(['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY']);
const disposition = z.enum(['accepted', 'modified', 'reclassified', 'rejected']);
const identifier = z.string().min(1).max(120).refine((value) => value.trim() === value);
const assessmentRowSchema = z.object({
  id: uuid, assessment_version: version, source_submission_id: uuid,
  assessment: z.record(z.unknown()), authority: z.literal('non_authoritative'),
  requires_human_review: z.literal(true), created_at: z.string().min(1),
}).strict();
const reviewRowSchema = z.object({
  id: uuid, assessment_id: uuid, assessment_version: version, source_submission_id: uuid,
  review_version: version, reviewer_actor_id: uuid,
  overall_disposition: z.enum(['accepted', 'changes_required', 'rejected']),
  reviewer_summary: z.string().nullable(), created_at: z.string().min(1),
}).strict();
const stepReviewRowSchema = z.object({
  id: uuid, review_id: uuid, assessment_step_id: identifier,
  proposed_classification: classification, reviewed_classification: classification.nullable(),
  disposition, reviewer_notes: z.string().nullable(),
  accepted_specification: z.record(z.unknown()).nullable(), created_at: z.string().min(1),
}).strict();
const evidenceSchema = z.object({
  pin: effectiveReviewedSpecificationPinSchema,
  assessmentRow: assessmentRowSchema, reviewRow: reviewRowSchema,
  stepReviewRows: z.array(stepReviewRowSchema),
}).strict();

export type EffectiveReviewedSpecificationFailureCode =
  | 'invalid_pin' | 'invalid_json' | 'invalid_evidence'
  | 'assessment_pin_mismatch' | 'review_pin_mismatch' | 'source_submission_mismatch'
  | 'step_review_parent_mismatch' | 'duplicate_step_review' | 'orphan_step_review'
  | 'missing_step_review' | 'classification_mismatch' | 'incoherent_disposition'
  | 'proposal_not_composable' | 'invalid_specification' | 'overall_disposition_mismatch';
export type EffectiveReviewedSpecificationFailure = Readonly<{
  ok: false;
  code: EffectiveReviewedSpecificationFailureCode;
  paths?: readonly string[];
}>;

type StepProvenance = Readonly<{
  assessmentId: string; assessmentVersion: number; sourceSubmissionId: string;
  reviewId: string; reviewVersion: number; stepReviewId: string;
  reviewerActorId: string; reviewerNotes: string | null;
}>;
type ResolvedStepBase = Readonly<{
  stepId: string;
  originalClassification: ReviewedClassification;
  provenance: StepProvenance;
}>;
export type EffectiveImplementationStep = ResolvedStepBase & Readonly<{
  disposition: 'accepted' | 'modified' | 'reclassified';
  effectiveClassification: ReviewedClassification;
  effectiveSpecification: ReviewedSpecification;
  specificationSource:
    | Readonly<{ mode: 'accepted_as_proposed'; sourceField: 'workflow_assessments.assessment'; details: readonly AcceptedWorkflowProposalSource[] }>
    | Readonly<{ mode: 'reviewed_replacement'; sourceField: 'workflow_assessment_step_reviews.accepted_specification' }>;
}>;
export type ResolvedReviewedStep = EffectiveImplementationStep | (ResolvedStepBase & Readonly<{
  disposition: 'rejected';
  effectiveClassification: null;
  effectiveSpecification: null;
  specificationSource: null;
}>);
export type EffectiveReviewedSpecificationArtifact = Readonly<{
  domain: typeof EFFECTIVE_REVIEWED_SPECIFICATION_DOMAIN;
  schemaVersion: typeof EFFECTIVE_REVIEWED_SPECIFICATION_VERSION;
  authority: 'non_authoritative'; executable: false; grantsExecutionAuthority: false;
  pin: EffectiveReviewedSpecificationPin;
  evidence: Readonly<{
    assessment: z.infer<typeof assessmentRowSchema>;
    parentReview: z.infer<typeof reviewRowSchema>;
    stepReviews: readonly z.infer<typeof stepReviewRowSchema>[];
  }>;
  steps: readonly ResolvedReviewedStep[];
  effectiveImplementationSet: readonly EffectiveImplementationStep[];
  digest: Readonly<{ algorithm: 'sha256'; encoding: 'recursive-key-sorted-json-v1'; value: string }>;
}>;
export type EffectiveReviewedSpecificationResult =
  | Readonly<{ ok: true; artifact: EffectiveReviewedSpecificationArtifact }>
  | EffectiveReviewedSpecificationFailure;

/** The hash primitive accepts only JSON values here, never JS serialization shortcuts. */
function isPlainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  if (array && (keys.length !== value.length + 1
    || Array.from({ length: value.length }, (_, i) => String(i)).some((key) => !descriptors[key]))) return false;
  ancestors.add(value);
  for (const key of keys as string[]) {
    if (array && key === 'length') continue;
    const property = descriptors[key]!;
    if (!property.enumerable || !('value' in property) || !isPlainJson(property.value, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}

/**
 * Resolve one explicitly pinned immutable evidence packet, without IO.
 * Canonical encoding denotes serialization only. See the resolver contract doc
 * for the exact digest envelope and supported JSON value domain.
 */
export function resolveEffectiveReviewedSpecification(input: unknown): EffectiveReviewedSpecificationResult {
  try {
    if (!isPlainJson(input)) return { ok: false, code: 'invalid_json' };
  } catch {
    return { ok: false, code: 'invalid_json' };
  }
  const parsed = evidenceSchema.safeParse(input);
  if (!parsed.success) return {
    ok: false, code: 'invalid_evidence',
    paths: parsed.error.issues.map((issue) => issue.path.join('.')),
  };
  // Use the caller's already JSON-checked values after validation, so the
  // artifact preserves the exact persisted jsonb evidence rather than Zod's
  // rebuilt object graph.
  const { pin, assessmentRow: assessment, reviewRow: review, stepReviewRows } =
    input as z.infer<typeof evidenceSchema>;
  if (assessment.id !== pin.assessmentId || assessment.assessment_version !== pin.assessmentVersion) {
    return { ok: false, code: 'assessment_pin_mismatch' };
  }
  if (review.id !== pin.reviewId || review.review_version !== pin.reviewVersion
    || review.assessment_id !== pin.assessmentId || review.assessment_version !== pin.assessmentVersion) {
    return { ok: false, code: 'review_pin_mismatch' };
  }
  if (review.source_submission_id !== assessment.source_submission_id) {
    return { ok: false, code: 'source_submission_mismatch' };
  }
  const byStep = new Map<string, z.infer<typeof stepReviewRowSchema>>();
  const childIds = new Set<string>();
  for (const child of stepReviewRows) {
    if (child.review_id !== review.id) return { ok: false, code: 'step_review_parent_mismatch' };
    if (byStep.has(child.assessment_step_id) || childIds.has(child.id)) return { ok: false, code: 'duplicate_step_review' };
    byStep.set(child.assessment_step_id, child);
    childIds.add(child.id);
  }
  const workflowSteps = assessment.assessment.workflowSteps;
  if (!Array.isArray(workflowSteps)) return { ok: false, code: 'proposal_not_composable' };
  const originalSteps = workflowSteps as Array<{ stepId: string; classification: ReviewedClassification }>;
  const stepIds = new Set(originalSteps.map((step) => step.stepId));
  if (stepReviewRows.some((step) => !stepIds.has(step.assessment_step_id))) return { ok: false, code: 'orphan_step_review' };
  const composed = composeAcceptedWorkflowProposals(assessment.assessment,
    stepReviewRows.filter((step) => step.disposition === 'accepted').map((step) => step.assessment_step_id));
  if (!composed.ok) return { ok: false, code: 'proposal_not_composable' };
  // Closure has validated every step's exact identifier and classification.
  const proposals = new Map(composed.proposals.map((proposal) => [proposal.stepId, proposal]));
  const steps: ResolvedReviewedStep[] = [];
  const orderedReviews: z.infer<typeof stepReviewRowSchema>[] = [];
  for (const original of originalSteps) {
    const child = byStep.get(original.stepId);
    if (!child) return { ok: false, code: 'missing_step_review' };
    if (child.proposed_classification !== original.classification) return { ok: false, code: 'classification_mismatch' };
    const provenance: StepProvenance = {
      assessmentId: assessment.id, assessmentVersion: assessment.assessment_version,
      sourceSubmissionId: assessment.source_submission_id,
      reviewId: review.id, reviewVersion: review.review_version, stepReviewId: child.id,
      reviewerActorId: review.reviewer_actor_id, reviewerNotes: child.reviewer_notes,
    };
    const base = { stepId: original.stepId, originalClassification: original.classification, provenance };
    orderedReviews.push(child);
    if (child.disposition === 'rejected') {
      if (child.reviewed_classification !== null || child.accepted_specification !== null) return { ok: false, code: 'incoherent_disposition' };
      steps.push({ ...base, disposition: 'rejected', effectiveClassification: null, effectiveSpecification: null, specificationSource: null });
      continue;
    }
    const effectiveClassification = child.reviewed_classification;
    if (effectiveClassification === null
      || (child.disposition === 'reclassified'
        ? effectiveClassification === original.classification
        : effectiveClassification !== original.classification)
      || (child.disposition === 'accepted' && child.accepted_specification !== null)
      || (child.disposition !== 'accepted' && child.accepted_specification === null)) {
      return { ok: false, code: 'incoherent_disposition' };
    }
    const proposal = proposals.get(original.stepId);
    const specification = child.disposition === 'accepted' ? proposal?.specification : child.accepted_specification;
    // Validation only: reviewed schemas trim parsed output. Retain exact stored values.
    if (!REVIEWED_SPECIFICATION_SCHEMAS[effectiveClassification].safeParse(specification).success) {
      return { ok: false, code: 'invalid_specification' };
    }
    steps.push({
      ...base, disposition: child.disposition, effectiveClassification,
      effectiveSpecification: specification as ReviewedSpecification,
      specificationSource: child.disposition === 'accepted'
        ? { mode: 'accepted_as_proposed', sourceField: 'workflow_assessments.assessment', details: proposal!.sources }
        : { mode: 'reviewed_replacement', sourceField: 'workflow_assessment_step_reviews.accepted_specification' },
    });
  }
  const overall = steps.every((step) => step.disposition === 'accepted') ? 'accepted'
    : steps.every((step) => step.disposition === 'rejected') ? 'rejected' : 'changes_required';
  if (overall !== review.overall_disposition) return { ok: false, code: 'overall_disposition_mismatch' };
  const envelope = {
    domain: EFFECTIVE_REVIEWED_SPECIFICATION_DOMAIN, schemaVersion: EFFECTIVE_REVIEWED_SPECIFICATION_VERSION,
    authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
    pin, evidence: { assessment, parentReview: review, stepReviews: orderedReviews }, steps,
    effectiveImplementationSet: steps.filter((step): step is EffectiveImplementationStep => step.disposition !== 'rejected'),
  };
  // Detach from caller-owned references and stabilize output object key insertion
  // order as well as the digest. Arrays retain their explicitly defined order.
  const stableEnvelope = JSON.parse(canonicalJson(envelope)) as typeof envelope;
  return { ok: true, artifact: {
    ...stableEnvelope,
    digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(envelope) },
  } };
}
