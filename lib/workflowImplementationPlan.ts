import { z } from 'zod';
import type {
  EffectiveReviewedSpecificationArtifact,
  EffectiveImplementationStep,
  ResolvedReviewedStep,
} from '@/lib/workflowEffectiveReviewedSpecification';
import { REVIEWED_SPECIFICATION_SCHEMAS, type ReviewedClassification } from '@/lib/workflowReviewedSpecification';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';

export type ImplementationReadiness =
  | Readonly<{ state: 'specification_complete' }>
  | Readonly<{ state: 'blocked_structural'; blocker: 'rule_definition_is_code' | 'no_organization_for_task' }>
  | Readonly<{ state: 'requires_operator_decision'; decision: 'source_document_taxonomy' | 'recovery_vocabulary_unresolved' }>;

const READINESS: Readonly<Record<ReviewedClassification, ImplementationReadiness>> = {
  RULE: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
  VERIFY: { state: 'blocked_structural', blocker: 'rule_definition_is_code' },
  HUMAN: { state: 'blocked_structural', blocker: 'no_organization_for_task' },
  EXTRACT: { state: 'requires_operator_decision', decision: 'source_document_taxonomy' },
  RECOVER: { state: 'requires_operator_decision', decision: 'recovery_vocabulary_unresolved' },
  ADVISORY: { state: 'specification_complete' },
};

export type PlannedImplementationStep = Readonly<{
  stepId: string;
  effectiveClassification: ReviewedClassification;
  specification: EffectiveImplementationStep['effectiveSpecification'];
  provenance: EffectiveImplementationStep['provenance'];
  originalClassification: EffectiveImplementationStep['originalClassification'];
  disposition: EffectiveImplementationStep['disposition'];
  specificationSource: EffectiveImplementationStep['specificationSource'];
  implementationReadiness: ImplementationReadiness;
}>;
export type WorkflowImplementationPlanArtifact = Readonly<{
  domain: 'eightforge.implementation-plan'; schemaVersion: 1;
  authority: 'non_authoritative'; executable: false; grantsExecutionAuthority: false;
  source: Readonly<{
    pin: EffectiveReviewedSpecificationArtifact['pin'];
    effectiveReviewedSpecificationDigestSha256: string;
  }>;
  plannedSteps: readonly PlannedImplementationStep[];
  rejectedSteps: readonly Extract<ResolvedReviewedStep, { disposition: 'rejected' }>[];
  digest: EffectiveReviewedSpecificationArtifact['digest'];
}>;
export type WorkflowImplementationPlanResult =
  | Readonly<{ ok: true; artifact: WorkflowImplementationPlanArtifact }>
  | Readonly<{ ok: false; code: 'invalid_artifact' }>;

// Validate the consumed projection, without re-running the evidence resolver.
const uuid = z.string().uuid();
const version = z.number().int().positive().max(2147483647);
const pinSchema = z.object({ assessmentId: uuid, assessmentVersion: version, reviewId: uuid, reviewVersion: version }).strict();
const classification = z.enum(['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY']);
const identifier = z.string().min(1).max(120).refine((value) => value.trim() === value);
const provenance = z.object({
  assessmentId: uuid, assessmentVersion: version, sourceSubmissionId: uuid,
  reviewId: uuid, reviewVersion: version, stepReviewId: uuid,
  reviewerActorId: uuid, reviewerNotes: z.string().nullable(),
}).strict();
const base = { stepId: identifier, originalClassification: classification, provenance };
const effectiveStepSchema = z.object({
  ...base, disposition: z.enum(['accepted', 'modified', 'reclassified']),
  effectiveClassification: classification, effectiveSpecification: z.record(z.unknown()),
  specificationSource: z.union([
    z.object({ mode: z.literal('accepted_as_proposed'), sourceField: z.literal('workflow_assessments.assessment'),
      details: z.array(z.object({ collection: z.string().min(1), identityField: z.string().min(1), detailId: z.string().min(1) }).strict()).min(1),
    }).strict(),
    z.object({ mode: z.literal('reviewed_replacement'), sourceField: z.literal('workflow_assessment_step_reviews.accepted_specification') }).strict(),
  ]),
}).strict();
const rejectedStepSchema = z.object({ ...base, disposition: z.literal('rejected'),
  effectiveClassification: z.null(), effectiveSpecification: z.null(), specificationSource: z.null(),
}).strict();
const artifactSchema = z.object({
  domain: z.literal('eightforge.effective-reviewed-specification'), schemaVersion: z.literal(1),
  authority: z.literal('non_authoritative'), executable: z.literal(false), grantsExecutionAuthority: z.literal(false),
  pin: pinSchema,
  evidence: z.object({ assessment: z.record(z.unknown()), parentReview: z.record(z.unknown()),
    stepReviews: z.array(z.record(z.unknown())), }).strict(),
  steps: z.array(z.union([effectiveStepSchema, rejectedStepSchema])),
  effectiveImplementationSet: z.array(effectiveStepSchema),
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'),
    value: z.string().regex(/^[a-f0-9]{64}$/), }).strict(),
}).strict();

