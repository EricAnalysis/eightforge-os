import { z } from 'zod';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { RepositoryPlanContentSchema, repositoryContentEvidenceId, type RepositoryPlanContentArtifact } from '@/lib/repositoryPlanContent';
import { RepositoryPlanFoundationSchema, type RepositoryPlanFoundationArtifact } from '@/lib/repositoryPlanFoundation';
import { RepositoryClassificationSchema, type RepositoryClassification } from '@/lib/repositoryPlanEvidence';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import { BrowserSafeImplementationPlanSchema } from '@/lib/workflowImplementationPlanWire';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceId = z.string().regex(/^ev_[a-f0-9]{64}$/);
const boundedText = (maximum: number) => z.string().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(value),
    'Unsafe control or directional character');
const capabilitySummarySchema = boundedText(120)
  .refine((value) => value.trim() === value && !/[\r\n]/u.test(value), 'Capability summary must be one trimmed line');

export const REPOSITORY_PLAN_GUIDANCE_LIMITS = Object.freeze({
  maxFiles: 20 as const,
  maxBytesPerFile: 16_384 as const,
  maxTotalContentBytes: 196_608 as const,
  maxSteps: 40 as const,
  maxRawOutputBytes: 262_144 as const,
});

const recommendationKinds = {
  RULE: ['reuse_existing_rule', 'extend_existing_rule', 'add_new_authored_rule', 'rule_engine_architecture_gap'],
  VERIFY: ['reuse_existing_rule', 'extend_existing_rule', 'add_new_authored_rule', 'rule_engine_architecture_gap'],
  EXTRACT: ['existing_document_type_context', 'extraction_seam_candidate', 'operator_taxonomy_decision_still_required'],
  RECOVER: ['reuse_recovery_pattern', 'recovery_architecture_gap', 'operator_recovery_decision_still_required'],
  HUMAN: ['task_authority_gap', 'organization_identity_unresolved'],
  ADVISORY: ['no_implementation_required'],
} as const satisfies Record<RepositoryClassification, readonly string[]>;

export const RepositoryPlanRecommendationKindSchema = z.enum([
  'reuse_existing_rule', 'extend_existing_rule', 'add_new_authored_rule', 'rule_engine_architecture_gap',
  'existing_document_type_context', 'extraction_seam_candidate', 'operator_taxonomy_decision_still_required',
  'reuse_recovery_pattern', 'recovery_architecture_gap', 'operator_recovery_decision_still_required',
  'task_authority_gap', 'organization_identity_unresolved', 'no_implementation_required',
]);
export type RepositoryPlanRecommendationKind = z.infer<typeof RepositoryPlanRecommendationKindSchema>;

const regressionGateSchema = z.discriminatedUnion('gate', [
  z.object({ gate: z.literal('evidence_test'), evidenceRef: evidenceId }).strict(),
  z.object({ gate: z.enum(['typecheck', 'build']) }).strict(),
]);
const stopConditionSchema = z.enum([
  'authority_boundary_unclear', 'canonical_truth_owner_unclear', 'operator_decision_required',
  'evidence_scope_insufficient', 'repository_context_stale', 'migration_required',
  'execution_authority_required',
]);
const stepGuidanceSchema = z.object({
  stepId: boundedText(120),
  recommendationKind: RepositoryPlanRecommendationKindSchema,
  recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/),
  capabilitySummary: capabilitySummarySchema,
  summary: boundedText(2_000),
  evidenceRefs: z.array(evidenceId).max(20),
  existingSeamEvaluation: z.enum(['existing_seam_cited', 'no_existing_seam_found_in_bounded_evidence']),
  architectureRisks: z.array(boundedText(500)).max(12),
  regressionGates: z.array(regressionGateSchema).max(20),
  stopConditions: z.array(stopConditionSchema).max(12),
  unresolvedQuestions: z.array(boundedText(500)).max(12),
}).strict();
const operatorSuggestionSchema = z.object({
  stepId: boundedText(120),
  decisionType: z.enum(['source_document_taxonomy', 'recovery_vocabulary_unresolved']),
  suggestedValue: boundedText(500),
  rationale: boundedText(1_000),
  evidenceRefs: z.array(evidenceId).min(1).max(20),
}).strict();

