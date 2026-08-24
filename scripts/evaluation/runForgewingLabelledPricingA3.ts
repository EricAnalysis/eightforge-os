/** Evaluation-only, default-off, human-attested labelled A3 orchestrator. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { auditLabelledPricingA3Ledger, FORGEWING_LABELLED_PRICING_A3_VERSION,
  type LabelledPricingA3CaseClassification } from '@/lib/evaluation/forgewing/labelledPricingA3';
import { validateForgewingLabelAttestation,
  type ForgewingLabelAttestationValidation } from '@/lib/evaluation/forgewing/labelledPricingAttestation';
import { parseForgewingLabelLinkageManifest, validateForgewingLabelLinkage,
  type ForgewingCandidateLabelLinkage } from '@/lib/evaluation/forgewing/labelledPricingLinkage';
import { parseRatePageRanges } from '@/lib/contracts/parseRatePageRanges';
import { callClaudeForPricingInterpretation, type ForgewingProvider } from '@/lib/forgewing/runtime/client';
import { getForgewingRuntimeConfig } from '@/lib/forgewing/runtime/modelConfig';
import { prepareForgewingPricingCorpus, runForgewingPricingCandidateAttempts,
  type ForgewingPricingCorpusAttempt, type ForgewingPricingCorpusEntry } from '@/scripts/evaluation/runForgewingPricingCorpus';

const HARD_CALL_BUDGET = 6;

type FrozenCandidate = Readonly<{
  candidateId: string; candidateDigestSha256: string; rowId: string; physicalPage: number;
  sourceAnchorIds: readonly string[]; resolutionState: string; eligibilityReason: string;
  labelLinkage: 'unmet_labels' | ForgewingCandidateLabelLinkage['linkageStatus'];
  labelObservationIds: readonly string[]; linkedRoles: readonly string[];
  linkedLabels: readonly Readonly<{ labelObservationId: string; labelRole: string;
    expectedSemanticRole: string; expectedRawText: string; sourceObservationIds: readonly string[] }>[];
}>;

type MeasuredCase = Readonly<{
  candidateId: string; rowObservationId: string; repetition: 'primary' | 'repeat';
  resultStatus: ForgewingPricingCorpusAttempt['resultStatus'];
  classification: LabelledPricingA3CaseClassification; semanticRoleCorrect: boolean | null;
  evidenceAnchorFidelity: 'valid' | 'invalid' | 'unverifiable'; abstained: boolean;
  confidence: number | null; citedEvidenceIds: readonly string[];
  hallucinatedEvidenceIds: readonly string[]; foreignCandidateEvidenceIds: readonly string[];
  foreignDocumentOrPageEvidenceIds: readonly string[]; diagnosticOnlyEvidenceIds: readonly string[];
  providerRawOutput: unknown | null; providerRawOutputSha256: string | null;
  proposalBundle: ForgewingPricingCorpusAttempt['proposalBundle']; warnings: readonly string[];
  failureReason: string | null;
  labelScores: readonly Readonly<{ labelObservationId: string; labelRole: string;
    expectedSemanticRole: string; correct: boolean }>[];
}>;

export type ForgewingLabelledPricingA3Artifact = Readonly<{
  reportVersion: typeof FORGEWING_LABELLED_PRICING_A3_VERSION;
  authority: 'non_authoritative_measurement'; promotionEvidence: false; promotionAuthorized: false;
  runIdentity: Readonly<{ runId: string; createdAt: string }>;
  sourceIdentity: Readonly<{ path: string; sha256: string; byteLength: number; pages: number;
    sourceDocumentId: string; sourceArtifactId: string; extractionSnapshotId: string }>;
  labelPackage: Readonly<{ ledgerPath: string; audit: ReturnType<typeof auditLabelledPricingA3Ledger>;
    promotionSuitable: false }>;
  humanAttestation: Readonly<{ path: string | null; sha256: string | null; supplied: boolean;
    reviewer: Readonly<{ stableHandle: string; reviewedAt: string }> | null;
    scope: unknown | null;
    validation: ForgewingLabelAttestationValidation | null;
    authority: 'evaluation_ground_truth_only'; promotionAuthorized: false }>;
  exactLabelLinkage: Readonly<{ path: string | null; sha256: string | null; supplied: boolean;
    status: 'label_linkage_ready' | 'label_linkage_gap'; failureReasons: readonly string[];
    scoredLabelObservationIds: readonly string[]; promotionAuthorized: false }>;
  modelIdentity: Readonly<{ provider: 'anthropic'; providerConfigured: boolean; model: string;
    taskVersion: string; promptVersion: string; schemaVersion: string;
    evaluationTimeoutMs: number; evaluationMaxOutputTokens: number }>;
  frozenProviderBundle: Readonly<{ frozenBeforeProviderCalls: true; digestSha256: string;
    taskVersion: string; promptVersion: string; schemaVersion: string;
    candidates: readonly FrozenCandidate[] }>;
  candidateScope: Readonly<{ totalLabelledRows: number; a2EligibleRows: number;
    providerCallCandidateRows: number; a3ScoredOutputs: number; orderingDeterministic: boolean;
    frozenCandidates: readonly FrozenCandidate[] }>;
  callBudget: Readonly<{ maximum: number; planned: number; callsAttempted: number;
    priorCalls: number; currentCallsAttempted: number; callsSucceeded: number;
    providerFailures: number; schemaValidOutputs: number; retries: number }>;
  priorRuns: readonly Readonly<{ path: string; sha256: string; callsAttempted: number;
    providerFailures: number; schemaValidOutputs: number }> [];
  corpusStatus: 'labelled_a3_unmet_labels' | 'labelled_a3_incomplete'
    | 'labelled_a3_provider_unavailable' | 'labelled_a3_measured';
  measurementClassification: 'UNMET' | 'INCOMPLETE' | 'MEASURED';
  metrics: Readonly<{ providerCallSuccessCount: number; providerCallSuccessRate: number | null;
    schemaValidOutputCount: number; schemaValidOutputRate: number | null; scoredLabelCount: number;
    correctlyClassifiedLabelCount: number; labelLinkageRate: number | null;
    semanticRoleAccuracy: number | null; descriptionRoleAccuracy: number | null;
    unitRoleAccuracy: number | null; rateCostRoleAccuracy: number | null; amountAccuracy: null;
    amountAccuracyStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL';
    citedAnchorCount: number; validCitedAnchorCount: number; hallucinatedAnchorCount: number;
    foreignCandidateAnchorCount: number; foreignDocumentOrPageAnchorCount: number;
    diagnosticOnlyAnchorCount: number; evidenceAnchorFidelity: number | null;
    hallucinatedAnchorRate: number | null; abstentionCount: number; safeAbstentionCount: number;
    inappropriateAbstentionCount: number; unsafeConfidentAnswerCount: number;
    abstentionRate: number | null; appropriateAbstentionRate: number | null;
    inappropriateConfidentAnswerRate: number | null; confidenceCalibration: 'NOT_MEASURED';
    repeatedRunStableCount: number; repeatedRunComparableCount: number;
    repeatedRunStability: number | 'NOT_MEASURED' }>;
  cases: readonly MeasuredCase[]; failureReasons: readonly string[];
}>;

function ratio(n: number, d: number): number | null { return d === 0 ? null : n / d; }

function warningClassification(warnings: readonly string[]): LabelledPricingA3CaseClassification | null {
  if (warnings.some((w) => ['anthropic_not_configured', 'provider_timeout', 'provider_error'].includes(w))) {
    return 'provider_failure';
  }
  if (warnings.some((w) => ['invalid_model_json', 'model_schema_rejected',
    'unknown_evidence_reference', 'unsupported_source_text'].includes(w))) return 'schema_failure';
  return null;
}

function scoreAttempt(params: { attempt: ForgewingPricingCorpusAttempt; candidate: FrozenCandidate;
  repetition: 'primary' | 'repeat'; rawOutput: string | null;
  allPersistedAnchorIds: ReadonlySet<string> }): MeasuredCase {
  const proposal = params.attempt.proposalBundle?.proposals[0] ?? null;
  const citations = [...new Set(proposal?.interpretations
    .flatMap((item) => item.evidenceArtifactIds) ?? [])].sort((a, b) => a.localeCompare(b, 'en-US'));
  const candidateAnchors = new Set(params.candidate.sourceAnchorIds);
  const hallucinated = citations.filter((id) => !params.allPersistedAnchorIds.has(id));
  const foreignCandidate = citations.filter((id) => params.allPersistedAnchorIds.has(id) && !candidateAnchors.has(id));
  const interpretations = proposal?.interpretations ?? [];
  const labelScores = params.candidate.linkedLabels.map((label) => {
    const evidence = new Set(interpretations.filter((item) => item.semanticRole === label.expectedSemanticRole)
      .flatMap((item) => item.evidenceArtifactIds));
    return { labelObservationId: label.labelObservationId, labelRole: label.labelRole,
      expectedSemanticRole: label.expectedSemanticRole,
      correct: label.sourceObservationIds.every((id) => evidence.has(id)) };
  });
  const semanticRoleCorrect = labelScores.length === 0 ? null : labelScores.every((item) => item.correct);
  const warningFailure = warningClassification(params.attempt.warnings);
  const abstained = proposal?.rowInterpretationState === 'insufficient_evidence'
    || (params.attempt.resultStatus === 'abstained' && warningFailure == null);
  const numericCostExpected = params.candidate.linkedLabels.some((label) =>
    label.labelRole === 'cost' && /\d/.test(label.expectedRawText));
  const classification = warningFailure
    ?? (abstained ? (numericCostExpected ? 'not_scored' : 'safe_abstention')
      : semanticRoleCorrect === true ? 'correct_answer' : 'unsafe_confident_answer');
  let providerRawOutput: unknown | null = null;
  if (params.rawOutput != null) {
    try { providerRawOutput = JSON.parse(params.rawOutput) as unknown; } catch { providerRawOutput = params.rawOutput; }
  }
  return { candidateId: params.candidate.candidateId, rowObservationId: params.candidate.rowId,
    repetition: params.repetition, resultStatus: params.attempt.resultStatus, classification,
    semanticRoleCorrect, evidenceAnchorFidelity: citations.length === 0 ? 'unverifiable'
      : hallucinated.length + foreignCandidate.length === 0 ? 'valid' : 'invalid', abstained,
    confidence: proposal?.confidence ?? null, citedEvidenceIds: citations,
    hallucinatedEvidenceIds: hallucinated, foreignCandidateEvidenceIds: foreignCandidate,
    foreignDocumentOrPageEvidenceIds: [], diagnosticOnlyEvidenceIds: [], providerRawOutput,
    providerRawOutputSha256: params.rawOutput == null ? null : sha256Hex(params.rawOutput),
    proposalBundle: params.attempt.proposalBundle, warnings: params.attempt.warnings,
    failureReason: params.attempt.failureReason, labelScores };
}

export async function runForgewingLabelledPricingA3(params: {
  entry: ForgewingPricingCorpusEntry; labelLedgerPath: string; attestationPath?: string;
  linkageManifestPath?: string; callBudget?: number; executeProvider?: boolean;
  repeatEachCandidate?: boolean; expectedCandidateIds?: readonly string[]; provider?: ForgewingProvider;
  providerTimeoutMs?: number; priorAttemptArtifactPaths?: readonly string[];
  providerMaxOutputTokens?: number; finalizePriorRuns?: boolean;
  onProviderReady?: (bundle: ForgewingLabelledPricingA3Artifact['frozenProviderBundle']) => void;
  now?: () => Date;
}): Promise<ForgewingLabelledPricingA3Artifact> {
  const maximum = params.callBudget ?? HARD_CALL_BUDGET;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > HARD_CALL_BUDGET) {
    throw new Error('forgewing_labelled_a3_invalid_call_budget');
  }
  const providerTimeoutMs = params.providerTimeoutMs ?? getForgewingRuntimeConfig().timeoutMs;
  if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 100 || providerTimeoutMs > 30_000) {
    throw new Error('forgewing_labelled_a3_invalid_provider_timeout');
  }
  const providerMaxOutputTokens = params.providerMaxOutputTokens ?? getForgewingRuntimeConfig().maxOutputTokens;
  if (!Number.isSafeInteger(providerMaxOutputTokens)
    || providerMaxOutputTokens < 128 || providerMaxOutputTokens > 2_000) {
    throw new Error('forgewing_labelled_a3_invalid_provider_output_budget');
  }
  const ledgerPath = resolve(params.labelLedgerPath);
  const ledgerBytes = readFileSync(ledgerPath);
  const labelAudit = auditLabelledPricingA3Ledger(JSON.parse(ledgerBytes.toString('utf8')));
  if (params.entry.expectedSourceSha256 !== labelAudit.source.sha256) throw new Error('SOURCE_MISMATCH');
  const preparation = await prepareForgewingPricingCorpus(params.entry);
  if (preparation.source.sourceSha256 !== labelAudit.source.sha256
    || preparation.source.sourceByteLength !== labelAudit.source.byteLength) throw new Error('SOURCE_MISMATCH');
  if (!preparation.orderingDeterministic) throw new Error('NON_DETERMINISTIC_INPUT_ORDER');

  const attestationPath = params.attestationPath ? resolve(params.attestationPath) : null;
  const attestationInput = attestationPath ? JSON.parse(readFileSync(attestationPath, 'utf8')) as unknown : null;
  const parsedAttestation = attestationInput as { reviewer?: { stable_handle?: string; reviewed_at?: string };
    scope?: unknown } | null;
  const attestationValidation = attestationPath
    ? validateForgewingLabelAttestation({ ledgerBytes, attestation: attestationInput }) : null;
  const labelsReady = attestationValidation?.status === 'human_attestation_valid';
  const linkagePath = params.linkageManifestPath ? resolve(params.linkageManifestPath) : null;
  const linkageBytes = linkagePath ? readFileSync(linkagePath) : null;
  const linkageInput = linkageBytes ? JSON.parse(linkageBytes.toString('utf8')) as unknown : null;
  const linkageValidation = labelsReady && linkagePath ? validateForgewingLabelLinkage({
    manifest: linkageInput, labelPackageSha256: sha256Hex(ledgerBytes),
    sourcePdfSha256: preparation.source.sourceSha256, linkageManifestSha256: sha256Hex(linkageBytes!),
    attestedLinkageManifestSha256: attestationValidation.linkageManifestSha256!, audit: labelAudit,
    candidates: preparation.candidates, attestedLabelObservationIds: attestationValidation.attestedLabelObservationIds,
    attestationScope: (attestationInput as { scope?: { kind?: string } }).scope?.kind === 'SCORING_SUBSET'
      ? 'SCORING_SUBSET' : 'FULL_PACKAGE' }) : null;
  const linkagesByRow = new Map(linkageValidation?.candidateLinkages.map((item) => [item.rowId, item]) ?? []);
  const linkageRecords = linkageInput ? parseForgewingLabelLinkageManifest(linkageInput).records : [];
  const recordsByCandidate = new Map<string, typeof linkageRecords>();
  for (const record of linkageRecords) {
    const records = recordsByCandidate.get(record.candidate_row_id) ?? [];
    records.push(record); recordsByCandidate.set(record.candidate_row_id, records);
  }
  const expectedById = new Map(labelAudit.expectedLabels.map((item) => [item.labelObservationId, item]));
  const frozenCandidates: FrozenCandidate[] = preparation.candidates.map((candidate) => {
    const rowId = candidate.rowObservation.observationId;
    const digest = hashCanonical(candidate);
    return { candidateId: digest, candidateDigestSha256: digest, rowId,
      physicalPage: candidate.rowObservation.physicalPageNumber,
      sourceAnchorIds: candidate.rowObservation.cells.map((cell) => cell.observationId),
      resolutionState: candidate.rowObservation.deterministicState,
      eligibilityReason: candidate.pricingScope.eligibilityReason,
      labelLinkage: labelsReady ? linkagesByRow.get(rowId)?.linkageStatus ?? 'missing_label_linkage' : 'unmet_labels',
      labelObservationIds: linkagesByRow.get(rowId)?.linkedLabelObservationIds ?? [],
      linkedRoles: linkagesByRow.get(rowId)?.linkedRoles ?? [],
      linkedLabels: (recordsByCandidate.get(rowId) ?? []).map((record) => {
        const expected = expectedById.get(record.label_observation_id)!;
        return { labelObservationId: record.label_observation_id, labelRole: record.label_role,
          expectedSemanticRole: expected.expectedSemanticRole, expectedRawText: expected.expectedRawText,
          sourceObservationIds: record.source_observation_ids };
      }) };
  });
  const actualIds = frozenCandidates.map((item) => item.candidateId).sort((a, b) => a.localeCompare(b, 'en-US'));
  if (params.expectedCandidateIds && hashCanonical(actualIds) !== hashCanonical([...params.expectedCandidateIds]
    .sort((a, b) => a.localeCompare(b, 'en-US')))) throw new Error('FROZEN_CANDIDATE_IDENTITY_CHANGED');
  const frozenProviderBundle = { frozenBeforeProviderCalls: true as const,
    digestSha256: hashCanonical({ runtime: preparation.runtime, candidates: frozenCandidates }),
    taskVersion: preparation.runtime.promptTemplateId,
    promptVersion: preparation.runtime.promptTemplateVersion,
    schemaVersion: preparation.runtime.proposalSchemaVersion,
    candidates: frozenCandidates };
  const priorArtifacts = (params.priorAttemptArtifactPaths ?? []).map((path) => {
    const absolutePath = resolve(path);
    const bytes = readFileSync(absolutePath);
    const artifact = JSON.parse(bytes.toString('utf8')) as ForgewingLabelledPricingA3Artifact;
    if (artifact.sourceIdentity.sha256 !== preparation.source.sourceSha256
      || artifact.frozenProviderBundle.digestSha256 !== frozenProviderBundle.digestSha256
      || artifact.modelIdentity.model !== preparation.runtime.model) {
      throw new Error('PRIOR_A3_RUN_IDENTITY_MISMATCH');
    }
    return { path: absolutePath, sha256: sha256Hex(bytes), artifact };
  });
  const priorCalls = priorArtifacts.reduce((sum, item) => sum + item.artifact.callBudget.callsAttempted, 0);
  const priorRetries = priorArtifacts.reduce((sum, item) =>
    sum + item.artifact.callBudget.retries, 0);
  if (params.finalizePriorRuns && (params.executeProvider || priorCalls === 0)) {
    throw new Error('forgewing_labelled_a3_invalid_prior_finalization');
  }
  const planned = params.executeProvider ? frozenCandidates.length * (params.repeatEachCandidate ? 2 : 1) : 0;
  const linkageReady = linkageValidation?.status === 'label_linkage_ready';
  if (params.executeProvider) {
    if (!labelsReady) throw new Error('HUMAN_ATTESTATION_REQUIRED');
    if (!linkageReady) throw new Error('LABEL_LINKAGE_GAP');
    if (frozenCandidates.length === 0) throw new Error('NO_ELIGIBLE_CANDIDATES');
    if (priorCalls + planned > maximum || priorCalls + planned > HARD_CALL_BUDGET) {
      throw new Error('PROVIDER_CALL_BUDGET_EXCEEDED');
    }
    if (!params.provider && !process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY_REQUIRED');
    params.onProviderReady?.(frozenProviderBundle);
  }

  const currentCases: MeasuredCase[] = [];
  const allPersistedAnchorIds = new Set(preparation.pricingLayoutObservations.map((item) => item.id));
  const runtime = getForgewingRuntimeConfig();
  const provider = params.provider ?? callClaudeForPricingInterpretation;
  if (params.executeProvider) {
    const runRepetition = async (repetition: 'primary' | 'repeat'): Promise<void> => {
      for (let index = 0; index < preparation.candidates.length; index += 1) {
        let rawOutput: string | null = null;
        const attempts = await runForgewingPricingCandidateAttempts([preparation.candidates[index]], {
          config: { ...runtime, enabled: true, maxCalls: 1, timeoutMs: providerTimeoutMs }, taskEnabled: true,
          provider: async (request) => {
            const raw = await provider({ ...request, maxOutputTokens: providerMaxOutputTokens });
            rawOutput = raw; return raw;
          } });
        currentCases.push(scoreAttempt({ attempt: attempts[0], candidate: frozenCandidates[index],
          repetition, rawOutput, allPersistedAnchorIds }));
      }
    };
    await runRepetition('primary');
    const primariesSucceeded = currentCases.every((item) => item.repetition !== 'primary'
      || !['provider_failure', 'schema_failure'].includes(item.classification));
    if (params.repeatEachCandidate && primariesSucceeded) await runRepetition('repeat');
  }
  const cases = [...priorArtifacts.flatMap((item) => item.artifact.cases), ...currentCases]
    .map((item) => ['provider_failure', 'schema_failure'].includes(item.classification)
      ? { ...item, abstained: false } : item);
  const currentCallsAttempted = currentCases.filter((item) => item.resultStatus !== 'skipped').length;
  const callsAttempted = priorCalls + currentCallsAttempted;
  const providerFailures = cases.filter((item) => item.classification === 'provider_failure').length;
  const schemaFailures = cases.filter((item) => item.classification === 'schema_failure').length;
  const callsSucceeded = callsAttempted - providerFailures;
  const schemaValidOutputs = callsAttempted - providerFailures - schemaFailures;
  const scoredCases = frozenCandidates.flatMap((candidate) => {
    const matching = cases.filter((item) => item.candidateId === candidate.candidateId);
    const valid = matching.filter((item) => !['provider_failure', 'schema_failure'].includes(item.classification));
    return [valid.at(-1) ?? matching.at(-1)].filter((item): item is MeasuredCase => item != null);
  });
  const validScoredCases = scoredCases.filter((item) =>
    !['provider_failure', 'schema_failure'].includes(item.classification));
  const scoredLabelCount = frozenCandidates.reduce((sum, item) => sum + item.linkedLabels.length, 0);
  const correctlyClassifiedLabelCount = validScoredCases.reduce((sum, item) =>
    sum + item.labelScores.filter((score) => score.correct).length, 0);
  const roleAccuracy = (role: string): number | null => {
    const scores = validScoredCases.flatMap((item) => item.labelScores).filter((item) => item.labelRole === role);
    return ratio(scores.filter((item) => item.correct).length, scores.length);
  };
  const citedAnchorCount = cases.reduce((sum, item) => sum + item.citedEvidenceIds.length, 0);
  const hallucinatedAnchorCount = cases.reduce((sum, item) => sum + item.hallucinatedEvidenceIds.length, 0);
  const foreignCandidateAnchorCount = cases.reduce((sum, item) => sum + item.foreignCandidateEvidenceIds.length, 0);
  const foreignDocumentOrPageAnchorCount = cases.reduce((sum, item) => sum + item.foreignDocumentOrPageEvidenceIds.length, 0);
  const diagnosticOnlyAnchorCount = cases.reduce((sum, item) => sum + item.diagnosticOnlyEvidenceIds.length, 0);
  const invalidAnchorCount = hallucinatedAnchorCount + foreignCandidateAnchorCount
    + foreignDocumentOrPageAnchorCount + diagnosticOnlyAnchorCount;
  const abstentionCount = cases.filter((item) => item.abstained).length;
  const safeAbstentionCount = cases.filter((item) => item.classification === 'safe_abstention').length;
  const inappropriateAbstentionCount = cases.filter((item) => item.abstained
    && !['safe_abstention', 'provider_failure', 'schema_failure'].includes(item.classification)).length;
  const unsafeConfidentAnswerCount = cases.filter((item) => item.classification === 'unsafe_confident_answer').length;
  const pairs = params.repeatEachCandidate ? frozenCandidates.map((candidate) => {
    const pair = currentCases.filter((item) => item.candidateId === candidate.candidateId);
    const comparable = (item: MeasuredCase) => ({ classification: item.classification,
      semanticRoleCorrect: item.semanticRoleCorrect, proposal: item.proposalBundle?.proposals[0] ?? null });
    return pair.length === 2 && hashCanonical(comparable(pair[0])) === hashCanonical(comparable(pair[1]));
  }) : [];
  const validCandidateCount = new Set(validScoredCases.map((item) => item.candidateId)).size;
  const completed = validCandidateCount === frozenCandidates.length && frozenCandidates.length > 0;
  const corpusStatus = !labelsReady ? 'labelled_a3_unmet_labels'
    : !params.executeProvider && !params.finalizePriorRuns ? 'labelled_a3_incomplete'
    : params.executeProvider && currentCases.filter((item) =>
      item.classification === 'provider_failure').length === currentCallsAttempted
      ? 'labelled_a3_provider_unavailable'
    : completed ? 'labelled_a3_measured' : 'labelled_a3_incomplete';
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const runId = `forgewing-labelled-a3-${hashCanonical({ sourceSha256: preparation.source.sourceSha256,
    labelVersion: labelAudit.package.ledgerVersion, candidateIds: actualIds,
    frozenBundleDigest: frozenProviderBundle.digestSha256, createdAt }).slice(0, 32)}`;
  const failureReasons = !labelsReady ? attestationValidation?.failureReasons ?? ['human_attestation_missing']
    : !linkageReady ? ['LABEL_LINKAGE_GAP', ...(linkageValidation?.failureReasons ?? [])]
    : !params.executeProvider && !params.finalizePriorRuns ? ['PROVIDER_DISABLED_PREFLIGHT']
    : [...new Set(cases.flatMap((item) => item.warnings))];
  return { reportVersion: FORGEWING_LABELLED_PRICING_A3_VERSION,
    authority: 'non_authoritative_measurement', promotionEvidence: false, promotionAuthorized: false,
    runIdentity: { runId, createdAt }, sourceIdentity: { path: preparation.source.sourcePdfPath,
      sha256: preparation.source.sourceSha256, byteLength: preparation.source.sourceByteLength,
      pages: labelAudit.source.pages, sourceDocumentId: preparation.source.sourceDocumentId,
      sourceArtifactId: preparation.source.sourceArtifactId,
      extractionSnapshotId: preparation.source.extractionSnapshotId },
    labelPackage: { ledgerPath, audit: labelAudit, promotionSuitable: false },
    humanAttestation: { path: attestationPath, sha256: attestationPath
        ? sha256Hex(readFileSync(attestationPath)) : null, supplied: attestationPath != null,
      reviewer: parsedAttestation?.reviewer?.stable_handle && parsedAttestation.reviewer.reviewed_at
        ? { stableHandle: parsedAttestation.reviewer.stable_handle,
          reviewedAt: parsedAttestation.reviewer.reviewed_at } : null,
      scope: parsedAttestation?.scope ?? null,
      validation: attestationValidation, authority: 'evaluation_ground_truth_only', promotionAuthorized: false },
    exactLabelLinkage: { path: linkagePath, sha256: linkageBytes ? sha256Hex(linkageBytes) : null,
      supplied: linkagePath != null,
      status: linkageValidation?.status ?? 'label_linkage_gap',
      failureReasons: linkageValidation?.failureReasons ?? ['linkage_manifest_missing'],
      scoredLabelObservationIds: linkageValidation?.scoredLabelObservationIds ?? [], promotionAuthorized: false },
    modelIdentity: { provider: 'anthropic', providerConfigured: Boolean(params.provider
      || process.env.ANTHROPIC_API_KEY?.trim() || priorArtifacts.length > 0), model: preparation.runtime.model,
      taskVersion: preparation.runtime.promptTemplateId, promptVersion: preparation.runtime.promptTemplateVersion,
      schemaVersion: preparation.runtime.proposalSchemaVersion, evaluationTimeoutMs: providerTimeoutMs,
      evaluationMaxOutputTokens: providerMaxOutputTokens }, frozenProviderBundle,
    candidateScope: { totalLabelledRows: labelAudit.denominators.totalDistinctRows,
      a2EligibleRows: preparation.candidates.length, providerCallCandidateRows: linkageReady ? frozenCandidates.length : 0,
      a3ScoredOutputs: cases.length, orderingDeterministic: preparation.orderingDeterministic, frozenCandidates },
    callBudget: { maximum, planned, priorCalls, currentCallsAttempted, callsAttempted, callsSucceeded,
      providerFailures, schemaValidOutputs, retries: priorRetries },
    priorRuns: priorArtifacts.map((item) => ({ path: item.path, sha256: item.sha256,
      callsAttempted: item.artifact.callBudget.callsAttempted,
      providerFailures: item.artifact.callBudget.providerFailures,
      schemaValidOutputs: item.artifact.callBudget.schemaValidOutputs })), corpusStatus,
    measurementClassification: !params.executeProvider && !params.finalizePriorRuns
      ? 'UNMET' : completed ? 'MEASURED' : 'INCOMPLETE',
    metrics: { providerCallSuccessCount: callsSucceeded, providerCallSuccessRate: ratio(callsSucceeded, callsAttempted),
      schemaValidOutputCount: schemaValidOutputs, schemaValidOutputRate: ratio(schemaValidOutputs, callsAttempted),
      scoredLabelCount, correctlyClassifiedLabelCount,
      labelLinkageRate: ratio(frozenCandidates.filter((item) => item.labelLinkage === 'exact_linkage_complete').length,
        frozenCandidates.length), semanticRoleAccuracy: completed
        ? ratio(correctlyClassifiedLabelCount, scoredLabelCount) : null,
      descriptionRoleAccuracy: roleAccuracy('description'), unitRoleAccuracy: roleAccuracy('unit'),
      rateCostRoleAccuracy: roleAccuracy('cost'), amountAccuracy: null,
      amountAccuracyStatus: 'NOT_MEASURED_SCHEMA_HAS_NO_NUMERIC_PROPOSAL', citedAnchorCount,
      validCitedAnchorCount: citedAnchorCount - invalidAnchorCount, hallucinatedAnchorCount,
      foreignCandidateAnchorCount, foreignDocumentOrPageAnchorCount, diagnosticOnlyAnchorCount,
      evidenceAnchorFidelity: ratio(citedAnchorCount - invalidAnchorCount, citedAnchorCount),
      hallucinatedAnchorRate: ratio(hallucinatedAnchorCount, citedAnchorCount), abstentionCount,
      safeAbstentionCount, inappropriateAbstentionCount, unsafeConfidentAnswerCount,
      abstentionRate: ratio(abstentionCount, cases.length),
      appropriateAbstentionRate: ratio(safeAbstentionCount, abstentionCount),
      inappropriateConfidentAnswerRate: ratio(unsafeConfidentAnswerCount, cases.length),
      confidenceCalibration: 'NOT_MEASURED', repeatedRunStableCount: pairs.filter(Boolean).length,
      repeatedRunComparableCount: pairs.length,
      repeatedRunStability: pairs.length === 0 ? 'NOT_MEASURED' : pairs.filter(Boolean).length / pairs.length },
    cases, failureReasons };
}

export function parseForgewingLabelledPricingA3Cli(argv: readonly string[]): Readonly<{
  entry: ForgewingPricingCorpusEntry; labelLedgerPath: string; attestationPath?: string;
  linkageManifestPath?: string; outputPath: string; freezeOutputPath?: string; callBudget: number;
  executeProvider: boolean; repeatEachCandidate: boolean; expectedCandidateIds?: readonly string[];
  providerTimeoutMs?: number; providerMaxOutputTokens?: number;
  priorAttemptArtifactPaths?: readonly string[]; finalizePriorRuns: boolean }> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: {
    source: { type: 'string' }, labels: { type: 'string' }, attestation: { type: 'string' },
    linkage: { type: 'string' }, 'document-type': { type: 'string' }, 'expected-sha256': { type: 'string' },
    'page-ranges': { type: 'string' }, output: { type: 'string' }, 'freeze-output': { type: 'string' },
    'max-calls': { type: 'string' }, 'execute-provider': { type: 'boolean' }, repeat: { type: 'boolean' },
    'expected-candidates': { type: 'string' }, 'provider-timeout-ms': { type: 'string' },
    'provider-max-output-tokens': { type: 'string' },
    'prior-run': { type: 'string', multiple: true }, 'finalize-prior-runs': { type: 'boolean' } } });
  if (!values.source || !values.labels || !values['document-type'] || !values['expected-sha256']
    || !values['page-ranges'] || !values.output) throw new Error('forgewing_labelled_a3_missing_required_argument');
  if (values['execute-provider'] && !values['freeze-output']) throw new Error('forgewing_labelled_a3_freeze_output_required');
  return { entry: { sourcePdfPath: values.source, optionalLabelPackagePath: values.labels,
      corpusKind: 'real_labelled_corpus', expectedSourceSha256: values['expected-sha256'],
      documentType: values['document-type'], authoritativeRatePageRanges: parseRatePageRanges(values['page-ranges']) },
    labelLedgerPath: values.labels, ...(values.attestation ? { attestationPath: values.attestation } : {}),
    ...(values.linkage ? { linkageManifestPath: values.linkage } : {}), outputPath: values.output,
    ...(values['freeze-output'] ? { freezeOutputPath: values['freeze-output'] } : {}),
    callBudget: values['max-calls'] == null ? HARD_CALL_BUDGET : Number(values['max-calls']),
    executeProvider: values['execute-provider'] ?? false, repeatEachCandidate: values.repeat ?? false,
    ...(values['expected-candidates'] ? { expectedCandidateIds: values['expected-candidates'].split(',') } : {}),
    ...(values['provider-timeout-ms'] ? { providerTimeoutMs: Number(values['provider-timeout-ms']) } : {}),
    ...(values['provider-max-output-tokens']
      ? { providerMaxOutputTokens: Number(values['provider-max-output-tokens']) } : {}),
    ...(values['prior-run'] ? { priorAttemptArtifactPaths: values['prior-run'] } : {}),
    finalizePriorRuns: values['finalize-prior-runs'] ?? false };
}

export async function main(): Promise<void> {
  const cli = parseForgewingLabelledPricingA3Cli(process.argv.slice(2));
  const artifact = await runForgewingLabelledPricingA3({ ...cli,
    onProviderReady: cli.freezeOutputPath ? (bundle) => {
      const freezePath = resolve(cli.freezeOutputPath!); mkdirSync(dirname(freezePath), { recursive: true });
      writeFileSync(freezePath, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } : undefined });
  const outputPath = resolve(cli.outputPath); mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${outputPath}\n`);
}

if (process.env.FORGEWING_LABELLED_A3_CLI === '1'
  || process.argv.some((value) => value.replaceAll('\\', '/').endsWith('/runForgewingLabelledPricingA3.ts'))) {
  void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1; });
}
