import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import { callClaudeForRepositoryPlanGuidance, ForgewingProviderOutputError,
  FORGEWING_REPOSITORY_PLAN_GUIDANCE_PROMPT_ID, FORGEWING_REPOSITORY_PLAN_GUIDANCE_PROMPT_VERSION,
  loadRepositoryPlanGuidancePrompt, type ForgewingProvider } from '@/lib/forgewing/runtime/client';
import { getForgewingRepositoryPlanRuntimeConfig,
  type ForgewingRepositoryPlanRuntimeConfig } from '@/lib/forgewing/runtime/modelConfig';
import { buildAdvisoryRepositoryPlanGuidance, buildInsufficientEvidenceRepositoryPlanGuidance,
  RepositoryPlanGuidanceInputSchema, validateRepositoryPlanGuidance,
  REPOSITORY_PLAN_GUIDANCE_LIMITS,
  type RepositoryPlanGuidanceArtifact, type RepositoryPlanGuidanceInputArtifact } from '@/lib/repositoryPlanGuidance';
import { RepositoryAwareImplementationPlanV2Schema, RepositoryPlanProviderProvenanceSchema,
  RepositoryPlanRawProviderEvidenceSchema,
  type RepositoryAwareImplementationPlanV2Artifact, type RepositoryPlanProviderProvenance,
  type RepositoryPlanRawProviderEvidenceArtifact } from '@/lib/repositoryAwareImplementationPlan';

export { RepositoryAwareImplementationPlanV2Schema, RepositoryPlanProviderProvenanceSchema,
  RepositoryPlanRawProviderEvidenceSchema };
export type { RepositoryAwareImplementationPlanV2Artifact, RepositoryPlanProviderProvenance,
  RepositoryPlanRawProviderEvidenceArtifact };

const PROVIDER = 'anthropic' as const;
const OUTPUT_SCHEMA_VERSION = 'repository-plan-guidance-output-v1' as const;