/** Strict raw provider contract. Authority literals are absent; recommendation IDs must match B2a candidates. */
export const RepositoryPlanGuidanceModelOutputSchema = z.object({
  classification: RepositoryClassificationSchema,
  stepGuidance: z.array(stepGuidanceSchema).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
  operatorDecisionSuggestions: z.array(operatorSuggestionSchema).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
  unresolvedGlobalQuestions: z.array(boundedText(500)).max(20),
  insufficientEvidence: z.array(z.object({ stepId: boundedText(120),
    reason: z.literal('no_eligible_repository_evidence') }).strict()).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
}).strict();
export type RepositoryPlanGuidanceModelOutput = z.infer<typeof RepositoryPlanGuidanceModelOutputSchema>;

const providerStepSchema = z.object({
  stepId: boundedText(120),
  classification: RepositoryClassificationSchema,
  implementationReadiness: z.record(z.unknown()),
  specification: z.record(z.unknown()),
  recommendationCandidates: z.array(z.object({ recommendationKind: RepositoryPlanRecommendationKindSchema,
    recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/) }).strict()).min(1).max(4),
}).strict();
const providerFileSchema = z.object({
  evidenceId, filePath: z.string().min(1).max(500), blobSha: z.string().regex(/^[a-f0-9]{40}$/),
  commitSha: z.string().regex(/^[a-f0-9]{40}$/),
  roles: z.array(z.enum(['source', 'relevant_test'])).min(1).max(2),
  contentTrust: z.literal('untrusted_repository_data'), contentEncoding: z.literal('utf8'),
  byteLength: z.number().int().nonnegative().max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxBytesPerFile),
  contentSha256: sha256, content: z.string(),
}).strict();
const preparedEnvelopeSchema = z.object({
  domain: z.literal('eightforge.repository-plan-guidance-input'), schemaVersion: z.literal(1),
  stage: z.literal('provider_input_prepared'), authority: z.literal('non_authoritative'),
  executable: z.literal(false), grantsExecutionAuthority: z.literal(false), requiresHumanReview: z.literal(true),
  repositoryContentTrust: z.literal('untrusted_repository_data'),
  source: z.object({
    implementationPlanV1DigestSha256: sha256, effectiveReviewedSpecificationDigestSha256: sha256,
    foundationDigestSha256: sha256, contentBundleDigestSha256: sha256,
    reviewPin: z.object({ assessmentId: z.string().uuid(), assessmentVersion: z.number().int().positive(),
      reviewId: z.string().uuid(), reviewVersion: z.number().int().positive() }).strict(),
    repositorySnapshot: RepositoryPlanContentSchema.innerType().shape.repositorySnapshot,
  }).strict(),
  classification: RepositoryClassificationSchema,
  steps: z.array(providerStepSchema).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
  repositoryContent: z.object({
    contentTrust: z.literal('untrusted_repository_data'), files: z.array(providerFileSchema).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxFiles),
  }).strict(),
  budget: z.object({
    maxFiles: z.literal(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxFiles),
    maxBytesPerFile: z.literal(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxBytesPerFile),
    maxTotalContentBytes: z.literal(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxTotalContentBytes),
    maxSteps: z.literal(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
    selectedFiles: z.number().int().nonnegative(), selectedContentBytes: z.number().int().nonnegative(),
    selectedSteps: z.number().int().nonnegative(),
  }).strict(),
}).strict();
export const RepositoryPlanGuidanceInputSchema = preparedEnvelopeSchema.extend({
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: sha256 }).strict(),
}).superRefine((artifact, ctx) => {
  const { digest, ...envelope } = artifact;
  if (hashCanonical(envelope) !== digest.value) ctx.addIssue({ code: 'custom', message: 'Guidance input digest mismatch' });
  const bytes = artifact.repositoryContent.files.reduce((total, file) => total + file.byteLength, 0);
  if (artifact.budget.selectedFiles !== artifact.repositoryContent.files.length
    || artifact.budget.selectedSteps !== artifact.steps.length || artifact.budget.selectedContentBytes !== bytes)
    ctx.addIssue({ code: 'custom', message: 'Guidance input counters mismatch' });
  const expectedOrder = [...artifact.repositoryContent.files].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
  if (!same(artifact.repositoryContent.files, expectedOrder)
    || new Set(artifact.repositoryContent.files.map((file) => file.evidenceId)).size !== artifact.repositoryContent.files.length)
    ctx.addIssue({ code: 'custom', message: 'Guidance evidence order or identity mismatch' });
  for (const file of artifact.repositoryContent.files) {
    if (file.commitSha !== artifact.source.repositorySnapshot.commitSha
      || file.evidenceId !== repositoryContentEvidenceId({ commitSha: file.commitSha,
        classification: artifact.classification, filePath: file.filePath, blobSha: file.blobSha })
      || file.byteLength !== new TextEncoder().encode(file.content).byteLength
      || file.contentSha256 !== sha256Hex(file.content))
      ctx.addIssue({ code: 'custom', message: 'Guidance evidence content mismatch' });
  }
});
export type RepositoryPlanGuidanceInputArtifact = z.infer<typeof RepositoryPlanGuidanceInputSchema>;

