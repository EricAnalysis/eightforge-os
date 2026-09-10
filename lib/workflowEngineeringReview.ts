import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const summary = z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/.test(value));
const text = (max: number) => z.string().trim().min(1).max(max);
const evidenceRef = z.string().regex(/^ev_[a-f0-9]{64}$/);
const gate = z.discriminatedUnion('gate', [
  z.object({ gate: z.literal('evidence_test'), evidenceRef, testPath: z.string().min(1).max(500) }).strict(),
  z.object({ gate: z.enum(['typecheck', 'build']) }).strict(),
]);
const stop = z.enum(['authority_boundary_unclear', 'canonical_truth_owner_unclear', 'operator_decision_required',
  'evidence_scope_insufficient', 'repository_context_stale', 'migration_required', 'execution_authority_required']);

export const EngineeringCapabilityScopeSchema = z.enum([
  'client_specific', 'workflow_specific', 'reusable_platform_capability',
]);
export type EngineeringCapabilityScope = z.infer<typeof EngineeringCapabilityScopeSchema>;

export const ModifiedEngineeringScopeSchema = z.object({
  capabilitySummary: summary,
  summary: text(2_000),
  evidenceRefs: z.array(evidenceRef).max(20),
  architectureRisks: z.array(text(500)).max(12),
  regressionGates: z.array(gate).max(20),
  stopConditions: z.array(stop).max(12),
  unresolvedQuestions: z.array(text(500)).max(12),
}).strict();
export type ModifiedEngineeringScope = z.infer<typeof ModifiedEngineeringScopeSchema>;

const pin = {
  planV2RunId: z.string().uuid(), planV2DigestSha256: digest,
  recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/),
};
export const WorkflowEngineeringReviewInputSchema = z.discriminatedUnion('disposition', [
  z.object({ ...pin, disposition: z.literal('accepted'), capabilityScope: EngineeringCapabilityScopeSchema,
    reviewerRationale: text(4_000) }).strict(),
  z.object({ ...pin, disposition: z.literal('modified'), capabilityScope: EngineeringCapabilityScopeSchema,
    reviewerRationale: text(4_000), modifiedScope: ModifiedEngineeringScopeSchema }).strict(),
  z.object({ ...pin, disposition: z.literal('rejected'), reviewerRationale: text(4_000) }).strict(),
  z.object({ ...pin, disposition: z.literal('deferred'), reviewerRationale: text(4_000) }).strict(),
]);
export type WorkflowEngineeringReviewInput = z.infer<typeof WorkflowEngineeringReviewInputSchema>;

export const WorkflowEngineeringReviewEvidenceSchema = z.object({
  reviewId: z.string().uuid(), reviewVersion: z.number().int().positive(),
  reviewerActorId: z.string().uuid(), reviewRequestDigestSha256: digest,
  ...pin, disposition: z.enum(['accepted', 'modified', 'rejected', 'deferred']),
  capabilityScope: EngineeringCapabilityScopeSchema.nullable(), reviewerRationale: text(4_000),
  modifiedScope: ModifiedEngineeringScopeSchema.nullable(), repositoryCommitSha: z.string().regex(/^[a-f0-9]{40}$/),
}).strict().superRefine((value, ctx) => {
  const approved = value.disposition === 'accepted' || value.disposition === 'modified';
  if (approved !== (value.capabilityScope !== null)
    || (value.disposition === 'modified') !== (value.modifiedScope !== null))
    ctx.addIssue({ code: 'custom', message: 'Engineering review disposition coherence mismatch' });
});
export type WorkflowEngineeringReviewEvidence = z.infer<typeof WorkflowEngineeringReviewEvidenceSchema>;
