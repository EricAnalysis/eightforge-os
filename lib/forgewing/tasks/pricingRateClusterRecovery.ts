import { z } from 'zod';

import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { ForgewingCallBudget } from '@/lib/forgewing/runtime/budget';
import {
  callClaudeForPricingRateClusterRecovery,
  FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_ID,
  FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_VERSION,
  type ForgewingProvider,
} from '@/lib/forgewing/runtime/client';
import {
  getForgewingRuntimeConfig,
  isForgewingPricingRateClusterRecoveryEnabled,
  type ForgewingRuntimeConfig,
} from '@/lib/forgewing/runtime/modelConfig';
import {
  parsePricingRateClusterRecoveryModelOutput,
  type PricingRateClusterRecoveryModelOutput,
} from '@/lib/forgewing/runtime/structuredOutput';

export const FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_SCHEMA_VERSION =
  'forgewing-pricing-rate-cluster-recovery-v1' as const;

const identifier = z.string().min(1).max(200)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const sourceLayer = z.enum(['pdf_native_text', 'ocr']);
const observationSchema = z.object({
  observationId: identifier,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  physicalPageNumber: z.number().int().positive(),
  artifactLocalIndex: z.number().int().nonnegative(),
  sourceLayer,
  rawText: z.string().min(1).max(200),
  boundingBox: z.object({
    xMin: z.number().finite(), xMax: z.number().finite(),
    yMin: z.number().finite(), yMax: z.number().finite(),
  }).strict().refine((box) => box.xMin < box.xMax && box.yMin < box.yMax),
}).strict();

const inputSchema = z.object({
  organizationId: identifier,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  extractionSnapshotId: identifier,
  physicalPageNumber: z.number().int().positive(),
  recoveryTaskType: z.literal('pricing_rate_cluster_recovery'),
  eligibilityReason: z.literal('ambiguous_relationship'),
  diagnosticReason: z.literal('ambiguous_rate_clusters'),
  observations: z.array(observationSchema).min(2).max(32),
}).strict();

export type ForgewingPricingRateClusterRecoveryInput = z.input<typeof inputSchema>;
type ParsedInput = z.output<typeof inputSchema>;

export type ForgewingPricingRateClusterRecoveryMetadata = Readonly<{
  considered: true;
  eligibilityReason: 'ambiguous_relationship';
  providerInvoked: boolean;
  calls: number;
  model: string;
  promptTemplateId: typeof FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_ID;
  promptTemplateVersion: typeof FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_VERSION;
  timeoutMs: number;
  maxOutputTokens: number;
  deterministicValidationSuccessful: boolean;
  humanReviewRequired: boolean;
}>;

export type ForgewingPricingRateClusterRecoveryProposal = Readonly<{
  proposalId: string;
  taskId: string;
  taskType: 'pricing_rate_cluster_recovery';
  status: 'recovered_candidate';
  authority: 'non_authoritative';
  proposedField: 'rate';
  proposedValue: string;
  normalizedValue: string;
  sourceDocumentId: string;
  sourceArtifactId: string;
  extractionSnapshotId: string;
  physicalPageNumber: number;
  selectedObservationIds: readonly string[];
  alternativeObservationIds: readonly string[];
  evidence: readonly Readonly<{
    observationId: string;
    sourceDocumentId: string;
    sourceArtifactId: string;
    physicalPageNumber: number;
    artifactLocalIndex: number;
    sourceLayer: 'pdf_native_text' | 'ocr';
    rawText: string;
    boundingBox: Readonly<{ xMin: number; xMax: number; yMin: number; yMax: number }>;
  }>[];
  certainty: number;
  reasonCategory: string;
  requiresHumanReview: true;
}>;

export type ForgewingPricingRateClusterRecoveryBundle = Readonly<{
  schemaVersion: typeof FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_SCHEMA_VERSION;
  authority: 'non_authoritative';
  run: Readonly<{
    runId: string;
    organizationId: string;
    extractionSnapshotId: string;
    inputSnapshotHash: string;
  }>;
  taskId: string;
  taskType: 'pricing_rate_cluster_recovery';
  proposals: readonly ForgewingPricingRateClusterRecoveryProposal[];
  abstentions: readonly never[];
}>;

