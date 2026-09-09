import { z } from 'zod';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { RepositoryPlanGuidanceInputSchema, RepositoryPlanGuidanceSchema,
  type RepositoryPlanGuidanceArtifact, type RepositoryPlanGuidanceInputArtifact } from '@/lib/repositoryPlanGuidance';

const PROVIDER = 'anthropic' as const;
const PROMPT_ID = 'forgewing-repository-plan-guidance' as const;
const PROMPT_VERSION = 'v1' as const;
const OUTPUT_SCHEMA_VERSION = 'repository-plan-guidance-output-v1' as const;
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sha1 = z.string().regex(/^[a-f0-9]{40}$/);

export type RepositoryPlanProviderProvenance = Readonly<{
  provider: typeof PROVIDER; model: string; promptId: typeof PROMPT_ID; promptVersion: typeof PROMPT_VERSION;
  promptSha256: string; schemaVersion: typeof OUTPUT_SCHEMA_VERSION; timeoutMs: number; maxOutputTokens: number;
  callCount: 0 | 1; temperature: 0; maxRetries: 0; repositoryCommitSha: string;
  foundationDigestSha256: string; contentBundleDigestSha256: string; guidanceInputDigestSha256: string;
  rawOutputSha256: string | null; validatedOutputSha256: string | null;
}>;

export type RepositoryPlanRawProviderEvidenceArtifact = Readonly<{
  domain: 'eightforge.repository-plan-provider-evidence'; schemaVersion: 1;
  authority: 'non_authoritative'; trustedGuidance: false; executable: false; grantsExecutionAuthority: false;
  requiresHumanReview: true; sourceGuidanceInputDigestSha256: string;
  providerProvenance: RepositoryPlanProviderProvenance & Readonly<{ callCount: 1 }>;
  rawOutput: string; rawOutputSha256: string;
  digest: Readonly<{ algorithm: 'sha256'; encoding: 'recursive-key-sorted-json-v1'; value: string }>;
}>;

export type RepositoryAwareImplementationPlanV2Artifact = Readonly<{
  domain: 'eightforge.repository-aware-implementation-plan'; schemaVersion: 2;
  authority: 'non_authoritative'; executable: false; grantsExecutionAuthority: false; requiresHumanReview: true;
  source: Readonly<{ implementationPlanV1DigestSha256: string; effectiveReviewedSpecificationDigestSha256: string;
    foundationDigestSha256: string; contentBundleDigestSha256: string; guidanceInputDigestSha256: string;
    repositoryEvidenceCatalogDigestSha256?: string;
    reviewPin: RepositoryPlanGuidanceInputArtifact['source']['reviewPin'];
    repositorySnapshot: RepositoryPlanGuidanceInputArtifact['source']['repositorySnapshot'] }>;
  guidance: RepositoryPlanGuidanceArtifact; providerProvenance: RepositoryPlanProviderProvenance;
  rawOutputSha256: string | null; validatedOutputSha256: string;
  digest: Readonly<{ algorithm: 'sha256'; encoding: 'recursive-key-sorted-json-v1'; value: string }>;
}>;