export type ForgewingRepositoryPlanGuidanceDependencies = Readonly<{
  config?: ForgewingRepositoryPlanRuntimeConfig;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

export type ForgewingRepositoryPlanGuidanceResult =
  | Readonly<{ status: 'skipped'; reason: 'forgewing_disabled' | 'invalid_guidance_input' }>
  | Readonly<{ status: 'completed'; mode: 'provider_validated' | 'advisory' | 'insufficient_evidence';
      rawProviderEvidence: RepositoryPlanRawProviderEvidenceArtifact | null;
      planV2: RepositoryAwareImplementationPlanV2Artifact }>
  | Readonly<{ status: 'failed'; reason: 'budget_exhausted' | 'provider_timeout' | 'provider_error'
      | 'provider_truncated_output' | 'output_too_large' | 'invalid_model_output';
      rawProviderEvidence: RepositoryPlanRawProviderEvidenceArtifact | null;
      callCount: 0 | 1 }>;

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

function provenance(input: RepositoryPlanGuidanceInputArtifact, config: ForgewingRepositoryPlanRuntimeConfig,
  callCount: 0 | 1, rawOutputSha256: string | null, validatedOutputSha256: string | null): RepositoryPlanProviderProvenance {
  return { provider: PROVIDER, model: config.model,
    promptId: FORGEWING_REPOSITORY_PLAN_GUIDANCE_PROMPT_ID,
    promptVersion: FORGEWING_REPOSITORY_PLAN_GUIDANCE_PROMPT_VERSION,
    promptSha256: sha256Hex(loadRepositoryPlanGuidancePrompt()), schemaVersion: OUTPUT_SCHEMA_VERSION,
    timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens, callCount,
    temperature: 0, maxRetries: 0, repositoryCommitSha: input.source.repositorySnapshot.commitSha,
    foundationDigestSha256: input.source.foundationDigestSha256,
    contentBundleDigestSha256: input.source.contentBundleDigestSha256,
    guidanceInputDigestSha256: input.digest.value, rawOutputSha256, validatedOutputSha256 };
}

function rawEvidence(input: RepositoryPlanGuidanceInputArtifact, rawOutput: string,
  providerProvenance: RepositoryPlanProviderProvenance & { callCount: 1 }): RepositoryPlanRawProviderEvidenceArtifact {
  const envelope = { domain: 'eightforge.repository-plan-provider-evidence' as const, schemaVersion: 1 as const,
    authority: 'non_authoritative' as const, trustedGuidance: false as const, executable: false as const,
    grantsExecutionAuthority: false as const, requiresHumanReview: true as const,
    sourceGuidanceInputDigestSha256: input.digest.value, providerProvenance,
    rawOutput, rawOutputSha256: sha256Hex(rawOutput) };
  return freeze(RepositoryPlanRawProviderEvidenceSchema.parse({ ...envelope, digest: { algorithm: 'sha256' as const,
    encoding: 'recursive-key-sorted-json-v1' as const, value: hashCanonical(envelope) } }));
}

function planV2(input: RepositoryPlanGuidanceInputArtifact, guidance: RepositoryPlanGuidanceArtifact,
  providerProvenance: RepositoryPlanProviderProvenance,
  raw: RepositoryPlanRawProviderEvidenceArtifact | null): RepositoryAwareImplementationPlanV2Artifact {
  const envelope = { domain: 'eightforge.repository-aware-implementation-plan' as const, schemaVersion: 2 as const,
    authority: 'non_authoritative' as const, executable: false as const, grantsExecutionAuthority: false as const,
    requiresHumanReview: true as const,
    source: { implementationPlanV1DigestSha256: input.source.implementationPlanV1DigestSha256,
      effectiveReviewedSpecificationDigestSha256: input.source.effectiveReviewedSpecificationDigestSha256,
      foundationDigestSha256: input.source.foundationDigestSha256,
      contentBundleDigestSha256: input.source.contentBundleDigestSha256,
      guidanceInputDigestSha256: input.digest.value, reviewPin: input.source.reviewPin,
      repositorySnapshot: input.source.repositorySnapshot }, guidance, providerProvenance,
    rawOutputSha256: raw?.rawOutputSha256 ?? null, validatedOutputSha256: guidance.digest.value };
  return freeze(RepositoryAwareImplementationPlanV2Schema.parse(JSON.parse(canonicalJson({ ...envelope,
    digest: { algorithm: 'sha256', encoding: 'recursive-key-sorted-json-v1', value: hashCanonical(envelope) } }))));
}

async function callWithin(provider: ForgewingProvider, request: Parameters<ForgewingProvider>[0]): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([provider(request), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

function failure(error: unknown): Exclude<Extract<ForgewingRepositoryPlanGuidanceResult, { status: 'failed' }>['reason'], 'budget_exhausted' | 'invalid_model_output'> {
  if (error instanceof ForgewingProviderOutputError) return 'provider_truncated_output';
  const message = error instanceof Error ? error.message : '';
  const constructorName = error && typeof error === 'object' ? error.constructor?.name ?? '' : '';
  return message === 'provider_timeout' || message === 'Request timed out' || constructorName === 'APIConnectionTimeoutError'
    ? 'provider_timeout' : 'provider_error';
}

/** One evaluation-unit call at most; deterministic outcomes return before budget/provider access. */
export async function runForgewingRepositoryPlanGuidance(rawInput: RepositoryPlanGuidanceInputArtifact,
  dependencies: ForgewingRepositoryPlanGuidanceDependencies = {}): Promise<ForgewingRepositoryPlanGuidanceResult> {
  const parsed = RepositoryPlanGuidanceInputSchema.safeParse(rawInput);
  if (!parsed.success) return { status: 'skipped', reason: 'invalid_guidance_input' };
  const input = parsed.data;
  const config = dependencies.config ?? getForgewingRepositoryPlanRuntimeConfig();
  if (input.classification === 'ADVISORY') {
    const guidance = buildAdvisoryRepositoryPlanGuidance(input);
    if (!guidance.ok) return { status: 'skipped', reason: 'invalid_guidance_input' };
    return { status: 'completed', mode: 'advisory', rawProviderEvidence: null,
      planV2: planV2(input, guidance.artifact, provenance(input, config, 0, null, guidance.artifact.digest.value), null) };
  }
  if (input.repositoryContent.files.length === 0) {
    const guidance = buildInsufficientEvidenceRepositoryPlanGuidance(input);
    if (!guidance.ok) return { status: 'skipped', reason: 'invalid_guidance_input' };
    return { status: 'completed', mode: 'insufficient_evidence', rawProviderEvidence: null,
      planV2: planV2(input, guidance.artifact, provenance(input, config, 0, null, guidance.artifact.digest.value), null) };
  }
  if (!config.enabled) return { status: 'skipped', reason: 'forgewing_disabled' };
  const budget = dependencies.budget ?? new ForgewingCallBudget(1);
  if (!budget.tryConsume()) return { status: 'failed', reason: 'budget_exhausted', rawProviderEvidence: null, callCount: 0 };
  const baseProvenance = provenance(input, config, 1, null, null) as RepositoryPlanProviderProvenance & { callCount: 1 };
  let rawOutput: string;
  try {
    rawOutput = await callWithin(dependencies.provider ?? callClaudeForRepositoryPlanGuidance,
      { model: config.model, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
        inputJson: canonicalJson(input) });
  } catch (error) {
    const partial = error instanceof ForgewingProviderOutputError ? error.rawOutput : null;
    return { status: 'failed', reason: failure(error),
      rawProviderEvidence: partial == null ? null : rawEvidence(input, partial,
        { ...baseProvenance, rawOutputSha256: sha256Hex(partial) }), callCount: 1 };
  }
  const rawSha = sha256Hex(rawOutput);
  const rawBytes = new TextEncoder().encode(rawOutput).byteLength;
  if (rawBytes > REPOSITORY_PLAN_GUIDANCE_LIMITS.maxRawOutputBytes) {
    const oversizedRaw = rawBytes <= 1_048_576
      ? rawEvidence(input, rawOutput, { ...baseProvenance, rawOutputSha256: rawSha }) : null;
    return { status: 'failed', reason: 'output_too_large', rawProviderEvidence: oversizedRaw, callCount: 1 };
  }
  const raw = rawEvidence(input, rawOutput, { ...baseProvenance, rawOutputSha256: rawSha });
  let candidate: unknown;
  try { candidate = JSON.parse(rawOutput) as unknown; }
  catch { return { status: 'failed', reason: 'invalid_model_output', rawProviderEvidence: raw, callCount: 1 }; }
  const validated = validateRepositoryPlanGuidance(input, candidate);
  if (!validated.ok) return { status: 'failed', reason: 'invalid_model_output', rawProviderEvidence: raw, callCount: 1 };
  const providerProvenance = { ...baseProvenance, rawOutputSha256: rawSha,
    validatedOutputSha256: validated.artifact.digest.value };
  return { status: 'completed', mode: 'provider_validated', rawProviderEvidence: raw,
    planV2: planV2(input, validated.artifact, providerProvenance, raw) };
}
