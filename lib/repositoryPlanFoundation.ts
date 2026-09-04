import { z } from 'zod';
import type { WorkflowImplementationPlanArtifact } from '@/lib/workflowImplementationPlan';
import type { VerifiedRepositorySnapshot } from '@/lib/server/repositoryPlanSnapshot';
import { BrowserSafeImplementationPlanSchema, ImplementationPlanPinSchema } from '@/lib/workflowImplementationPlanWire';
import { REVIEWED_SPECIFICATION_SCHEMAS } from '@/lib/workflowReviewedSpecification';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { RepositorySnapshotSchema } from '@/lib/repositoryPlanSnapshot';
import { RepositoryEvidenceBundleSchema, type InspectedRepositoryFile, type RepositoryEvidenceRecord } from '@/lib/repositoryPlanEvidence';

const digestValue = z.string().regex(/^[a-f0-9]{64}$/);
export const RepositoryPlanSourceSchema = z.object({
  implementationPlanV1: z.object({ domain: z.literal('eightforge.implementation-plan'), schemaVersion: z.literal(1), digestSha256: digestValue }).strict(),
  effectiveReviewedSpecificationDigestSha256: digestValue,
  reviewPin: ImplementationPlanPinSchema,
  repositorySnapshot: RepositorySnapshotSchema,
}).strict();
const envelopeSchema = z.object({
  domain: z.literal('eightforge.repository-plan-foundation'), schemaVersion: z.literal(1),
  stage: z.literal('pre_provider_foundation'),
  authority: z.literal('non_authoritative'), executable: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requiresHumanReview: z.literal(true),
  source: RepositoryPlanSourceSchema,
  repositoryEvidence: RepositoryEvidenceBundleSchema,
}).strict();
export const RepositoryPlanFoundationInputSchema = z.object({
  trustedPlanV1: BrowserSafeImplementationPlanSchema,
  repositorySnapshot: RepositorySnapshotSchema,
  manifest: RepositoryEvidenceBundleSchema.innerType().shape.manifest,
  evidence: RepositoryEvidenceBundleSchema.innerType().shape.evidence,
}).strict();
export const RepositoryPlanFoundationSchema = envelopeSchema.extend({
  digest: z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: digestValue }).strict(),
}).superRefine((artifact, ctx) => {
  const { digest, ...envelope } = artifact;
  if (canonicalJson(artifact.source.repositorySnapshot) !== canonicalJson(artifact.repositoryEvidence.repositorySnapshot)
    || hashCanonical(envelope) !== digest.value
    || canonicalJson(artifact.repositoryEvidence.manifest) !== canonicalJson(orderedUnique(artifact.repositoryEvidence.manifest))
    || canonicalJson(artifact.repositoryEvidence.evidence) !== canonicalJson(orderedUnique(artifact.repositoryEvidence.evidence)))
    ctx.addIssue({ code: 'custom', message: 'Foundation identity mismatch' });
});
export type RepositoryPlanFoundationArtifact = z.infer<typeof RepositoryPlanFoundationSchema>;
export type RepositoryPlanFoundationInput = Readonly<{
  // Internal-only trust precondition, identical to V1: direct trusted output,
  // never browser/request JSON. Digests validate identity, not authorization.
  trustedPlanV1: WorkflowImplementationPlanArtifact;
  repositorySnapshot: VerifiedRepositorySnapshot;
  manifest: readonly InspectedRepositoryFile[];
  evidence: readonly RepositoryEvidenceRecord[];
}>;
export type RepositoryPlanFoundationResult =
  { ok: true; artifact: RepositoryPlanFoundationArtifact }
  | { ok: false; code: 'invalid_plan_v1' | 'invalid_plan_v1_digest' | 'invalid_repository_evidence' };

