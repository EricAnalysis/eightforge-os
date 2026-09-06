import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { RepositoryAwareImplementationPlanV2Schema,
  type RepositoryAwareImplementationPlanV2Artifact } from '@/lib/repositoryAwareImplementationPlan';
import { WorkflowEngineeringReviewEvidenceSchema,
  type WorkflowEngineeringReviewEvidence } from '@/lib/workflowEngineeringReview';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const approvedScopeSchema = z.object({
  capabilitySummary: z.string().trim().min(1).max(120).refine((value) => !/[\r\n]/.test(value)),
  summary: z.string().min(1).max(2_000), evidenceRefs: z.array(z.string().regex(/^ev_[a-f0-9]{64}$/)).max(20),
  architectureRisks: z.array(z.string().min(1).max(500)).max(12),
  regressionGates: z.array(z.union([
    z.object({ gate: z.literal('evidence_test'), evidenceRef: z.string().regex(/^ev_[a-f0-9]{64}$/), testPath: z.string().min(1).max(500) }).strict(),
    z.object({ gate: z.enum(['typecheck', 'build']) }).strict(),
  ])).max(20),
  stopConditions: z.array(z.string()).max(12), unresolvedQuestions: z.array(z.string().min(1).max(500)).max(12),
}).strict();
const envelopeSchema = z.object({
  domain: z.literal('eightforge.approved-engineering-request'), schemaVersion: z.literal(1),
  authorizes: z.literal('backlog_projection'), executable: z.literal(false), grantsExecutionAuthority: z.literal(false),
  authorizesCodeExecution: z.literal(false), authorizesRepositoryWrites: z.literal(false),
  authorizesMigrations: z.literal(false), authorizesDeployment: z.literal(false),
  authorizesCanonicalFactMutation: z.literal(false), authorizesWorkflowOperationalDecision: z.literal(false),
  source: z.object({ planV2RunId: z.string().uuid(), planV2DigestSha256: sha256,
    recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/), reviewId: z.string().uuid(),
    reviewVersion: z.number().int().positive(), reviewRequestDigestSha256: sha256,
    repositoryCommitSha: z.string().regex(/^[a-f0-9]{40}$/) }).strict(),
  capabilitySummary: approvedScopeSchema.shape.capabilitySummary,
  approvedScope: approvedScopeSchema, scopeSource: z.enum(['forgewing_recommendation', 'human_reviewed_replacement']),
  capabilityScope: z.enum(['client_specific', 'workflow_specific', 'reusable_platform_capability']),
  reviewer: z.object({ actorId: z.string().uuid(), rationale: z.string().min(1).max(4_000),
    disposition: z.enum(['accepted', 'modified']) }).strict(),
}).strict();
export const ApprovedEngineeringRequestSchema = envelopeSchema.extend({
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: sha256 }).strict(),
}).superRefine((artifact, ctx) => {
  const { digest, ...envelope } = artifact;
  if (hashCanonical(envelope) !== digest.value) ctx.addIssue({ code: 'custom', message: 'Approved request digest mismatch' });
});
export type ApprovedEngineeringRequest = z.infer<typeof ApprovedEngineeringRequestSchema>;

export type BuildApprovedEngineeringRequestResult =
  | Readonly<{ ok: true; request: ApprovedEngineeringRequest }>
  | Readonly<{ ok: false; code: 'invalid_plan_v2' | 'invalid_review' | 'identity_mismatch'
    | 'not_approved' | 'recommendation_not_found' | 'modified_scope_invalid' }>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Pure exact-pin composition. Neither the Plan V2 nor its review is mutated. */
export function buildApprovedEngineeringRequest(
  planV2: RepositoryAwareImplementationPlanV2Artifact,
  review: WorkflowEngineeringReviewEvidence,
): BuildApprovedEngineeringRequestResult {
  const plan = RepositoryAwareImplementationPlanV2Schema.safeParse(planV2);
  const parsedReview = WorkflowEngineeringReviewEvidenceSchema.safeParse(review);
  if (!plan.success) return { ok: false, code: 'invalid_plan_v2' };
  if (!parsedReview.success) return { ok: false, code: 'invalid_review' };
  const r = parsedReview.data;
  if (r.planV2RunId.length === 0 || r.planV2DigestSha256 !== plan.data.digest.value
    || r.repositoryCommitSha !== plan.data.source.repositorySnapshot.commitSha)
    return { ok: false, code: 'identity_mismatch' };
  if (r.disposition === 'rejected' || r.disposition === 'deferred') return { ok: false, code: 'not_approved' };
  const recommendation = plan.data.guidance.recommendations.find((entry) => entry.recommendationId === r.recommendationId);
  if (!recommendation) return { ok: false, code: 'recommendation_not_found' };
  const originalScope = { capabilitySummary: recommendation.capabilitySummary, summary: recommendation.summary,
    evidenceRefs: recommendation.evidenceRefs, architectureRisks: recommendation.architectureRisks,
    regressionGates: recommendation.regressionGates, stopConditions: recommendation.stopConditions,
    unresolvedQuestions: recommendation.unresolvedQuestions };
  const approvedScope = r.disposition === 'modified' ? r.modifiedScope! : originalScope;
  const allowedEvidence = new Set(recommendation.evidenceRefs);
  if (!approvedScope.evidenceRefs.every((id) => allowedEvidence.has(id))
    || approvedScope.regressionGates.some((gate) => gate.gate === 'evidence_test' && !allowedEvidence.has(gate.evidenceRef)))
    return { ok: false, code: 'modified_scope_invalid' };
  const envelope = { domain: 'eightforge.approved-engineering-request' as const, schemaVersion: 1 as const,
    authorizes: 'backlog_projection' as const, executable: false as const, grantsExecutionAuthority: false as const,
    authorizesCodeExecution: false as const, authorizesRepositoryWrites: false as const,
    authorizesMigrations: false as const, authorizesDeployment: false as const,
    authorizesCanonicalFactMutation: false as const, authorizesWorkflowOperationalDecision: false as const,
    source: { planV2RunId: r.planV2RunId, planV2DigestSha256: r.planV2DigestSha256,
      recommendationId: r.recommendationId, reviewId: r.reviewId, reviewVersion: r.reviewVersion,
      reviewRequestDigestSha256: r.reviewRequestDigestSha256, repositoryCommitSha: r.repositoryCommitSha },
    capabilitySummary: approvedScope.capabilitySummary, approvedScope,
    scopeSource: r.disposition === 'modified' ? 'human_reviewed_replacement' as const : 'forgewing_recommendation' as const,
    capabilityScope: r.capabilityScope!, reviewer: { actorId: r.reviewerActorId,
      rationale: r.reviewerRationale, disposition: r.disposition } };
  const request = { ...envelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
  return { ok: true, request: freeze(JSON.parse(canonicalJson(request)) as ApprovedEngineeringRequest) };
}