export type PrepareRepositoryPlanGuidanceInput = Readonly<{
  trustedPlanV1: WorkflowImplementationPlanArtifact;
  foundation: RepositoryPlanFoundationArtifact;
  content: RepositoryPlanContentArtifact;
}>;
export type PrepareRepositoryPlanGuidanceResult =
  | Readonly<{ ok: true; status: 'ready' | 'advisory' | 'insufficient_evidence'; artifact: RepositoryPlanGuidanceInputArtifact }>
  | Readonly<{ ok: false; code: 'invalid_source' | 'source_identity_mismatch' | 'evidence_budget_exceeded' }>;

function same(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

/** Pure B2a seam. It consumes only already-trusted B1/B1.5 artifacts and never reads a repository. */
export function prepareRepositoryPlanGuidance(input: PrepareRepositoryPlanGuidanceInput): PrepareRepositoryPlanGuidanceResult {
  try {
    const plan = BrowserSafeImplementationPlanSchema.safeParse(input.trustedPlanV1);
    const foundation = RepositoryPlanFoundationSchema.safeParse(input.foundation);
    const content = RepositoryPlanContentSchema.safeParse(input.content);
    if (!plan.success || !foundation.success || !content.success) return { ok: false, code: 'invalid_source' };
    const { digest, ...planEnvelope } = plan.data;
    if (hashCanonical(planEnvelope) !== digest.value) return { ok: false, code: 'invalid_source' };
    const f = foundation.data; const c = content.data;
    if (f.source.implementationPlanV1.digestSha256 !== digest.value
      || f.source.effectiveReviewedSpecificationDigestSha256 !== plan.data.source.effectiveReviewedSpecificationDigestSha256
      || !same(f.source.reviewPin, plan.data.source.pin)
      || c.sourceFoundationDigestSha256 !== f.digest.value
      || !same(c.repositorySnapshot, f.source.repositorySnapshot)) return { ok: false, code: 'source_identity_mismatch' };
    if (plan.data.plannedSteps.length > REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps)
      return { ok: false, code: 'evidence_budget_exceeded' };
    const steps = plan.data.plannedSteps.filter((step) => step.effectiveClassification === c.classification)
      .map((step) => ({ stepId: step.stepId, classification: step.effectiveClassification,
        implementationReadiness: step.implementationReadiness, specification: step.specification,
        recommendationCandidates: recommendationKinds[c.classification].map((recommendationKind) => ({ recommendationKind,
          recommendationId: repositoryPlanRecommendationId(digest.value, c.classification, step.stepId, recommendationKind) })) }));
    if (steps.length === 0) return { ok: false, code: 'source_identity_mismatch' };
    const files = [...c.files].sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    const ids = new Set(files.map((file) => file.evidenceId));
    const selectedContentBytes = files.reduce((total, file) => total + file.byteLength, 0);
    if (ids.size !== files.length || files.length > REPOSITORY_PLAN_GUIDANCE_LIMITS.maxFiles
      || files.some((file) => file.byteLength > REPOSITORY_PLAN_GUIDANCE_LIMITS.maxBytesPerFile)
      || selectedContentBytes > REPOSITORY_PLAN_GUIDANCE_LIMITS.maxTotalContentBytes)
      return { ok: false, code: 'evidence_budget_exceeded' };
    const envelope = {
      domain: 'eightforge.repository-plan-guidance-input' as const, schemaVersion: 1 as const,
      stage: 'provider_input_prepared' as const, authority: 'non_authoritative' as const,
      executable: false as const, grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
      repositoryContentTrust: 'untrusted_repository_data' as const,
      source: { implementationPlanV1DigestSha256: digest.value,
        effectiveReviewedSpecificationDigestSha256: plan.data.source.effectiveReviewedSpecificationDigestSha256,
        foundationDigestSha256: f.digest.value, contentBundleDigestSha256: c.digest.value,
        reviewPin: plan.data.source.pin, repositorySnapshot: c.repositorySnapshot },
      classification: c.classification, steps,
      repositoryContent: { contentTrust: 'untrusted_repository_data' as const,
        files: files.map(({ mode: _mode, ...file }) => file) },
      budget: { maxFiles: REPOSITORY_PLAN_GUIDANCE_LIMITS.maxFiles,
        maxBytesPerFile: REPOSITORY_PLAN_GUIDANCE_LIMITS.maxBytesPerFile,
        maxTotalContentBytes: REPOSITORY_PLAN_GUIDANCE_LIMITS.maxTotalContentBytes,
        maxSteps: REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps, selectedFiles: files.length,
        selectedContentBytes, selectedSteps: steps.length },
    };
    const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
      encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
    const parsed = RepositoryPlanGuidanceInputSchema.safeParse(artifact);
    if (!parsed.success) return { ok: false, code: 'invalid_source' };
    const status = c.classification === 'ADVISORY' ? 'advisory' : files.length === 0 ? 'insufficient_evidence' : 'ready';
    return { ok: true, status, artifact: freeze(JSON.parse(canonicalJson(artifact)) as RepositoryPlanGuidanceInputArtifact) };
  } catch { return { ok: false, code: 'invalid_source' }; }
}

const resolvedGateSchema = z.discriminatedUnion('gate', [
  z.object({ gate: z.literal('evidence_test'), evidenceRef: evidenceId, testPath: z.string().min(1).max(500) }).strict(),
  z.object({ gate: z.enum(['typecheck', 'build']) }).strict(),
]);
const validatedRecommendationSchema = stepGuidanceSchema.omit({ regressionGates: true, recommendationId: true }).extend({
  recommendationId: z.string().regex(/^rec_[a-f0-9]{64}$/), regressionGates: z.array(resolvedGateSchema).max(20),
}).strict();
const validatedEnvelopeSchema = z.object({
  domain: z.literal('eightforge.repository-plan-guidance'), schemaVersion: z.literal(1),
  stage: z.literal('provider_output_validated'), authority: z.literal('non_authoritative'),
  executable: z.literal(false), grantsExecutionAuthority: z.literal(false), requiresHumanReview: z.literal(true),
  sourceGuidanceInputDigestSha256: sha256, sourceImplementationPlanV1DigestSha256: sha256,
  classification: RepositoryClassificationSchema,
  recommendations: z.array(validatedRecommendationSchema).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
  operatorDecisionSuggestions: z.array(operatorSuggestionSchema.extend({
    requiresHumanConfirmation: z.literal(true), status: z.literal('suggested_not_decided'),
  }).strict()).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
  unresolvedGlobalQuestions: z.array(boundedText(500)).max(20),
  insufficientEvidence: z.array(z.object({ stepId: boundedText(120),
    reason: z.literal('no_eligible_repository_evidence') }).strict()).max(REPOSITORY_PLAN_GUIDANCE_LIMITS.maxSteps),
}).strict();
export const RepositoryPlanGuidanceSchema = validatedEnvelopeSchema.extend({
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: sha256 }).strict(),
}).superRefine((artifact, ctx) => {
  const { digest, ...envelope } = artifact;
  if (hashCanonical(envelope) !== digest.value) ctx.addIssue({ code: 'custom', message: 'Guidance digest mismatch' });
  const recommendationIds = new Set<string>();
  const stepIds = new Set<string>();
  for (const recommendation of artifact.recommendations) {
    if (recommendationIds.has(recommendation.recommendationId) || stepIds.has(recommendation.stepId)
      || recommendation.recommendationId !== repositoryPlanRecommendationId(
        artifact.sourceImplementationPlanV1DigestSha256, artifact.classification,
        recommendation.stepId, recommendation.recommendationKind))
      ctx.addIssue({ code: 'custom', message: 'Recommendation identity mismatch' });
    recommendationIds.add(recommendation.recommendationId); stepIds.add(recommendation.stepId);
  }
});
export type RepositoryPlanGuidanceArtifact = z.infer<typeof RepositoryPlanGuidanceSchema>;
export type ValidateRepositoryPlanGuidanceResult =
  | Readonly<{ ok: true; artifact: RepositoryPlanGuidanceArtifact }>
  | Readonly<{ ok: false; code: 'invalid_input' | 'output_too_large' | 'invalid_model_output' | 'step_coverage_mismatch'
    | 'recommendation_kind_mismatch' | 'evidence_reference_invalid' | 'existing_seam_invariant_failed'
    | 'operator_suggestion_invalid' | 'prohibited_output' }>;