export const RepositoryPlanProviderProvenanceSchema = z.object({
  provider: z.literal(PROVIDER), model: z.string().min(1).max(200), promptId: z.literal(PROMPT_ID),
  promptVersion: z.literal(PROMPT_VERSION), promptSha256: sha256, schemaVersion: z.literal(OUTPUT_SCHEMA_VERSION),
  timeoutMs: z.number().int().min(1_000).max(120_000), maxOutputTokens: z.number().int().min(1_024).max(16_000),
  callCount: z.union([z.literal(0), z.literal(1)]), temperature: z.literal(0), maxRetries: z.literal(0),
  repositoryCommitSha: sha1, foundationDigestSha256: sha256, contentBundleDigestSha256: sha256,
  guidanceInputDigestSha256: sha256, rawOutputSha256: sha256.nullable(), validatedOutputSha256: sha256.nullable(),
}).strict();
const digestSchema = z.object({ algorithm: z.literal('sha256'), encoding: z.literal('recursive-key-sorted-json-v1'), value: sha256 }).strict();
const rawEnvelopeSchema = z.object({
  domain: z.literal('eightforge.repository-plan-provider-evidence'), schemaVersion: z.literal(1),
  authority: z.literal('non_authoritative'), trustedGuidance: z.literal(false), executable: z.literal(false),
  grantsExecutionAuthority: z.literal(false), requiresHumanReview: z.literal(true), sourceGuidanceInputDigestSha256: sha256,
  providerProvenance: RepositoryPlanProviderProvenanceSchema.extend({ callCount: z.literal(1),
    rawOutputSha256: sha256, validatedOutputSha256: z.null() }).strict(),
  rawOutput: z.string().max(1_048_576), rawOutputSha256: sha256,
}).strict();
export const RepositoryPlanRawProviderEvidenceSchema = rawEnvelopeSchema.extend({ digest: digestSchema })
  .superRefine((artifact, ctx) => {
    const { digest, ...envelope } = artifact;
    if (hashCanonical(envelope) !== digest.value || artifact.rawOutputSha256 !== sha256Hex(artifact.rawOutput)
      || artifact.providerProvenance.rawOutputSha256 !== artifact.rawOutputSha256
      || artifact.providerProvenance.guidanceInputDigestSha256 !== artifact.sourceGuidanceInputDigestSha256)
      ctx.addIssue({ code: 'custom', message: 'Raw provider evidence identity mismatch' });
  });

const snapshotSchema = RepositoryPlanGuidanceInputSchema.innerType().shape.source.shape.repositorySnapshot;
const planV2EnvelopeSchema = z.object({
  domain: z.literal('eightforge.repository-aware-implementation-plan'), schemaVersion: z.literal(2),
  authority: z.literal('non_authoritative'), executable: z.literal(false), grantsExecutionAuthority: z.literal(false),
  requiresHumanReview: z.literal(true), source: z.object({ implementationPlanV1DigestSha256: sha256,
    effectiveReviewedSpecificationDigestSha256: sha256, foundationDigestSha256: sha256,
    contentBundleDigestSha256: sha256, guidanceInputDigestSha256: sha256,
    repositoryEvidenceCatalogDigestSha256: sha256.optional(),
    reviewPin: z.object({ assessmentId: z.string().uuid(), assessmentVersion: z.number().int().positive(),
      reviewId: z.string().uuid(), reviewVersion: z.number().int().positive() }).strict(), repositorySnapshot: snapshotSchema }).strict(),
  guidance: RepositoryPlanGuidanceSchema, providerProvenance: RepositoryPlanProviderProvenanceSchema,
  rawOutputSha256: sha256.nullable(), validatedOutputSha256: sha256,
}).strict();
export const RepositoryAwareImplementationPlanV2Schema = planV2EnvelopeSchema.extend({ digest: digestSchema })
  .superRefine((artifact, ctx) => {
    const { digest, ...envelope } = artifact;
    if (hashCanonical(envelope) !== digest.value || artifact.validatedOutputSha256 !== artifact.guidance.digest.value
      || artifact.guidance.sourceImplementationPlanV1DigestSha256 !== artifact.source.implementationPlanV1DigestSha256
      || artifact.guidance.sourceGuidanceInputDigestSha256 !== artifact.source.guidanceInputDigestSha256
      || artifact.providerProvenance.repositoryCommitSha !== artifact.source.repositorySnapshot.commitSha
      || artifact.providerProvenance.foundationDigestSha256 !== artifact.source.foundationDigestSha256
      || artifact.providerProvenance.contentBundleDigestSha256 !== artifact.source.contentBundleDigestSha256
      || artifact.providerProvenance.guidanceInputDigestSha256 !== artifact.source.guidanceInputDigestSha256
      || artifact.providerProvenance.rawOutputSha256 !== artifact.rawOutputSha256
      || artifact.providerProvenance.validatedOutputSha256 !== artifact.validatedOutputSha256)
      ctx.addIssue({ code: 'custom', message: 'Plan V2 identity mismatch' });
  });