export const ForgewingPricingRateClusterRecoveryBundleSchema = z.object({
  schemaVersion: z.literal(FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_SCHEMA_VERSION),
  authority: z.literal('non_authoritative'),
  run: z.object({
    runId: identifier,
    organizationId: identifier,
    extractionSnapshotId: identifier,
    inputSnapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict(),
  taskId: identifier,
  taskType: z.literal('pricing_rate_cluster_recovery'),
  proposals: z.array(z.object({
    proposalId: identifier,
    taskId: identifier,
    taskType: z.literal('pricing_rate_cluster_recovery'),
    status: z.literal('recovered_candidate'),
    authority: z.literal('non_authoritative'),
    proposedField: z.literal('rate'),
    proposedValue: z.string().min(1).max(200),
    normalizedValue: z.string().min(1).max(200),
    sourceDocumentId: identifier,
    sourceArtifactId: identifier,
    extractionSnapshotId: identifier,
    physicalPageNumber: z.number().int().positive(),
    selectedObservationIds: z.array(identifier).length(1),
    alternativeObservationIds: z.array(identifier).min(1).max(8),
    evidence: z.array(observationSchema).min(2).max(32),
    certainty: z.number().min(0).max(1),
    reasonCategory: z.enum([
      'explicit_currency_marker', 'numeric_rate_pattern', 'row_structure_support',
      'competing_monetary_cluster', 'insufficient_semantic_context',
    ]),
    requiresHumanReview: z.literal(true),
  }).strict()).length(1),
  abstentions: z.array(z.never()).length(0),
}).strict().superRefine((bundle, context) => {
  const proposal = bundle.proposals[0]!;
  if (proposal.taskId !== bundle.taskId
    || proposal.sourceDocumentId !== proposal.evidence[0]?.sourceDocumentId
    || proposal.sourceArtifactId !== proposal.evidence[0]?.sourceArtifactId
    || proposal.extractionSnapshotId !== bundle.run.extractionSnapshotId
    || proposal.evidence.some((entry) =>
      entry.sourceDocumentId !== proposal.sourceDocumentId
      || entry.sourceArtifactId !== proposal.sourceArtifactId
      || entry.physicalPageNumber !== proposal.physicalPageNumber)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['proposals', 0],
      message: 'recovery proposal identity closure failed' });
  }
});

export type ForgewingPricingRateClusterRecoveryResult =
  | Readonly<{ status: 'not_needed'; reason: 'no_ambiguous_rate_clusters' }>
  | Readonly<{ status: 'eligible_not_executed'; reason: 'recovery_disabled' | 'budget_exhausted';
      metadata: ForgewingPricingRateClusterRecoveryMetadata }>
  | Readonly<{ status: 'provider_failed'; reason: string;
      metadata: ForgewingPricingRateClusterRecoveryMetadata }>
  | Readonly<{ status: 'structured_output_invalid'; reason: string;
      metadata: ForgewingPricingRateClusterRecoveryMetadata }>
  | Readonly<{ status: 'evidence_binding_failed'; reason: string;
      metadata: ForgewingPricingRateClusterRecoveryMetadata }>
  | Readonly<{ status: 'deterministic_validation_failed'; reason: string;
      metadata: ForgewingPricingRateClusterRecoveryMetadata }>
  | Readonly<{ status: 'requires_human_review'; bundle: ForgewingPricingRateClusterRecoveryBundle;
      metadata: ForgewingPricingRateClusterRecoveryMetadata }>;

export type ForgewingPricingRateClusterRecoveryDependencies = Readonly<{
  config?: ForgewingRuntimeConfig;
  taskEnabled?: boolean;
  provider?: ForgewingProvider;
  budget?: ForgewingCallBudget;
}>;

function normalizeAuthoredRate(raw: string): string | null {
  const compact = raw.trim().replace(/\s+/g, ' ');
  if (/^[$£€¥]\s*-$/.test(compact)) return null;
  const match = compact.match(/^\(?\s*[$£€¥]?\s*([+-]?(?:\d{1,3}(?:,\d{3})*|\d+)(?:\.\d+)?)\s*\)?$/);
  if (!match) return null;
  const numeric = match[1]!.replace(/,/g, '');
  return compact.startsWith('(') && compact.endsWith(')') && !numeric.startsWith('-')
    ? `-${numeric}`
    : numeric;
}