// Reject accessors, non-JSON values, sparse arrays and cycles without invoking
// caller serialization hooks. This is validation, not another canonicalizer.
function plainJson(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) return false;
  if (array && (keys.length !== value.length + 1 || Array.from({ length: value.length }, (_, i) => String(i)).some((key) => !descriptors[key]))) return false;
  ancestors.add(value);
  for (const key of keys as string[]) {
    if (array && key === 'length') continue;
    const property = descriptors[key]!;
    if (!property.enumerable || !('value' in property) || !plainJson(property.value, ancestors)) return false;
  }
  ancestors.delete(value);
  return true;
}
function orderedUnique<T>(entries: readonly T[]): T[] {
  return [...new Map(entries.map((entry) => [canonicalJson(entry), entry])).entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([, entry]) => entry);
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

/** Builds no recommendations. Production callers are prohibited in B1. */
export function buildRepositoryPlanFoundation(input: RepositoryPlanFoundationInput): RepositoryPlanFoundationResult {
  try {
    if (!plainJson(input) || !BrowserSafeImplementationPlanSchema.safeParse(input.trustedPlanV1).success)
      return { ok: false, code: 'invalid_plan_v1' };
    const { digest, ...plan } = input.trustedPlanV1;
    if (hashCanonical(plan) !== digest.value) return { ok: false, code: 'invalid_plan_v1_digest' };
    // A valid hash cannot make an incoherent V1 projection valid. Preserve V1's
    // fixed readiness and disposition semantics without rereading its evidence.
    for (const step of plan.plannedSteps) {
      const kind = step.effectiveClassification;
      const expectedReadiness = kind === 'RULE' || kind === 'VERIFY'
        ? { state: 'blocked_structural', blocker: 'rule_definition_is_code' }
        : kind === 'HUMAN' ? { state: 'blocked_structural', blocker: 'no_organization_for_task' }
          : kind === 'EXTRACT' ? { state: 'requires_operator_decision', decision: 'source_document_taxonomy' }
            : kind === 'RECOVER' ? { state: 'requires_operator_decision', decision: 'recovery_vocabulary_unresolved' }
              : { state: 'specification_complete' };
      if (!REVIEWED_SPECIFICATION_SCHEMAS[kind].safeParse(step.specification).success
        || canonicalJson(step.implementationReadiness) !== canonicalJson(expectedReadiness)
        || (step.disposition === 'reclassified' ? step.originalClassification === kind : step.originalClassification !== kind)
        || (step.disposition === 'accepted') !== (step.specificationSource.mode === 'accepted_as_proposed'))
        return { ok: false, code: 'invalid_plan_v1' };
    }
    if (!RepositoryPlanFoundationInputSchema.safeParse(input).success)
      return { ok: false, code: 'invalid_repository_evidence' };
    const bundle = { repositorySnapshot: input.repositorySnapshot, manifest: input.manifest, evidence: input.evidence };
    if (!plainJson(bundle) || !RepositoryEvidenceBundleSchema.safeParse(bundle).success)
      return { ok: false, code: 'invalid_repository_evidence' };
    const classifications = new Set(plan.plannedSteps.map((step) => step.effectiveClassification));
    if (input.manifest.some((entry) => !classifications.has(entry.classification)))
      return { ok: false, code: 'invalid_repository_evidence' };
    const envelope = {
      domain: 'eightforge.repository-plan-foundation' as const, schemaVersion: 1 as const,
      stage: 'pre_provider_foundation' as const,
      authority: 'non_authoritative' as const, executable: false as const,
      grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
      source: { implementationPlanV1: { domain: plan.domain, schemaVersion: plan.schemaVersion, digestSha256: digest.value },
        effectiveReviewedSpecificationDigestSha256: plan.source.effectiveReviewedSpecificationDigestSha256,
        reviewPin: plan.source.pin, repositorySnapshot: input.repositorySnapshot },
      repositoryEvidence: { repositorySnapshot: input.repositorySnapshot,
        manifest: orderedUnique(input.manifest), evidence: orderedUnique(input.evidence) },
    };
    const artifact = { ...envelope, digest: { algorithm: 'sha256' as const,
      encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } };
    return { ok: true, artifact: freeze(JSON.parse(canonicalJson(artifact)) as RepositoryPlanFoundationArtifact) };
  } catch {
    return { ok: false, code: 'invalid_plan_v1' };
  }
}
