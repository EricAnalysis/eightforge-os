/**
 * Non-serving Forgewing pricing corpus runner.
 *
 * This composes real extraction, deterministic pricing admission, shadow-only
 * proposals, and evidence-fidelity evaluation. It never writes Supabase,
 * canonical pricing, validator state, or Project Truth.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runDocumentPipeline } from '@/lib/pipeline/documentPipeline';
import { extractDocument } from '@/lib/server/documentExtraction';
import type { RatePageRange } from '@/lib/contracts/parseRatePageRanges';
import { parseRatePageRanges } from '@/lib/contracts/parseRatePageRanges';
import { canonicalJson, hashCanonical } from '@/lib/extraction/domain/hash';
import { opaqueIds } from '@/lib/extraction/domain/opaqueIds';
import {
  buildEligiblePricingReasoningShadowCandidates,
  type ForgewingPricingInterpretationShadowInput,
} from '@/lib/extraction/persistence/complianceShadow';
import {
  adaptFrozenPricingArtifacts,
  evaluateForgewingPricingInterpretation,
  type ForgewingPricingInterpretationEvaluationReport,
  type FrozenPricingObservationSetInput,
} from '@/lib/evaluation/forgewing/pricingInterpretationEvaluation';
import {
  runForgewingPricingInterpretation,
  type ForgewingPricingInterpretationDependencies,
  type ForgewingPricingInterpretationInput,
} from '@/lib/forgewing/tasks/pricingInterpretation';
import {
  FORGEWING_PRICING_INTERPRETATION_PROMPT_ID,
  FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION,
  callClaudeForPricingInterpretation,
} from '@/lib/forgewing/runtime/client';
import { FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION } from '@/lib/forgewing/proposal/schemaVersion';
import { getForgewingRuntimeConfig } from '@/lib/forgewing/runtime/modelConfig';

export type ForgewingPricingCorpusAvailability =
  | 'available' | 'unavailable' | 'missing_config' | 'hash_mismatch' | 'missing_labels';

export type ForgewingPricingCorpusEntry = Readonly<{
  sourcePdfPath: string;
  optionalLabelPackagePath?: string;
  corpusKind: 'real_unlabelled_smoke' | 'labelled_external';
  expectedSourceSha256?: string;
  metadata?: Readonly<Record<string, unknown>>;
  documentType: string;
  authoritativeRatePageRanges: readonly RatePageRange[];
}>;

export type ForgewingPricingCorpusAttempt = Readonly<{
  rowObservationId: string;
  resultStatus: 'applied' | 'abstained' | 'failed' | 'skipped';
  model: string | null;
  promptTemplateId: string;
  promptTemplateVersion: string;
  proposalSchemaVersion: string;
  inputSnapshotHash: string | null;
  taskId: string | null;
  runId: string | null;
  evaluation: ForgewingPricingInterpretationEvaluationReport | null;
  warnings: readonly string[];
  failureReason: string | null;
}>;

export type ForgewingPricingCorpusMetrics = Readonly<{
  totalEligibleCandidates: number;
  totalAttemptedProposals: number;
  evaluatedCandidateCount: number;
  appliedCount: number;
  abstentionCount: number;
  insufficientEvidenceCount: number;
  evidenceValidCount: number;
  evidenceInvalidCount: number;
  evidenceUnverifiableCount: number;
  silentHallucinationCount: number;
  noValueManufactureViolationCount: number;
  snapshotMismatchCount: number;
  identityMismatchCount: number;
  providerRuntimeFailureCount: number;
  modelOutputRejectionCount: number;
  nonComparableCandidateCount: number;
}>;

export type ForgewingPricingCorpusSmokeReport = Readonly<{
  reportVersion: 'forgewing-pricing-corpus-smoke-v1';
  authority: 'non_authoritative_measurement';
  corpusKind: 'real_unlabelled_smoke' | 'labelled_external';
  corpusIdentity: string;
  corpusStatus: 'unmet';
  smokeStatus: 'completed' | 'completed_no_eligible_candidates';
  availability: ForgewingPricingCorpusAvailability;
  pricingCorrectnessEvaluated: false;
  promotionEvidence: false;
  source: Readonly<{
    sourcePdfPath: string;
    sourceSha256: string;
    sourceByteLength: number;
    sourceDocumentId: string;
    sourceArtifactId: string;
    extractionSnapshotId: string;
  }>;
  executionIdentity: string;
  runtime: Readonly<{
    model: string;
    promptTemplateId: string;
    promptTemplateVersion: string;
    proposalSchemaVersion: string;
  }>;
  orderingDeterministic: boolean;
  attempts: readonly ForgewingPricingCorpusAttempt[];
  metrics: ForgewingPricingCorpusMetrics;
}>;

export type ForgewingPricingCorpusDependencies = Readonly<{
  task?: ForgewingPricingInterpretationDependencies;
}>;

export async function runForgewingPricingCandidateAttempts(
  candidates: readonly ForgewingPricingInterpretationInput[],
  taskDependencies?: ForgewingPricingInterpretationDependencies,
): Promise<readonly ForgewingPricingCorpusAttempt[]> {
  const attempts: ForgewingPricingCorpusAttempt[] = [];
  for (const candidate of candidates) {
    let boundedProviderInput: FrozenPricingObservationSetInput | null = null;
    const delegateProvider = taskDependencies?.provider ?? callClaudeForPricingInterpretation;
    const result = await runForgewingPricingInterpretation(candidate, {
      ...taskDependencies,
      provider: async (request) => {
        const bounded = JSON.parse(request.inputJson) as {
          run: { organizationId: string; extractionSnapshotId: string };
          source: { sourceDocumentId: string; sourceArtifactId: string };
          rowObservation: FrozenPricingObservationSetInput['rowObservation'];
        };
        boundedProviderInput = {
          organizationId: bounded.run.organizationId,
          extractionSnapshotId: bounded.run.extractionSnapshotId,
          sourceDocumentId: bounded.source.sourceDocumentId,
          sourceArtifactId: bounded.source.sourceArtifactId,
          rowObservation: bounded.rowObservation,
        };
        return delegateProvider(request);
      },
    });
    if (result.status === 'applied' || result.status === 'abstained') {
      if (result.status === 'applied' && boundedProviderInput == null) {
        throw new Error('forgewing_pricing_corpus_applied_without_bounded_provider_input');
      }
      const evaluation = evaluateForgewingPricingInterpretation({
        bundle: result.bundle,
        sourceArtifacts: boundedProviderInput == null
          ? []
          : adaptFrozenPricingArtifacts(boundedProviderInput),
        expectedExtractionSnapshotId: candidate.extractionSnapshotId,
        expectedOrganizationId: candidate.organizationId,
        expectedPricingScopeIdentity: candidate.pricingScope.scopeIdentity,
        expectedRowObservationId: candidate.rowObservation.observationId,
        frozenObservationSetAvailable: boundedProviderInput != null,
      });
      attempts.push({
        rowObservationId: candidate.rowObservation.observationId,
        resultStatus: result.status,
        model: result.metadata.model,
        promptTemplateId: result.metadata.promptTemplateId,
        promptTemplateVersion: result.metadata.promptTemplateVersion,
        proposalSchemaVersion: result.bundle.schemaVersion,
        inputSnapshotHash: result.bundle.run.inputSnapshotHash,
        taskId: result.bundle.taskId,
        runId: result.bundle.run.runId,
        evaluation,
        warnings: [...result.warnings],
        failureReason: null,
      });
    } else {
      attempts.push({
        rowObservationId: candidate.rowObservation.observationId,
        resultStatus: result.status,
        model: result.status === 'failed' ? result.metadata.model : null,
        promptTemplateId: FORGEWING_PRICING_INTERPRETATION_PROMPT_ID,
        promptTemplateVersion: FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION,
        proposalSchemaVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
        inputSnapshotHash: null,
        taskId: null,
        runId: null,
        evaluation: null,
        warnings: result.status === 'failed' ? [...result.warnings] : [],
        failureReason: 'reason' in result ? result.reason : null,
      });
    }
  }
  attempts.sort((left, right) => left.rowObservationId.localeCompare(right.rowObservationId, 'en-US'));
  return attempts;
}

export function summarizeForgewingPricingCorpusAttempts(
  totalEligibleCandidates: number,
  attempts: readonly ForgewingPricingCorpusAttempt[],
): ForgewingPricingCorpusMetrics {
  const allEvaluations = attempts.flatMap((attempt) => attempt.evaluation ? [attempt.evaluation] : []);
  const evaluations = allEvaluations.filter((evaluation) => evaluation.summary.metricsEvaluated);
  const sum = (select: (report: ForgewingPricingInterpretationEvaluationReport) => number) =>
    evaluations.reduce((total, report) => total + select(report), 0);
  return {
    totalEligibleCandidates,
    totalAttemptedProposals: attempts.length,
    evaluatedCandidateCount: evaluations.length,
    appliedCount: attempts.filter((attempt) => attempt.resultStatus === 'applied').length,
    abstentionCount: attempts.filter((attempt) => attempt.resultStatus === 'abstained').length,
    insufficientEvidenceCount: sum((report) => report.metrics.insufficientEvidenceCount),
    evidenceValidCount: sum((report) => report.metrics.evidenceValidCount),
    evidenceInvalidCount: sum((report) => report.metrics.evidenceInvalidCount),
    evidenceUnverifiableCount: sum((report) => report.metrics.evidenceUnverifiableCount),
    silentHallucinationCount: sum((report) => report.metrics.silentHallucinationCount),
    noValueManufactureViolationCount: sum(
      (report) => report.metrics.noValueManufactureViolationCount,
    ),
    snapshotMismatchCount: allEvaluations.reduce(
      (total, report) => total + report.metrics.snapshotMismatchCount, 0,
    ),
    identityMismatchCount: allEvaluations.reduce(
      (total, report) => total + report.metrics.identityMismatchCount, 0,
    ),
    providerRuntimeFailureCount: attempts.filter((attempt) =>
      attempt.resultStatus === 'abstained' && attempt.warnings.some((warning) =>
        ['provider_timeout', 'provider_error', 'anthropic_not_configured'].includes(warning))).length,
    modelOutputRejectionCount: attempts.filter((attempt) =>
      attempt.resultStatus === 'abstained' && attempt.warnings.some((warning) =>
        ['invalid_model_json', 'model_schema_rejected', 'unknown_evidence_reference',
          'unsupported_source_text'].includes(warning))).length,
    nonComparableCandidateCount: allEvaluations.length - evaluations.length,
  };
}

export function resolveForgewingPricingCorpusAvailability(
  entry: ForgewingPricingCorpusEntry,
): Readonly<{ status: ForgewingPricingCorpusAvailability; sha256: string | null }> {
  if (!entry.sourcePdfPath.trim()) return { status: 'missing_config', sha256: null };
  const sourcePath = resolve(entry.sourcePdfPath);
  if (!existsSync(sourcePath)) return { status: 'unavailable', sha256: null };
  if (entry.corpusKind === 'labelled_external'
    && (!entry.optionalLabelPackagePath || !existsSync(resolve(entry.optionalLabelPackagePath)))) {
    return { status: 'missing_labels', sha256: null };
  }
  const sha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  if (entry.expectedSourceSha256 && entry.expectedSourceSha256 !== sha256) {
    return { status: 'hash_mismatch', sha256 };
  }
  return { status: 'available', sha256 };
}

function reversedEligibility(value: unknown): unknown {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  return {
    ...record,
    ...(Array.isArray(record.observations)
      ? { observations: [...record.observations].reverse() }
      : {}),
  };
}

export async function runForgewingPricingCorpus(
  entry: ForgewingPricingCorpusEntry,
  dependencies: ForgewingPricingCorpusDependencies = {},
): Promise<ForgewingPricingCorpusSmokeReport> {
  if (process.env.OPENAI_API_KEY?.trim() || process.env.UNSTRUCTURED_API_KEY?.trim()) {
    throw new Error('forgewing_pricing_corpus_legacy_extraction_ai_must_be_disabled');
  }
  const availability = resolveForgewingPricingCorpusAvailability(entry);
  if (availability.status !== 'available' || !availability.sha256) {
    throw new Error(`forgewing_pricing_corpus_${availability.status}`);
  }
  if (!dependencies.task?.provider
    && (process.env.FORGEWING_SHADOW_ENABLED !== '1'
      || process.env.FORGEWING_PRICING_INTERPRETATION_ENABLED !== '1')) {
    throw new Error('forgewing_pricing_corpus_flags_disabled');
  }
  const runtimeConfig = dependencies.task?.config ?? getForgewingRuntimeConfig();

  const sourcePdfPath = resolve(entry.sourcePdfPath);
  const bytes = readFileSync(sourcePdfPath);
  const sourceDocumentId = `local-pricing-document-${availability.sha256.slice(0, 24)}`;
  const sourceArtifactId = opaqueIds.sourceArtifact({
    corpusKind: entry.corpusKind,
    sourceDocumentId,
    sourceSha256: availability.sha256,
  });
  const payload = await extractDocument({
    id: sourceDocumentId,
    title: 'Local pricing corpus fixture',
    name: 'pricing-corpus.pdf',
    document_type: entry.documentType,
    storage_path: sourcePdfPath,
  }, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  'application/pdf', 'pricing-corpus.pdf', { sourceDocumentId, sourceArtifactId });
  const extractionSnapshotId = opaqueIds.extractionSnapshot({
    sourceArtifactId,
    sourceSha256: availability.sha256,
    extractionPayloadHash: hashCanonical({
      documentId: payload.document_id,
      file: payload.file,
      extraction: payload.extraction,
      fields: payload.fields,
    }),
    documentType: entry.documentType,
    authoritativeRatePageRanges: entry.authoritativeRatePageRanges,
  });
  const pipeline = runDocumentPipeline({
    documentId: sourceDocumentId,
    documentType: entry.documentType,
    documentName: 'pricing-corpus.pdf',
    documentTitle: 'Local pricing corpus fixture',
    projectName: null,
    extractionData: payload as unknown as Record<string, unknown>,
    relatedDocs: [],
    rateSchedulePageRanges: [...entry.authoritativeRatePageRanges],
  });
  const pricingSourceEligibility = pipeline.contractAnalysis?.pricing_source_eligibility;
  const shadowInput: ForgewingPricingInterpretationShadowInput = {
    organizationId: 'local-evaluation-organization',
    sourceDocumentId,
    sourceArtifactId,
    extractionSnapshotId,
    pricingRows: pipeline.contractAnalysis?.rate_schedule_rows ?? [],
    sourceObservations: pipeline.evidence,
    pricingSourceEligibility,
  };
  const candidates = buildEligiblePricingReasoningShadowCandidates(shadowInput);
  const reversedCandidates = buildEligiblePricingReasoningShadowCandidates({
    ...shadowInput,
    pricingRows: [...shadowInput.pricingRows].reverse(),
    sourceObservations: [...shadowInput.sourceObservations].reverse(),
    pricingSourceEligibility: reversedEligibility(shadowInput.pricingSourceEligibility),
  });
  const orderingDeterministic = canonicalJson(candidates) === canonicalJson(reversedCandidates);

  const attempts = await runForgewingPricingCandidateAttempts(candidates, dependencies.task);
  const executionIdentity = hashCanonical({
    sourceSha256: availability.sha256,
    sourceArtifactId,
    extractionSnapshotId,
    candidateInputHashes: candidates.map((candidate: ForgewingPricingInterpretationInput) =>
      hashCanonical(candidate)),
    attemptIdentities: attempts.map((attempt) => ({
      rowObservationId: attempt.rowObservationId,
      inputSnapshotHash: attempt.inputSnapshotHash,
      taskId: attempt.taskId,
      runId: attempt.runId,
    })),
    runtime: {
      model: runtimeConfig.model,
      promptTemplateId: FORGEWING_PRICING_INTERPRETATION_PROMPT_ID,
      promptTemplateVersion: FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION,
      proposalSchemaVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
    },
  });
  return {
    reportVersion: 'forgewing-pricing-corpus-smoke-v1',
    authority: 'non_authoritative_measurement',
    corpusKind: entry.corpusKind,
    corpusIdentity: `generic/local-fixture:${availability.sha256}`,
    corpusStatus: 'unmet',
    smokeStatus: candidates.length > 0 ? 'completed' : 'completed_no_eligible_candidates',
    availability: 'available',
    pricingCorrectnessEvaluated: false,
    promotionEvidence: false,
    source: {
      sourcePdfPath,
      sourceSha256: availability.sha256,
      sourceByteLength: bytes.byteLength,
      sourceDocumentId,
      sourceArtifactId,
      extractionSnapshotId,
    },
    executionIdentity,
    runtime: {
      model: runtimeConfig.model,
      promptTemplateId: FORGEWING_PRICING_INTERPRETATION_PROMPT_ID,
      promptTemplateVersion: FORGEWING_PRICING_INTERPRETATION_PROMPT_VERSION,
      proposalSchemaVersion: FORGEWING_PRICING_INTERPRETATION_PROPOSAL_SCHEMA_VERSION,
    },
    orderingDeterministic,
    attempts,
    metrics: summarizeForgewingPricingCorpusAttempts(candidates.length, attempts),
  };
}

async function main(): Promise<void> {
  const sourcePdfPath = process.argv[2]?.trim();
  const pageRanges = process.env.FORGEWING_PRICING_CORPUS_PAGE_RANGES?.trim();
  if (!sourcePdfPath || !pageRanges) {
    throw new Error(
      'Usage: vite-node scripts/evaluation/runForgewingPricingCorpus.ts <pdf> [output.json] '
      + 'with FORGEWING_PRICING_CORPUS_PAGE_RANGES set',
    );
  }
  const report = await runForgewingPricingCorpus({
    sourcePdfPath,
    corpusKind: 'real_unlabelled_smoke',
    documentType: 'price_sheet',
    authoritativeRatePageRanges: parseRatePageRanges(pageRanges),
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = process.argv[3]?.trim();
  if (outputPath) writeFileSync(resolve(outputPath), serialized, 'utf8');
  else process.stdout.write(serialized);
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/runForgewingPricingCorpus.ts')) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