function metadata(
  config: ForgewingRuntimeConfig,
  calls: number,
  providerInvoked: boolean,
  validated: boolean,
  humanReviewRequired: boolean,
): ForgewingPricingRateClusterRecoveryMetadata {
  return {
    considered: true,
    eligibilityReason: 'ambiguous_relationship',
    providerInvoked,
    calls,
    model: config.model,
    promptTemplateId: FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_ID,
    promptTemplateVersion: FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_PROMPT_VERSION,
    timeoutMs: config.timeoutMs,
    maxOutputTokens: Math.min(config.maxOutputTokens, 800),
    deterministicValidationSuccessful: validated,
    humanReviewRequired,
  };
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const name = error && typeof error === 'object' ? error.constructor?.name ?? '' : '';
  if (message === 'provider_timeout' || message === 'Request timed out'
    || name === 'APIConnectionTimeoutError') return 'provider_timeout';
  if (message.includes('ANTHROPIC_API_KEY')) return 'anthropic_not_configured';
  return message || 'provider_error';
}

async function callWithin(
  provider: ForgewingProvider,
  request: Parameters<ForgewingProvider>[0],
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider(request),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('provider_timeout')), request.timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function validateInputIdentity(input: ParsedInput): boolean {
  const ids = input.observations.map((entry) => entry.observationId);
  return new Set(ids).size === ids.length
    && input.observations.every((entry) =>
      entry.sourceDocumentId === input.sourceDocumentId
      && entry.sourceArtifactId === input.sourceArtifactId
      && entry.physicalPageNumber === input.physicalPageNumber
      && entry.artifactLocalIndex === input.physicalPageNumber - 1);
}

function makeBundle(
  input: ParsedInput,
  inputHash: string,
  output: PricingRateClusterRecoveryModelOutput,
): ForgewingPricingRateClusterRecoveryBundle | null {
  const monetary = input.observations.flatMap((entry) => {
    const normalized = normalizeAuthoredRate(entry.rawText);
    return normalized == null ? [] : [{ ...entry, normalized }];
  });
  const monetaryById = new Map(monetary.map((entry) => [entry.observationId, entry]));
  const monetaryIds = new Set(monetaryById.keys());
  const accounted = [...output.selectedObservationIds, ...output.alternativeObservationIds];
  if (output.candidateId !== `pricing-rate-cluster-${inputHash.slice(0, 32)}`
    || output.selectedObservationIds.length !== 1
    || new Set(accounted).size !== accounted.length
    || accounted.length !== monetaryIds.size
    || accounted.some((id) => !monetaryIds.has(id))) return null;
  const selected = monetaryById.get(output.selectedObservationIds[0]!);
  if (!selected
    || output.proposedRawValue !== selected.rawText
    || output.proposedNormalizedValue !== selected.normalized) return null;

  const taskId = `forgewing-task-pricing-rate-cluster-${inputHash.slice(0, 32)}`;
  const proposal: ForgewingPricingRateClusterRecoveryProposal = Object.freeze({
    proposalId: `forgewing-proposal-pricing-rate-cluster-${inputHash.slice(0, 32)}`,
    taskId,
    taskType: 'pricing_rate_cluster_recovery',
    status: 'recovered_candidate',
    authority: 'non_authoritative',
    proposedField: 'rate',
    proposedValue: output.proposedRawValue,
    normalizedValue: output.proposedNormalizedValue,
    sourceDocumentId: input.sourceDocumentId,
    sourceArtifactId: input.sourceArtifactId,
    extractionSnapshotId: input.extractionSnapshotId,
    physicalPageNumber: input.physicalPageNumber,
    selectedObservationIds: Object.freeze([...output.selectedObservationIds]),
    alternativeObservationIds: Object.freeze([...output.alternativeObservationIds]),
    evidence: Object.freeze(input.observations.map((entry) => Object.freeze({ ...entry }))),
    certainty: output.confidence,
    reasonCategory: output.rationaleCode,
    requiresHumanReview: true,
  });
  return ForgewingPricingRateClusterRecoveryBundleSchema.parse({
    schemaVersion: FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_SCHEMA_VERSION,
    authority: 'non_authoritative',
    run: Object.freeze({
      runId: `forgewing-run-pricing-rate-cluster-${inputHash.slice(0, 32)}`,
      organizationId: input.organizationId,
      extractionSnapshotId: input.extractionSnapshotId,
      inputSnapshotHash: inputHash,
    }),
    taskId,
    taskType: 'pricing_rate_cluster_recovery',
    proposals: Object.freeze([proposal]) as readonly [ForgewingPricingRateClusterRecoveryProposal],
    abstentions: Object.freeze([]) as readonly [],
  }) as ForgewingPricingRateClusterRecoveryBundle;
}

