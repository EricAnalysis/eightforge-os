import { z } from 'zod';

// Transport structure only. Never import the planner, resolver, or transforming
// review-input schemas here. Server-output parity is exercised in tests.
const uuid = z.string().uuid();
const version = z.number().int().positive().max(2147483647);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ImplementationPlanPinSchema = z.object({
  assessmentId: uuid, assessmentVersion: version, reviewId: uuid, reviewVersion: version,
}).strict();
const classification = z.enum(['RULE', 'VERIFY', 'EXTRACT', 'RECOVER', 'HUMAN', 'ADVISORY']);
const provenance = z.object({
  assessmentId: uuid, assessmentVersion: version, reviewId: uuid, reviewVersion: version,
  sourceSubmissionId: uuid, stepReviewId: uuid, reviewerActorId: uuid,
  reviewerNotes: z.string().nullable(),
}).strict();
const specificationSource = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('accepted_as_proposed'),
    sourceField: z.literal('workflow_assessments.assessment'),
    details: z.array(z.object({ collection: z.string().min(1), identityField: z.string().min(1),
      detailId: z.string().min(1) }).strict()).min(1),
  }).strict(),
  z.object({ mode: z.literal('reviewed_replacement'),
    sourceField: z.literal('workflow_assessment_step_reviews.accepted_specification'),
  }).strict(),
]);
const readiness = z.discriminatedUnion('state', [
  z.object({ state: z.literal('specification_complete') }).strict(),
  z.object({ state: z.literal('blocked_structural'),
    blocker: z.enum(['rule_definition_is_code', 'no_organization_for_task']) }).strict(),
  z.object({ state: z.literal('requires_operator_decision'),
    decision: z.enum(['source_document_taxonomy', 'recovery_vocabulary_unresolved']) }).strict(),
]);
const ruleSpecification = z.object({
  plainLanguageRule: z.string(), requiredFacts: z.array(z.string()),
  conditionType: z.enum(['comparison', 'calculation', 'presence_check', 'date_range',
    'identity_match', 'duplicate_detection', 'precedence']),
  expectedEvidence: z.array(z.string()), expectedOutcome: z.string(),
  userDescribedExceptions: z.array(z.string()), unresolvedAssumptions: z.array(z.string()),
}).strict();
const baseStep = { stepId: z.string().min(1).max(120), originalClassification: classification, provenance };
const plannedBase = { ...baseStep, disposition: z.enum(['accepted', 'modified', 'reclassified']),
  specificationSource, implementationReadiness: readiness };
const plannedStep = z.discriminatedUnion('effectiveClassification', [
  z.object({ ...plannedBase, effectiveClassification: z.literal('RULE'), specification: ruleSpecification }).strict(),
  z.object({ ...plannedBase, effectiveClassification: z.literal('VERIFY'), specification: ruleSpecification }).strict(),
  z.object({ ...plannedBase, effectiveClassification: z.literal('EXTRACT'), specification: z.object({
    describedFact: z.string(), sourceDocument: z.string(), deterministicExtractionPlausible: z.boolean(),
  }).strict() }).strict(),
  z.object({ ...plannedBase, effectiveClassification: z.literal('RECOVER'), specification: z.object({
    describedFact: z.string(), sourceDocument: z.string(), description: z.string(), deterministicShortfall: z.string(),
  }).strict() }).strict(),
  z.object({ ...plannedBase, effectiveClassification: z.literal('HUMAN'), specification: z.object({
    description: z.string(), whyHumanControlled: z.string(),
  }).strict() }).strict(),
  z.object({ ...plannedBase, effectiveClassification: z.literal('ADVISORY'), specification: z.object({
    description: z.string(),
  }).strict() }).strict(),
]);
const rejectedStep = z.object({ ...baseStep, disposition: z.literal('rejected'),
  effectiveClassification: z.null(), effectiveSpecification: z.null(), specificationSource: z.null(),
}).strict();
export const BrowserSafeImplementationPlanSchema = z.object({
  domain: z.literal('eightforge.implementation-plan'), schemaVersion: z.literal(1),
  authority: z.literal('non_authoritative'), executable: z.literal(false), grantsExecutionAuthority: z.literal(false),
  source: z.object({ pin: ImplementationPlanPinSchema,
    effectiveReviewedSpecificationDigestSha256: digest }).strict(),
  plannedSteps: z.array(plannedStep), rejectedSteps: z.array(rejectedStep),
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: digest }).strict(),
}).strict().superRefine((plan, context) => {
  // Validate identity consistency only; never resolve or rebuild provenance.
  const stepIds = new Set<string>();
  const stepReviewIds = new Set<string>();
  for (const collection of ['plannedSteps', 'rejectedSteps'] as const) {
    plan[collection].forEach((step, index) => {
      if (!pinsEqual(plan.source.pin, step.provenance)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [collection, index, 'provenance'],
          message: 'Provenance pin does not match source pin' });
      }
      if (stepIds.has(step.stepId) || stepReviewIds.has(step.provenance.stepReviewId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [collection, index],
          message: 'Duplicate step identity' });
      }
      stepIds.add(step.stepId);
      stepReviewIds.add(step.provenance.stepReviewId);
    });
  }
});
export const ImplementationPlanFailureCodeSchema = z.enum([
  'unauthorized', 'reviewer_not_eligible', 'invalid_pin', 'assessment_not_found', 'review_not_found',
  'invalid_json', 'invalid_evidence', 'assessment_pin_mismatch', 'review_pin_mismatch',
  'source_submission_mismatch', 'step_review_parent_mismatch', 'duplicate_step_review', 'orphan_step_review',
  'missing_step_review', 'classification_mismatch', 'incoherent_disposition', 'proposal_not_composable',
  'invalid_specification', 'overall_disposition_mismatch', 'not_configured', 'plan_not_composable', 'read_failed',
]);
export const ImplementationPlanResponseSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), plan: BrowserSafeImplementationPlanSchema }).strict(),
  z.object({ ok: z.literal(false), error: ImplementationPlanFailureCodeSchema }).strict(),
]);
export type BrowserSafeImplementationPlan = z.infer<typeof BrowserSafeImplementationPlanSchema>;
export type ImplementationPlanResponse = z.infer<typeof ImplementationPlanResponseSchema>;
export type ImplementationPlanPin = z.infer<typeof ImplementationPlanPinSchema>;
export type ImplementationPlanFailureCode = z.infer<typeof ImplementationPlanFailureCodeSchema>;

export function pinsEqual(requested: ImplementationPlanPin, returned: ImplementationPlanPin): boolean {
  return requested.assessmentId === returned.assessmentId
    && requested.assessmentVersion === returned.assessmentVersion
    && requested.reviewId === returned.reviewId
    && requested.reviewVersion === returned.reviewVersion;
}