const prohibited = /```|^\s*(?:diff --git|@@|(?:create|alter|drop)\s+(?:table|function|policy)|(?:npm|npx|git|bash|sh|pwsh|powershell|curl|kubectl|vercel)\s|import\s.+\sfrom\s|export\s+(?:const|function|class)\s|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=|(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\()|\b(?:approval (?:is )?granted|approved for (?:build|execution)|grants execution authority|canonical truth (?:is|becomes)|execute this plan|deploy now|codex[, :]\s*(?:implement|execute)|generate (?:a )?(?:patch|diff))\b/im;
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}

export function repositoryPlanRecommendationId(inputDigest: string, classification: RepositoryClassification,
  stepId: string, recommendationKind: RepositoryPlanRecommendationKind): string {
  return `rec_${hashCanonical({ domain: 'eightforge.repository-plan-recommendation', schemaVersion: 1,
    inputDigest, classification, stepId, recommendationKind })}`;
}

/** Validates one raw model result without retry or fallback and stamps all authority literals. */
export function validateRepositoryPlanGuidance(input: RepositoryPlanGuidanceInputArtifact,
  rawOutput: unknown): ValidateRepositoryPlanGuidanceResult {
  const prepared = RepositoryPlanGuidanceInputSchema.safeParse(input);
  if (!prepared.success || prepared.data.classification === 'ADVISORY' || prepared.data.repositoryContent.files.length === 0)
    return { ok: false, code: 'invalid_input' };
  let rawBytes: number;
  try { rawBytes = new TextEncoder().encode(typeof rawOutput === 'string' ? rawOutput : JSON.stringify(rawOutput)).byteLength; }
  catch { return { ok: false, code: 'invalid_model_output' }; }
  if (rawBytes > REPOSITORY_PLAN_GUIDANCE_LIMITS.maxRawOutputBytes) return { ok: false, code: 'output_too_large' };
  let candidate = rawOutput;
  if (typeof rawOutput === 'string') {
    try { candidate = JSON.parse(rawOutput) as unknown; }
    catch { return { ok: false, code: 'invalid_model_output' }; }
  }
  const parsed = RepositoryPlanGuidanceModelOutputSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, code: 'invalid_model_output' };
  const output = parsed.data;
  if (output.classification !== prepared.data.classification) return { ok: false, code: 'step_coverage_mismatch' };
  if (strings(output).some((value) => prohibited.test(value))) return { ok: false, code: 'prohibited_output' };
  const expectedSteps = prepared.data.steps.map((step) => step.stepId).sort();
  const actualSteps = output.stepGuidance.map((step) => step.stepId).sort();
  if (new Set(actualSteps).size !== actualSteps.length || !same(expectedSteps, actualSteps))
    return { ok: false, code: 'step_coverage_mismatch' };
  const insufficientSteps = output.insufficientEvidence.map((entry) => entry.stepId);
  if (new Set(insufficientSteps).size !== insufficientSteps.length
    || insufficientSteps.some((stepId) => !expectedSteps.includes(stepId)))
    return { ok: false, code: 'step_coverage_mismatch' };
  const evidence = new Map(prepared.data.repositoryContent.files.map((file) => [file.evidenceId, file]));
  const recommendations = [] as z.infer<typeof validatedRecommendationSchema>[];
  for (const guidance of output.stepGuidance) {
    if (!(recommendationKinds[output.classification] as readonly string[]).includes(guidance.recommendationKind))
      return { ok: false, code: 'recommendation_kind_mismatch' };
    if (new Set(guidance.evidenceRefs).size !== guidance.evidenceRefs.length
      || guidance.evidenceRefs.some((id) => !evidence.has(id))) return { ok: false, code: 'evidence_reference_invalid' };
    const citesSource = guidance.evidenceRefs.some((id) => evidence.get(id)?.roles.includes('source'));
    if ((guidance.existingSeamEvaluation === 'existing_seam_cited') !== citesSource
      || (guidance.existingSeamEvaluation === 'no_existing_seam_found_in_bounded_evidence' && guidance.evidenceRefs.length > 0))
      return { ok: false, code: 'existing_seam_invariant_failed' };
    const gates = guidance.regressionGates.map((gate) => {
      if (gate.gate !== 'evidence_test') return gate;
      const file = evidence.get(gate.evidenceRef);
      if (!file || !file.roles.includes('relevant_test') || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file.filePath)) return null;
      return { ...gate, testPath: file.filePath };
    });
    if (gates.some((gate) => gate === null)) return { ok: false, code: 'evidence_reference_invalid' };
    const expectedRecommendationId = repositoryPlanRecommendationId(
      prepared.data.source.implementationPlanV1DigestSha256, output.classification, guidance.stepId, guidance.recommendationKind);
    if (guidance.recommendationId !== expectedRecommendationId) return { ok: false, code: 'invalid_model_output' };
    recommendations.push({ ...guidance, recommendationId: expectedRecommendationId,
      regressionGates: gates as z.infer<typeof resolvedGateSchema>[],
    });
  }
  const stepReadiness = new Map(prepared.data.steps.map((step) => [step.stepId, step.implementationReadiness]));
  const suggestionSteps = new Set<string>();
  for (const suggestion of output.operatorDecisionSuggestions) {
    const readiness = stepReadiness.get(suggestion.stepId) as { state?: unknown; decision?: unknown } | undefined;
    if (!readiness || suggestionSteps.has(suggestion.stepId) || readiness.state !== 'requires_operator_decision'
      || readiness.decision !== suggestion.decisionType || suggestion.evidenceRefs.some((id) => !evidence.has(id))
      || new Set(suggestion.evidenceRefs).size !== suggestion.evidenceRefs.length)
      return { ok: false, code: 'operator_suggestion_invalid' };
    suggestionSteps.add(suggestion.stepId);
  }
  const envelope = {
    domain: 'eightforge.repository-plan-guidance' as const, schemaVersion: 1 as const,
    stage: 'provider_output_validated' as const, authority: 'non_authoritative' as const,
    executable: false as const, grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
    sourceGuidanceInputDigestSha256: prepared.data.digest.value,
    sourceImplementationPlanV1DigestSha256: prepared.data.source.implementationPlanV1DigestSha256,
    classification: output.classification,
    recommendations, operatorDecisionSuggestions: output.operatorDecisionSuggestions.map((suggestion) => ({ ...suggestion,
      requiresHumanConfirmation: true as const, status: 'suggested_not_decided' as const })),
    unresolvedGlobalQuestions: output.unresolvedGlobalQuestions, insufficientEvidence: output.insufficientEvidence,
  };
  const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
  if (!RepositoryPlanGuidanceSchema.safeParse(artifact).success) return { ok: false, code: 'invalid_model_output' };
  return { ok: true, artifact: freeze(JSON.parse(canonicalJson(artifact)) as RepositoryPlanGuidanceArtifact) };
}

/** ADVISORY is deterministic and never requires a provider invocation. */
export function buildAdvisoryRepositoryPlanGuidance(input: RepositoryPlanGuidanceInputArtifact): ValidateRepositoryPlanGuidanceResult {
  const parsed = RepositoryPlanGuidanceInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.classification !== 'ADVISORY') return { ok: false, code: 'invalid_input' };
  const recommendations = parsed.data.steps.map((step) => ({ stepId: step.stepId,
    recommendationKind: 'no_implementation_required' as const, capabilitySummary: 'No implementation required',
    summary: 'The reviewed advisory step requires no repository implementation.', evidenceRefs: [],
    existingSeamEvaluation: 'no_existing_seam_found_in_bounded_evidence' as const,
    architectureRisks: [], regressionGates: [], stopConditions: [], unresolvedQuestions: [],
    recommendationId: repositoryPlanRecommendationId(parsed.data.source.implementationPlanV1DigestSha256,
      'ADVISORY', step.stepId, 'no_implementation_required') }));
  const envelope = { domain: 'eightforge.repository-plan-guidance' as const, schemaVersion: 1 as const,
    stage: 'provider_output_validated' as const, authority: 'non_authoritative' as const, executable: false as const,
    grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
    sourceGuidanceInputDigestSha256: parsed.data.digest.value,
    sourceImplementationPlanV1DigestSha256: parsed.data.source.implementationPlanV1DigestSha256,
    classification: 'ADVISORY' as const,
    recommendations, operatorDecisionSuggestions: [], unresolvedGlobalQuestions: [], insufficientEvidence: [] };
  const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
  return { ok: true, artifact: freeze(JSON.parse(canonicalJson(artifact)) as RepositoryPlanGuidanceArtifact) };
}

/** Missing bounded evidence is a complete deterministic outcome, not a reason to call a provider. */
export function buildInsufficientEvidenceRepositoryPlanGuidance(
  input: RepositoryPlanGuidanceInputArtifact,
): ValidateRepositoryPlanGuidanceResult {
  const parsed = RepositoryPlanGuidanceInputSchema.safeParse(input);
  if (!parsed.success || parsed.data.classification === 'ADVISORY' || parsed.data.repositoryContent.files.length !== 0)
    return { ok: false, code: 'invalid_input' };
  const envelope = { domain: 'eightforge.repository-plan-guidance' as const, schemaVersion: 1 as const,
    stage: 'provider_output_validated' as const, authority: 'non_authoritative' as const, executable: false as const,
    grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
    sourceGuidanceInputDigestSha256: parsed.data.digest.value,
    sourceImplementationPlanV1DigestSha256: parsed.data.source.implementationPlanV1DigestSha256,
    classification: parsed.data.classification,
    recommendations: [], operatorDecisionSuggestions: [], unresolvedGlobalQuestions: [],
    insufficientEvidence: parsed.data.steps.map((step) => ({ stepId: step.stepId,
      reason: 'no_eligible_repository_evidence' as const })) };
  const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
  return { ok: true, artifact: freeze(JSON.parse(canonicalJson(artifact)) as RepositoryPlanGuidanceArtifact) };
}