export async function runForgewingPricingRateClusterRecovery(
  rawInput: ForgewingPricingRateClusterRecoveryInput | null,
  dependencies: ForgewingPricingRateClusterRecoveryDependencies = {},
): Promise<ForgewingPricingRateClusterRecoveryResult> {
  if (rawInput == null) return { status: 'not_needed', reason: 'no_ambiguous_rate_clusters' };
  const config = dependencies.config ?? getForgewingRuntimeConfig();
  const disabledMetadata = metadata(config, 0, false, false, false);
  if (!config.enabled
    || !(dependencies.taskEnabled ?? isForgewingPricingRateClusterRecoveryEnabled())) {
    return { status: 'eligible_not_executed', reason: 'recovery_disabled',
      metadata: disabledMetadata };
  }
  const parsed = inputSchema.safeParse(rawInput);
  if (!parsed.success || !validateInputIdentity(parsed.data)) {
    return { status: 'evidence_binding_failed', reason: 'input_identity_closure_failed',
      metadata: disabledMetadata };
  }
  const monetary = parsed.data.observations.flatMap((entry) =>
    normalizeAuthoredRate(entry.rawText) == null ? [] : [entry.observationId]);
  if (new Set(monetary).size < 2) {
    return { status: 'deterministic_validation_failed',
      reason: 'fewer_than_two_distinct_monetary_candidates', metadata: disabledMetadata };
  }

  const bounded = Object.freeze({
    taskType: 'pricing_rate_cluster_recovery' as const,
    eligibilityReason: parsed.data.eligibilityReason,
    source: {
      sourceDocumentId: parsed.data.sourceDocumentId,
      sourceArtifactId: parsed.data.sourceArtifactId,
      extractionSnapshotId: parsed.data.extractionSnapshotId,
      physicalPageNumber: parsed.data.physicalPageNumber,
    },
    monetaryCandidates: parsed.data.observations.flatMap((entry) => {
      const deterministicNormalizedValue = normalizeAuthoredRate(entry.rawText);
      return deterministicNormalizedValue == null ? [] : [{
        observationId: entry.observationId,
        rawText: entry.rawText,
        deterministicNormalizedValue,
      }];
    }),
  });
  const inputSnapshotHash = hashCanonical(bounded);
  const boundedInput = {
    ...bounded,
    candidateId: `pricing-rate-cluster-${inputSnapshotHash.slice(0, 32)}`,
  };

  const budget = dependencies.budget ?? new ForgewingCallBudget(1);
  if (!budget.tryConsume()) {
    return { status: 'eligible_not_executed', reason: 'budget_exhausted',
      metadata: metadata(config, budget.used, false, false, false) };
  }
  let raw: string;
  try {
    raw = await callWithin(dependencies.provider ?? callClaudeForPricingRateClusterRecovery, {
      model: config.model,
      timeoutMs: config.timeoutMs,
      maxOutputTokens: Math.min(config.maxOutputTokens, 800),
      inputJson: canonicalJson(boundedInput),
    });
  } catch (error) {
    const reason = failureReason(error);
    return reason === 'provider_truncated_output'
      ? { status: 'structured_output_invalid', reason,
          metadata: metadata(config, budget.used, true, false, false) }
      : { status: 'provider_failed', reason,
          metadata: metadata(config, budget.used, true, false, false) };
  }
  let output: PricingRateClusterRecoveryModelOutput;
  try { output = parsePricingRateClusterRecoveryModelOutput(raw); } catch (error) {
    return { status: 'structured_output_invalid', reason: failureReason(error),
      metadata: metadata(config, budget.used, true, false, false) };
  }
  const bundle = makeBundle(parsed.data, inputSnapshotHash, output);
  if (!bundle) {
    const knownIds = new Set(parsed.data.observations.map((entry) => entry.observationId));
    const citedIds = [...output.selectedObservationIds, ...output.alternativeObservationIds];
    const evidenceFailure = citedIds.some((id) => !knownIds.has(id));
    return evidenceFailure
      ? { status: 'evidence_binding_failed', reason: 'unknown_evidence_reference',
          metadata: metadata(config, budget.used, true, false, true) }
      : { status: 'deterministic_validation_failed', reason: 'proposal_value_validation_failed',
          metadata: metadata(config, budget.used, true, false, true) };
  }
  return { status: 'requires_human_review', bundle,
    metadata: metadata(config, budget.used, true, true, true) };
}