// Reject non-JSON values before validation/serialization can silently alter them.
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

/** Pure projection of one resolver artifact. A digest pins identity, not authority. */
export function buildWorkflowImplementationPlan(input: EffectiveReviewedSpecificationArtifact): WorkflowImplementationPlanResult {
  try {
    if (!isPlainJson(input) || !artifactSchema.safeParse(input).success) return { ok: false, code: 'invalid_artifact' };
    const ids = new Set<string>();
    const reviewIds = new Set<string>();
    for (const step of input.steps) {
      const p = step.provenance;
      if (ids.has(step.stepId) || reviewIds.has(p.stepReviewId)
        || p.assessmentId !== input.pin.assessmentId || p.assessmentVersion !== input.pin.assessmentVersion
        || p.reviewId !== input.pin.reviewId || p.reviewVersion !== input.pin.reviewVersion) return { ok: false, code: 'invalid_artifact' };
      ids.add(step.stepId);
      reviewIds.add(p.stepReviewId);
      if (step.disposition === 'rejected') continue;
      if (!REVIEWED_SPECIFICATION_SCHEMAS[step.effectiveClassification].safeParse(step.effectiveSpecification).success
        || (step.disposition === 'reclassified'
          ? step.originalClassification === step.effectiveClassification
          : step.originalClassification !== step.effectiveClassification)
        || (step.disposition === 'accepted') !== (step.specificationSource.mode === 'accepted_as_proposed')) return { ok: false, code: 'invalid_artifact' };
    }
    // Check exact projection closure, without deriving specifications from evidence.
    if (canonicalJson(input.effectiveImplementationSet) !== canonicalJson(input.steps.filter((step) => step.disposition !== 'rejected'))) {
      return { ok: false, code: 'invalid_artifact' };
    }
    const plannedSteps = input.effectiveImplementationSet.map((step): PlannedImplementationStep => ({
      stepId: step.stepId, effectiveClassification: step.effectiveClassification,
      specification: step.effectiveSpecification, provenance: step.provenance,
      originalClassification: step.originalClassification, disposition: step.disposition,
      specificationSource: step.specificationSource,
      implementationReadiness: READINESS[step.effectiveClassification],
    }));
    const envelope = {
      domain: 'eightforge.implementation-plan' as const, schemaVersion: 1 as const,
      authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
      source: { pin: input.pin, effectiveReviewedSpecificationDigestSha256: input.digest.value },
      plannedSteps,
      rejectedSteps: input.steps.filter((step): step is Extract<ResolvedReviewedStep, { disposition: 'rejected' }> => step.disposition === 'rejected'),
    };
    const stableEnvelope = JSON.parse(canonicalJson(envelope)) as typeof envelope;
    return { ok: true, artifact: { ...stableEnvelope,
      digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(envelope) },
    } };
  } catch {
    return { ok: false, code: 'invalid_artifact' };
  }
}
