/** Evaluation-only, default-off, human-attested labelled A3 orchestrator. */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import type { ForgewingPricingSemanticRole } from '@/lib/forgewing/proposal/schema';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';
import { prepareForgewingPricingCorpus, runForgewingPricingCandidateAttempts,
  type ForgewingPricingCorpusAttempt, type ForgewingPricingCorpusEntry } from '@/scripts/evaluation/runForgewingPricingCorpus';

const HARD_CALL_BUDGET = 6;

export type A3EvaluationPromptVariant = Readonly<{
  identifier: string;
  promptSha256: string;
}>;

export type SourceCellGroup = NonNullable<
  ForgewingPricingInterpretationInput['rowObservation']['sourceCellGroups']
>[number];

export type FrozenLinkedLabel = Readonly<{ labelObservationId: string; labelRole: string;
  expectedSemanticRole: ForgewingPricingSemanticRole; expectedRawText: string;
  sourceObservationIds: readonly string[]; sourceCellGroup: SourceCellGroup }>;

export type FrozenCandidate = Readonly<{
  candidateId: string; candidateDigestSha256: string; rowId: string; physicalPage: number;
  candidateInput: ForgewingPricingInterpretationInput; sourceCellGroups: readonly SourceCellGroup[];
  sourceAnchorIds: readonly string[]; resolutionState: string; eligibilityReason: string;
  labelLinkage: 'unmet_labels' | ForgewingCandidateLabelLinkage['linkageStatus'];
  labelObservationIds: readonly string[]; linkedRoles: readonly string[];
  linkedLabels: readonly FrozenLinkedLabel[];
}>;

type A3AttemptKind = 'primary' | 'corrective_retry' | 'repeat';

export type A3FieldScoreState = 'CORRECT' | 'INCORRECT_CONTRADICTORY_ROLE'
  | 'INSUFFICIENT_SEMANTIC_SUPPORT' | 'UNSCORED';

export type A3PrimitiveInterpretation = Readonly<{ sourceCellId: string;
  semanticRole: ForgewingPricingSemanticRole; evidenceArtifactIds: readonly string[] }>;

export type A3FieldScore = Readonly<{ labelObservationId: string; labelRole: string;
  expectedSemanticRole: ForgewingPricingSemanticRole; sourceCellRole: SourceCellGroup['sourceCellRole'];
  linkedSourceObservationIds: readonly string[]; state: A3FieldScoreState; correct: boolean;
  supportingSourceObservationIds: readonly string[]; neutralSourceObservationIds: readonly string[];
  missingSourceObservationIds: readonly string[];
  contradictoryInterpretations: readonly A3PrimitiveInterpretation[] }>;

type MeasuredCase = Readonly<{
  candidateId: string; rowObservationId: string; repetition: A3AttemptKind;
  resultStatus: ForgewingPricingCorpusAttempt['resultStatus'];
  classification: LabelledPricingA3CaseClassification; semanticRoleCorrect: boolean | null;
  evidenceAnchorFidelity: 'valid' | 'invalid' | 'unverifiable'; abstained: boolean;
  confidence: number | null; citedEvidenceIds: readonly string[];
  hallucinatedEvidenceIds: readonly string[]; foreignCandidateEvidenceIds: readonly string[];
  foreignDocumentOrPageEvidenceIds: readonly string[]; diagnosticOnlyEvidenceIds: readonly string[];
  providerRawOutput: unknown | null; providerRawOutputSha256: string | null;
  proposalBundle: ForgewingPricingCorpusAttempt['proposalBundle']; warnings: readonly string[];
  failureReason: string | null;
  fieldScores: readonly A3FieldScore[]; labelScores: readonly A3FieldScore[];
  primitiveInterpretations: readonly A3PrimitiveInterpretation[];
  responseMetadata: Readonly<{ model: string | null; promptVersion: string; schemaVersion: string;
    inputSnapshotHash: string | null; taskId: string | null; runId: string | null;
    providerCallCount: number; outputByteLength: number | null }>;
  acceptedForScoring: boolean; rawAcceptedOutput: string | null; rawRejectedDiagnostic: string | null;
}>;

type A3PlannedCall = Readonly<{ sequence: number; candidateId: string; rowId: string;
  repetition: 'primary' | 'repeat' }>;

export type A3RunIdentity = Readonly<{ runId: string; createdAt: string; runNonce: string }>;

export type A3PreCallReport = Readonly<{ runIdentity: A3RunIdentity;
  attestationValid: boolean; linkageValid: boolean;
  sourceValid: boolean; scoringContractValid: boolean; candidateCount: number;
  candidateIds: readonly string[]; candidateDigests: readonly string[]; candidateBundleDigest: string;
  provider: 'anthropic'; model: string; promptVersion: string; schemaVersion: string;
  outputTokenLimit: number; timeoutMs: number; sdkRetries: 0; taskRetryLimitPerCandidate: 0 | 1;
  plannedCalls: number; hardCallLimit: number;
  evaluationPromptVariant?: Readonly<{ identifier: string; promptSha256: string;
    effectiveCallContractDigestSha256: string }> }>;

export type A3FreezeArtifact = Readonly<{ runIdentity: A3RunIdentity;
  implementationIdentity: ForgewingLabelledPricingA3Artifact['implementationIdentity'];
  inputIdentities: Readonly<{ sourceSha256: string; sourceByteLength: number;
    labelPackageSha256: string; attestationSha256: string; linkageSha256: string }>;
  preCallReport: A3PreCallReport;
  frozenProviderBundle: ForgewingLabelledPricingA3Artifact['frozenProviderBundle'];
  callConfiguration: Readonly<{ executeProvider: boolean; repeatEachCandidate: boolean;
    configuredCallBudget: number; plannedCalls: number; hardCallLimit: number;
    provider: 'anthropic'; model: string; promptVersion: string; schemaVersion: string;
    temperature: 0; structuredOutput: 'json_schema'; outputTokenLimit: number;
    timeoutMs: number; sdkRetries: 0; taskRetryLimitPerCandidate: 0 | 1;
    evaluationPromptVariant?: Readonly<{ identifier: string; promptSha256: string;
      effectiveCallContractDigestSha256: string }> }> }>;

export type A3InterruptionArtifact = Readonly<{ runIdentity: A3RunIdentity;
  implementationIdentity: ForgewingLabelledPricingA3Artifact['implementationIdentity'];
  preCallReport: A3PreCallReport; frozenProviderBundleDigest: string;
  interruption: Readonly<{ interruptedAt: string; reason: 'A3_RUN_INTERRUPTED_AFTER_FREEZE';
    callsAttempted: number; completedCallRecords: number }> }>;

export type A3InterruptionPersistenceFailureDiagnostic = Readonly<{
  code: 'A3_INTERRUPTION_ARTIFACT_PERSISTENCE_FAILED'; runId: string; failureOutputPath: string;
  callsAttempted: number; completedCallRecords: number;
  primaryError: Readonly<{ name: string; message: string; code: string | null }>;
  persistenceError: Readonly<{ name: string; message: string; code: string | null }>;
}>;

type A3ProviderCallRecord = Readonly<{ runIdentity: A3RunIdentity;
  sequence: number; candidateId: string; rowId: string;
  repetition: A3AttemptKind; startedAt: string; completedAt: string; durationMs: number;
  providerInvoked: boolean; resultStatus: ForgewingPricingCorpusAttempt['resultStatus'];
  warnings: readonly string[]; failureReason: string | null; outputByteLength: number | null;
  outputSha256: string | null; acceptedForScoring: boolean }>;

export type ForgewingLabelledPricingA3Artifact = Readonly<{
  reportVersion: typeof FORGEWING_LABELLED_PRICING_A3_VERSION;
  authority: 'non_authoritative_measurement'; promotionEvidence: false; promotionAuthorized: false;
  runIdentity: A3RunIdentity;
  implementationIdentity: Readonly<{ commit: string | null; parentOrBase: string | null;
    worktreeDirty: boolean | null }>;
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
    evaluationTimeoutMs: number; evaluationMaxOutputTokens: number; temperature: 0;
    structuredOutput: 'json_schema'; sdkRetries: 0; taskRetryLimitPerCandidate: 0 | 1 }>;
  frozenProviderBundle: Readonly<{ frozenBeforeProviderCalls: true; digestSha256: string;
    taskVersion: string; promptVersion: string; schemaVersion: string;
    candidates: readonly FrozenCandidate[] }>;
  candidateScope: Readonly<{ totalLabelledRows: number; a2EligibleRows: number;
    providerCallCandidateRows: number; a3ScoredOutputs: number; orderingDeterministic: boolean;
    frozenCandidates: readonly FrozenCandidate[] }>;
  callBudget: Readonly<{ maximum: number; planned: number; callsAttempted: number;
    priorCalls: number; currentCallsAttempted: number; callsSucceeded: number;
    providerFailures: number; truncatedOutputs: number; jsonParseFailures: number;
    schemaFailures: number; schemaValidOutputs: number; retries: number }>;
  preCallReport: A3PreCallReport; plannedCallSequence: readonly A3PlannedCall[];
  priorProviderCallSequence: readonly A3ProviderCallRecord[];
  currentProviderCallSequence: readonly A3ProviderCallRecord[];
  providerCallSequence: readonly A3ProviderCallRecord[];
  outputs: Readonly<{ acceptedRawOutputs: readonly Readonly<{ candidateId: string;
    repetition: A3AttemptKind; rawOutput: string }>[];
    rejectedRawDiagnostics: readonly Readonly<{ candidateId: string; repetition: A3AttemptKind;
      rawOutput: string | null; warnings: readonly string[]; failureReason: string | null }>[] }>;
  priorRuns: readonly Readonly<{ path: string; sha256: string; callsAttempted: number;
    providerFailures: number; schemaValidOutputs: number }> [];
  historicalRuns: readonly Readonly<{ path: string; sha256: string; runId: string;
    corpusStatus: ForgewingLabelledPricingA3Artifact['corpusStatus']; callsAttempted: number }> [];
  corpusStatus: 'labelled_a3_unmet_labels' | 'labelled_a3_incomplete'
    | 'labelled_a3_provider_unavailable' | 'labelled_a3_measured';
  measurementClassification: 'UNMET' | 'INCOMPLETE' | 'MEASURED';
  metrics: Readonly<{ providerCallSuccessCount: number; providerCallSuccessRate: number | null;
    schemaValidOutputCount: number; schemaValidOutputRate: number | null;
    humanLabelCount: number; scoredLabelCount: number; unscoredLabelCount: number;
    correctLabelCount: number; correctlyClassifiedLabelCount: number;
    fieldScoreCount: number; fieldScoringCoverage: number | null;
    semanticAccuracyAmongScored: number | null; fixedDenominatorCorrectness: number | null;
    roleLabelMetrics: Readonly<Record<string, Readonly<{ total: number; scored: number;
      unscored: number; correct: number; fieldScoringCoverage: number | null;
      semanticAccuracyAmongScored: number | null; fixedDenominatorCorrectness: number | null }>>>;
    labelLinkageRate: number | null;
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
  cases: readonly MeasuredCase[]; failureReasons: readonly string[]; limitations: readonly string[];
}>;

function ratio(n: number, d: number): number | null { return d === 0 ? null : n / d; }

const HUMAN_ROLE_TO_SOURCE_GROUP = {
  description: 'description', unit: 'unit', cost: 'rate',
} as const;

function sameIdentitySet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === new Set(left).size && right.length === new Set(right).size
    && left.length === right.length && left.every((id) => right.includes(id));
}

export function validateSourceCellGroupClosure(params: { cellIds: readonly string[];
  sourceCellGroups: readonly SourceCellGroup[] }): void {
  if (params.cellIds.length === 0 || params.sourceCellGroups.length === 0
    || new Set(params.cellIds).size !== params.cellIds.length) {
    throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  }
  const groupedIds = params.sourceCellGroups.flatMap((group) => group.sourceObservationIds);
  if (groupedIds.length !== new Set(groupedIds).size
    || !sameIdentitySet(params.cellIds, groupedIds)) {
    throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  }
}

export function resolveHumanLabelSourceGroup(params: { labelRole: string;
  sourceObservationIds: readonly string[]; sourceCellGroups: readonly SourceCellGroup[] }): SourceCellGroup {
  const expectedGroupRole = HUMAN_ROLE_TO_SOURCE_GROUP[
    params.labelRole as keyof typeof HUMAN_ROLE_TO_SOURCE_GROUP
  ];
  if (!expectedGroupRole || params.sourceObservationIds.length === 0) {
    throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  }
  const matches = params.sourceCellGroups.filter((group) =>
    sameIdentitySet(group.sourceObservationIds, params.sourceObservationIds));
  if (matches.length !== 1 || matches[0]?.sourceCellRole !== expectedGroupRole) {
    throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  }
  return matches[0];
}

export function scoreHumanLinkedField(params: { label: FrozenLinkedLabel;
  interpretations: readonly A3PrimitiveInterpretation[] | null }): A3FieldScore {
  const linkedIds = [...params.label.sourceObservationIds];
  if (params.interpretations == null) {
    return { labelObservationId: params.label.labelObservationId, labelRole: params.label.labelRole,
      expectedSemanticRole: params.label.expectedSemanticRole,
      sourceCellRole: params.label.sourceCellGroup.sourceCellRole,
      linkedSourceObservationIds: linkedIds, state: 'UNSCORED', correct: false,
      supportingSourceObservationIds: [], neutralSourceObservationIds: [],
      missingSourceObservationIds: linkedIds, contradictoryInterpretations: [] };
  }
  const linked = new Set(linkedIds);
  const direct = params.interpretations.filter((item) => linked.has(item.sourceCellId)
    && item.evidenceArtifactIds.includes(item.sourceCellId));
  const covered = new Set(direct.map((item) => item.sourceCellId));
  const supporting = [...new Set(direct.filter((item) =>
    item.semanticRole === params.label.expectedSemanticRole).map((item) => item.sourceCellId))];
  const neutral = [...new Set(direct.filter((item) => item.semanticRole === 'unknown')
    .map((item) => item.sourceCellId))];
  const contradictory = direct.filter((item) => item.semanticRole !== params.label.expectedSemanticRole
    && item.semanticRole !== 'unknown');
  const missing = linkedIds.filter((id) => !covered.has(id));
  const state: A3FieldScoreState = contradictory.length > 0
    ? 'INCORRECT_CONTRADICTORY_ROLE'
    : missing.length > 0 || supporting.length === 0
      ? 'INSUFFICIENT_SEMANTIC_SUPPORT' : 'CORRECT';
  return { labelObservationId: params.label.labelObservationId, labelRole: params.label.labelRole,
    expectedSemanticRole: params.label.expectedSemanticRole,
    sourceCellRole: params.label.sourceCellGroup.sourceCellRole,
    linkedSourceObservationIds: linkedIds, state, correct: state === 'CORRECT',
    supportingSourceObservationIds: supporting.sort((a, b) => a.localeCompare(b, 'en-US')),
    neutralSourceObservationIds: neutral.sort((a, b) => a.localeCompare(b, 'en-US')),
    missingSourceObservationIds: missing,
    contradictoryInterpretations: contradictory };
}

export function countValidatedHumanLabels(
  candidates: readonly Readonly<{ linkedLabels: readonly FrozenLinkedLabel[] }>[],
): number {
  const ids = candidates.flatMap((candidate) =>
    candidate.linkedLabels.map((label) => label.labelObservationId));
  if (new Set(ids).size !== ids.length) throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  return ids.length;
}

export function summarizeA3FieldScores(
  cases: readonly Readonly<{ fieldScores: readonly A3FieldScore[] }>[],
  scoredLabelCount: number,
): Readonly<{ fieldScoreCount: number; correctlyClassifiedLabelCount: number;
  fieldScoringCoverage: number | null }> {
  const scores = cases.flatMap((item) => item.fieldScores)
    .filter((score) => score.state !== 'UNSCORED');
  return { fieldScoreCount: scores.length,
    correctlyClassifiedLabelCount: scores.filter((score) => score.correct).length,
    fieldScoringCoverage: ratio(scores.length, scoredLabelCount) };
}

function implementationIdentity(): ForgewingLabelledPricingA3Artifact['implementationIdentity'] {
  try {
    const git = (args: readonly string[]) => execFileSync('git', [...args], {
      cwd: process.cwd(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return { commit: git(['rev-parse', 'HEAD']), parentOrBase: git(['rev-parse', 'HEAD^']),
      worktreeDirty: git(['status', '--porcelain']).length > 0 };
  } catch {
    return { commit: null, parentOrBase: null, worktreeDirty: null };
  }
}

export function allocateA3RunIdentity(params: { createdAt: string; runNonce: string;
  implementationIdentity: ForgewingLabelledPricingA3Artifact['implementationIdentity'];
  sourceSha256: string; sourceByteLength: number; labelPackageSha256: string;
  labelVersion: string; attestationSha256: string; linkageSha256: string;
  frozenBundleDigest: string; model: string; taskVersion: string;
  promptVersion: string; promptSha256?: string; schemaVersion: string }): A3RunIdentity {
  const runId = `forgewing-labelled-a3-${hashCanonical({
    implementationCommit: params.implementationIdentity.commit,
    implementationBase: params.implementationIdentity.parentOrBase,
    sourceSha256: params.sourceSha256, sourceByteLength: params.sourceByteLength,
    labelPackageSha256: params.labelPackageSha256, labelVersion: params.labelVersion,
    attestationSha256: params.attestationSha256, linkageSha256: params.linkageSha256,
    frozenBundleDigest: params.frozenBundleDigest, model: params.model,
    taskVersion: params.taskVersion, promptVersion: params.promptVersion,
    promptSha256: params.promptSha256 ?? null,
    schemaVersion: params.schemaVersion, createdAt: params.createdAt,
    runNonce: params.runNonce,
  }).slice(0, 32)}`;
  return { runId, createdAt: params.createdAt, runNonce: params.runNonce };
}

export type A3ArtifactPersistenceIo = Readonly<{
  writeExclusive: (path: string, bytes: string) => void; read: (path: string) => string }>;

function persistImmutableA3Artifact(path: string, artifact: unknown,
  io?: A3ArtifactPersistenceIo): void {
  const absolutePath = resolve(path);
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  const persistence = io ?? { writeExclusive: (target: string, content: string) =>
    writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' }),
  read: (target: string) => readFileSync(target, 'utf8') };
  persistence.writeExclusive(absolutePath, bytes);
  const persisted = persistence.read(absolutePath);
  if (persisted !== bytes || hashCanonical(JSON.parse(persisted)) !== hashCanonical(artifact)) {
    throw new Error('A3_ARTIFACT_PERSISTENCE_VERIFICATION_FAILED');
  }
}

export function persistA3FreezeArtifact(path: string, artifact: A3FreezeArtifact,
  io?: A3ArtifactPersistenceIo): void {
  persistImmutableA3Artifact(path, artifact, io);
}

function boundedErrorDiagnostic(error: unknown): Readonly<{
  name: string; message: string; code: string | null }> {
  const bounded = (value: string, maximum: number): string => value.slice(0, maximum);
  try {
    if (error instanceof Error) {
      const code = 'code' in error && typeof error.code === 'string' ? error.code : null;
      return { name: bounded(error.name, 128), message: bounded(error.message, 1_000),
        code: code == null ? null : bounded(code, 128) };
    }
    return { name: typeof error, message: bounded(String(error), 1_000), code: null };
  } catch {
    return { name: 'unknown', message: 'uninspectable thrown value', code: null };
  }
}

export function preserveA3InterruptionRootCause(params: {
  originalError: unknown; failureOutputPath: string; interruptionArtifact: A3InterruptionArtifact;
  persistenceIo?: A3ArtifactPersistenceIo;
  reportSecondaryFailure?: (diagnostic: A3InterruptionPersistenceFailureDiagnostic) => void;
}): never {
  try {
    persistImmutableA3Artifact(params.failureOutputPath, params.interruptionArtifact, params.persistenceIo);
  } catch (persistenceError) {
    const diagnostic: A3InterruptionPersistenceFailureDiagnostic = {
      code: 'A3_INTERRUPTION_ARTIFACT_PERSISTENCE_FAILED',
      runId: params.interruptionArtifact.runIdentity.runId,
      failureOutputPath: resolve(params.failureOutputPath),
      callsAttempted: params.interruptionArtifact.interruption.callsAttempted,
      completedCallRecords: params.interruptionArtifact.interruption.completedCallRecords,
      primaryError: boundedErrorDiagnostic(params.originalError),
      persistenceError: boundedErrorDiagnostic(persistenceError),
    };
    try {
      (params.reportSecondaryFailure ?? ((record) => process.stderr.write(
        `A3_SECONDARY_DIAGNOSTIC ${JSON.stringify(record)}\n`)))(diagnostic);
    } catch {
      // Diagnostic reporting is best-effort and must never replace the run's primary failure.
    }
  }
  throw params.originalError;
}

function warningClassification(warnings: readonly string[]): LabelledPricingA3CaseClassification | null {
  if (warnings.some((w) => ['anthropic_not_configured', 'provider_timeout', 'provider_error'].includes(w))) {
    return 'provider_failure';
  }
  if (warnings.some((w) => ['truncated_output', 'invalid_model_json', 'model_schema_rejected',
    'unknown_evidence_reference', 'unsupported_source_text'].includes(w))) return 'schema_failure';
  return null;
}

export function scoreAttempt(params: { attempt: ForgewingPricingCorpusAttempt; candidate: FrozenCandidate;
  repetition: A3AttemptKind; rawOutput: string | null;
  allPersistedAnchorIds: ReadonlySet<string>; effectivePromptVersion?: string }): MeasuredCase {
  const proposal = params.attempt.proposalBundle?.proposals[0] ?? null;
  const citations = [...new Set(proposal?.interpretations
    .flatMap((item) => item.evidenceArtifactIds) ?? [])].sort((a, b) => a.localeCompare(b, 'en-US'));
  const candidateAnchors = new Set(params.candidate.sourceAnchorIds);
  const hallucinated = citations.filter((id) => !params.allPersistedAnchorIds.has(id));
  const foreignCandidate = citations.filter((id) => params.allPersistedAnchorIds.has(id) && !candidateAnchors.has(id));
  const warningFailure = warningClassification(params.attempt.warnings);
  const taskValidOutput = params.attempt.proposalBundle != null && warningFailure == null;
  const acceptedForScoring = taskValidOutput && params.attempt.resultStatus === 'applied'
    && proposal != null && proposal.rowInterpretationState !== 'insufficient_evidence';
  const primitiveInterpretations: A3PrimitiveInterpretation[] = proposal?.interpretations.map((item) => ({
    sourceCellId: item.sourceCellId, semanticRole: item.semanticRole,
    evidenceArtifactIds: [...item.evidenceArtifactIds],
  })) ?? [];
  const fieldScores = params.candidate.linkedLabels.map((label) => scoreHumanLinkedField({
    label, interpretations: acceptedForScoring ? primitiveInterpretations : null,
  }));
  const semanticRoleCorrect = fieldScores.length === 0 ? null : fieldScores.every((item) => item.correct);
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
    failureReason: params.attempt.failureReason, fieldScores, labelScores: fieldScores,
    primitiveInterpretations,
    responseMetadata: { model: params.attempt.model,
      promptVersion: params.effectivePromptVersion ?? params.attempt.promptTemplateVersion,
      schemaVersion: params.attempt.proposalSchemaVersion,
      inputSnapshotHash: params.attempt.inputSnapshotHash, taskId: params.attempt.taskId,
      runId: params.attempt.runId, providerCallCount: params.attempt.providerCallCount,
      outputByteLength: params.rawOutput == null ? null : Buffer.byteLength(params.rawOutput, 'utf8') },
    acceptedForScoring, rawAcceptedOutput: taskValidOutput ? params.rawOutput : null,
    rawRejectedDiagnostic: taskValidOutput ? null : params.rawOutput };
}

export async function runForgewingLabelledPricingA3(params: {
  entry: ForgewingPricingCorpusEntry; labelLedgerPath: string; attestationPath?: string;
  linkageManifestPath?: string; freezeOutputPath?: string; failureOutputPath?: string;
  callBudget?: number; executeProvider?: boolean;
  repeatEachCandidate?: boolean; expectedCandidateIds?: readonly string[];
  expectedCandidateRowIds?: readonly string[]; provider?: ForgewingProvider;
  providerTimeoutMs?: number; priorAttemptArtifactPaths?: readonly string[];
  providerMaxOutputTokens?: number; finalizePriorRuns?: boolean;
  historicalRunArtifactPaths?: readonly string[];
  evaluationPromptVariant?: A3EvaluationPromptVariant;
  experimentHardCallLimit?: number; disableCorrectiveRetries?: boolean;
  forcePlannedRepeats?: boolean;
  onProviderReady?: (bundle: ForgewingLabelledPricingA3Artifact['frozenProviderBundle']) => void;
  onPreCallReport?: (report: A3PreCallReport,
    bundle: ForgewingLabelledPricingA3Artifact['frozenProviderBundle'],
    freezeArtifact: A3FreezeArtifact) => void;
  now?: () => Date;
}): Promise<ForgewingLabelledPricingA3Artifact> {
  const hardCallLimit = params.experimentHardCallLimit ?? HARD_CALL_BUDGET;
  if (!Number.isSafeInteger(hardCallLimit) || hardCallLimit < 1 || hardCallLimit > HARD_CALL_BUDGET) {
    throw new Error('forgewing_labelled_a3_invalid_hard_call_limit');
  }
  const maximum = params.callBudget ?? hardCallLimit;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > hardCallLimit) {
    throw new Error('forgewing_labelled_a3_invalid_call_budget');
  }
  const providerTimeoutMs = params.providerTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(providerTimeoutMs) || providerTimeoutMs < 100 || providerTimeoutMs > 30_000) {
    throw new Error('forgewing_labelled_a3_invalid_provider_timeout');
  }
  const providerMaxOutputTokens = params.providerMaxOutputTokens ?? 2_000;
  if (!Number.isSafeInteger(providerMaxOutputTokens)
    || providerMaxOutputTokens < 128 || providerMaxOutputTokens > 2_000) {
    throw new Error('forgewing_labelled_a3_invalid_provider_output_budget');
  }
  const ledgerPath = resolve(params.labelLedgerPath);
  const ledgerBytes = readFileSync(ledgerPath);
  const labelPackageSha256 = sha256Hex(ledgerBytes);
  const labelAudit = auditLabelledPricingA3Ledger(JSON.parse(ledgerBytes.toString('utf8')));
  if (params.entry.expectedSourceSha256 !== labelAudit.source.sha256) throw new Error('SOURCE_MISMATCH');
  const preparation = await prepareForgewingPricingCorpus(params.entry);
  if (preparation.source.sourceSha256 !== labelAudit.source.sha256
    || preparation.source.sourceByteLength !== labelAudit.source.byteLength) throw new Error('SOURCE_MISMATCH');
  if (!preparation.orderingDeterministic) throw new Error('NON_DETERMINISTIC_INPUT_ORDER');

  const attestationPath = params.attestationPath ? resolve(params.attestationPath) : null;
  const attestationBytes = attestationPath ? readFileSync(attestationPath) : null;
  const attestationInput = attestationBytes ? JSON.parse(attestationBytes.toString('utf8')) as unknown : null;
  const parsedAttestation = attestationInput as { reviewer?: { stable_handle?: string; reviewed_at?: string };
    scope?: unknown } | null;
  const attestationValidation = attestationPath
    ? validateForgewingLabelAttestation({ ledgerBytes, attestation: attestationInput }) : null;
  const labelsReady = attestationValidation?.status === 'human_attestation_valid';
  const linkagePath = params.linkageManifestPath ? resolve(params.linkageManifestPath) : null;
  const linkageBytes = linkagePath ? readFileSync(linkagePath) : null;
  const attestationSha256 = attestationBytes ? sha256Hex(attestationBytes) : null;
  const linkageSha256 = linkageBytes ? sha256Hex(linkageBytes) : null;
  const linkageInput = linkageBytes ? JSON.parse(linkageBytes.toString('utf8')) as unknown : null;
  const linkageValidation = labelsReady && linkagePath ? validateForgewingLabelLinkage({
    manifest: linkageInput, labelPackageSha256,
    sourcePdfSha256: preparation.source.sourceSha256, linkageManifestSha256: linkageSha256!,
    attestedLinkageManifestSha256: attestationValidation.linkageManifestSha256!, audit: labelAudit,
    candidates: preparation.candidates, attestedLabelObservationIds: attestationValidation.attestedLabelObservationIds,
    attestationScope: (attestationInput as { scope?: { kind?: string } }).scope?.kind === 'SCORING_SUBSET'
      ? 'SCORING_SUBSET' : 'FULL_PACKAGE' }) : null;
  const linkageReady = linkageValidation?.status === 'label_linkage_ready';
  if (!labelsReady) throw new Error('HUMAN_ATTESTATION_REQUIRED');
  if (!linkageReady) throw new Error(`LABEL_LINKAGE_GAP:${
    linkageValidation?.failureReasons.join(',') || 'linkage_validation_unavailable'}`);
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
    const sourceCellGroups = candidate.rowObservation.sourceCellGroups ?? [];
    validateSourceCellGroupClosure({
      cellIds: candidate.rowObservation.cells.map((cell) => cell.observationId), sourceCellGroups,
    });
    return { candidateId: digest, candidateDigestSha256: digest, rowId,
      physicalPage: candidate.rowObservation.physicalPageNumber,
      candidateInput: candidate, sourceCellGroups,
      sourceAnchorIds: candidate.rowObservation.cells.map((cell) => cell.observationId),
      resolutionState: candidate.rowObservation.deterministicState,
      eligibilityReason: candidate.pricingScope.eligibilityReason,
      labelLinkage: labelsReady ? linkagesByRow.get(rowId)?.linkageStatus ?? 'missing_label_linkage' : 'unmet_labels',
      labelObservationIds: linkagesByRow.get(rowId)?.linkedLabelObservationIds ?? [],
      linkedRoles: linkagesByRow.get(rowId)?.linkedRoles ?? [],
      linkedLabels: (recordsByCandidate.get(rowId) ?? []).map((record) => {
        const expected = expectedById.get(record.label_observation_id)!;
        if (!expected) throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
        const sourceCellGroup = resolveHumanLabelSourceGroup({ labelRole: record.label_role,
          sourceObservationIds: record.source_observation_ids, sourceCellGroups });
        return { labelObservationId: record.label_observation_id, labelRole: record.label_role,
          expectedSemanticRole: expected.expectedSemanticRole as ForgewingPricingSemanticRole,
          expectedRawText: expected.expectedRawText,
          sourceObservationIds: record.source_observation_ids, sourceCellGroup };
      }) };
  });
  if (frozenCandidates.length === 0) throw new Error('NO_ELIGIBLE_CANDIDATES');
  const validatedHumanLabelIds = frozenCandidates.flatMap((candidate) =>
    candidate.linkedLabels.map((label) => label.labelObservationId));
  if (new Set(validatedHumanLabelIds).size !== validatedHumanLabelIds.length
    || hashCanonical([...validatedHumanLabelIds].sort((a, b) => a.localeCompare(b, 'en-US')))
      !== hashCanonical([...linkageValidation.scoredLabelObservationIds]
        .sort((a, b) => a.localeCompare(b, 'en-US')))) {
    throw new Error('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  }
  const actualIds = frozenCandidates.map((item) => item.candidateId).sort((a, b) => a.localeCompare(b, 'en-US'));
  if (params.expectedCandidateIds && hashCanonical(actualIds) !== hashCanonical([...params.expectedCandidateIds]
    .sort((a, b) => a.localeCompare(b, 'en-US')))) throw new Error('FROZEN_CANDIDATE_IDENTITY_CHANGED');
  const actualRowIds = frozenCandidates.map((item) => item.rowId)
    .sort((a, b) => a.localeCompare(b, 'en-US'));
  if (params.expectedCandidateRowIds && hashCanonical(actualRowIds)
    !== hashCanonical([...params.expectedCandidateRowIds].sort((a, b) => a.localeCompare(b, 'en-US')))) {
    throw new Error('FROZEN_CANDIDATE_ROW_SET_CHANGED');
  }
  const frozenProviderBundle = { frozenBeforeProviderCalls: true as const,
    digestSha256: hashCanonical({ runtime: preparation.runtime, candidates: frozenCandidates }),
    taskVersion: preparation.runtime.promptTemplateId,
    promptVersion: preparation.runtime.promptTemplateVersion,
    schemaVersion: preparation.runtime.proposalSchemaVersion,
    candidates: frozenCandidates };
  const effectivePromptVersion = params.evaluationPromptVariant?.identifier
    ?? preparation.runtime.promptTemplateVersion;
  const evaluationPromptVariant = params.evaluationPromptVariant ? {
    ...params.evaluationPromptVariant,
    effectiveCallContractDigestSha256: hashCanonical({
      frozenProviderBundleDigestSha256: frozenProviderBundle.digestSha256,
      promptIdentifier: params.evaluationPromptVariant.identifier,
      promptSha256: params.evaluationPromptVariant.promptSha256,
      model: preparation.runtime.model,
      schemaVersion: preparation.runtime.proposalSchemaVersion,
      temperature: 0,
      structuredOutput: 'json_schema',
      outputTokenLimit: providerMaxOutputTokens,
      timeoutMs: providerTimeoutMs,
      sdkRetries: 0,
      taskRetryLimitPerCandidate: params.disableCorrectiveRetries ? 0 : 1,
      plannedSequence: [
        ...frozenCandidates.map((candidate) => ({ rowId: candidate.rowId, repetition: 'primary' })),
        ...(params.repeatEachCandidate ? frozenCandidates.map((candidate) => ({
          rowId: candidate.rowId, repetition: 'repeat',
        })) : []),
      ],
      hardCallLimit,
    }),
  } : undefined;
  const priorArtifacts = (params.priorAttemptArtifactPaths ?? []).map((path) => {
    const absolutePath = resolve(path);
    const bytes = readFileSync(absolutePath);
    const artifact = JSON.parse(bytes.toString('utf8')) as ForgewingLabelledPricingA3Artifact;
    if (!artifact.runIdentity?.runNonce || artifact.preCallReport?.runIdentity?.runId
      !== artifact.runIdentity.runId) throw new Error('PRIOR_A3_RUN_IDENTITY_VERSION_UNSUPPORTED');
    if (artifact.sourceIdentity.sha256 !== preparation.source.sourceSha256
      || artifact.frozenProviderBundle.digestSha256 !== frozenProviderBundle.digestSha256
      || artifact.modelIdentity.model !== preparation.runtime.model) {
      throw new Error('PRIOR_A3_RUN_IDENTITY_MISMATCH');
    }
    return { path: absolutePath, sha256: sha256Hex(bytes), artifact };
  });
  const historicalArtifacts = (params.historicalRunArtifactPaths ?? []).map((path) => {
    const absolutePath = resolve(path);
    const bytes = readFileSync(absolutePath);
    const artifact = JSON.parse(bytes.toString('utf8')) as ForgewingLabelledPricingA3Artifact;
    const historicalCandidateIds = artifact.candidateScope.frozenCandidates
      .map((candidate) => candidate.candidateId).sort((a, b) => a.localeCompare(b, 'en-US'));
    if (artifact.sourceIdentity.sha256 !== preparation.source.sourceSha256
      || hashCanonical(historicalCandidateIds) !== hashCanonical(actualIds)
      || artifact.modelIdentity.model !== preparation.runtime.model
      || artifact.modelIdentity.promptVersion !== preparation.runtime.promptTemplateVersion
      || artifact.modelIdentity.schemaVersion !== preparation.runtime.proposalSchemaVersion) {
      throw new Error('HISTORICAL_A3_RUN_IDENTITY_MISMATCH');
    }
    return { path: absolutePath, sha256: sha256Hex(bytes), artifact };
  });
  const priorCalls = priorArtifacts.reduce((sum, item) => sum + item.artifact.callBudget.callsAttempted, 0);
  const priorRetries = priorArtifacts.reduce((sum, item) =>
    sum + item.artifact.callBudget.retries, 0);
  if (params.finalizePriorRuns && (params.executeProvider || priorCalls === 0)) {
    throw new Error('forgewing_labelled_a3_invalid_prior_finalization');
  }
  const priorCases = priorArtifacts.flatMap((item) => item.artifact.cases);
  const pendingPrimaryCandidates = frozenCandidates.filter((candidate) => !priorCases.some((item) =>
    item.candidateId === candidate.candidateId && item.repetition !== 'repeat'));
  const pendingRepeatCandidates = params.repeatEachCandidate ? frozenCandidates.filter((candidate) =>
    !priorCases.some((item) => item.candidateId === candidate.candidateId && item.repetition === 'repeat')) : [];
  const plannedCallSequence: A3PlannedCall[] = [
    ...pendingPrimaryCandidates.map((candidate) => ({ candidateId: candidate.candidateId,
      rowId: candidate.rowId, repetition: 'primary' as const })),
    ...pendingRepeatCandidates.map((candidate) => ({ candidateId: candidate.candidateId,
      rowId: candidate.rowId, repetition: 'repeat' as const })),
  ].map((item, index) => ({ sequence: index + 1, ...item }));
  const planned = plannedCallSequence.length;
  if (priorCalls + planned > maximum || priorCalls + planned > hardCallLimit) {
    throw new Error('PROVIDER_CALL_BUDGET_EXCEEDED');
  }
  if (params.executeProvider) {
    if (!params.expectedCandidateIds || !params.expectedCandidateRowIds) {
      throw new Error('A3_EXPECTED_CANDIDATE_SET_REQUIRED');
    }
    if (!params.freezeOutputPath) throw new Error('A3_FREEZE_PERSISTENCE_REQUIRED');
    if (!params.failureOutputPath) throw new Error('A3_FAILURE_ARTIFACT_PATH_REQUIRED');
    if (params.evaluationPromptVariant && !params.provider) {
      throw new Error('A3_EVALUATION_PROMPT_PROVIDER_REQUIRED');
    }
    if (!params.provider && !process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY_REQUIRED');
  }
  if (params.freezeOutputPath && params.failureOutputPath
    && resolve(params.freezeOutputPath) === resolve(params.failureOutputPath)) {
    throw new Error('A3_ARTIFACT_PATH_COLLISION');
  }

  const runtime = getForgewingRuntimeConfig();
  if (runtime.model !== preparation.runtime.model) throw new Error('A3_FROZEN_RUNTIME_IDENTITY_CHANGED');
  const capturedImplementationIdentity = implementationIdentity();
  const createdAt = (params.now ?? (() => new Date()))().toISOString();
  const runIdentity = allocateA3RunIdentity({ createdAt,
    runNonce: randomUUID(), implementationIdentity: capturedImplementationIdentity,
    sourceSha256: preparation.source.sourceSha256,
    sourceByteLength: preparation.source.sourceByteLength,
    labelPackageSha256, labelVersion: labelAudit.package.ledgerVersion,
    attestationSha256: attestationSha256!, linkageSha256: linkageSha256!,
    frozenBundleDigest: frozenProviderBundle.digestSha256, model: preparation.runtime.model,
    taskVersion: preparation.runtime.promptTemplateId,
    promptVersion: effectivePromptVersion,
    ...(params.evaluationPromptVariant ? { promptSha256: params.evaluationPromptVariant.promptSha256 } : {}),
    schemaVersion: preparation.runtime.proposalSchemaVersion });
  const preCallReport: A3PreCallReport = { runIdentity,
    attestationValid: true, linkageValid: true,
    sourceValid: true, scoringContractValid: true, candidateCount: frozenCandidates.length,
    candidateIds: actualRowIds, candidateDigests: actualIds,
    candidateBundleDigest: frozenProviderBundle.digestSha256, provider: 'anthropic',
    model: preparation.runtime.model, promptVersion: effectivePromptVersion,
    schemaVersion: preparation.runtime.proposalSchemaVersion, outputTokenLimit: providerMaxOutputTokens,
    timeoutMs: providerTimeoutMs, sdkRetries: 0,
    taskRetryLimitPerCandidate: params.disableCorrectiveRetries ? 0 : 1,
    plannedCalls: planned, hardCallLimit,
    ...(evaluationPromptVariant ? { evaluationPromptVariant } : {}) };
  const freezeArtifact: A3FreezeArtifact = { runIdentity,
    implementationIdentity: capturedImplementationIdentity,
    inputIdentities: { sourceSha256: preparation.source.sourceSha256,
      sourceByteLength: preparation.source.sourceByteLength, labelPackageSha256,
      attestationSha256: attestationSha256!, linkageSha256: linkageSha256! },
    preCallReport, frozenProviderBundle,
    callConfiguration: { executeProvider: params.executeProvider ?? false,
      repeatEachCandidate: params.repeatEachCandidate ?? false, configuredCallBudget: maximum,
      plannedCalls: planned, hardCallLimit, provider: 'anthropic',
      model: preparation.runtime.model, promptVersion: effectivePromptVersion,
      schemaVersion: preparation.runtime.proposalSchemaVersion, temperature: 0,
      structuredOutput: 'json_schema', outputTokenLimit: providerMaxOutputTokens,
      timeoutMs: providerTimeoutMs, sdkRetries: 0,
      taskRetryLimitPerCandidate: params.disableCorrectiveRetries ? 0 : 1,
      ...(evaluationPromptVariant ? { evaluationPromptVariant } : {}) } };
  if (params.freezeOutputPath) persistA3FreezeArtifact(params.freezeOutputPath, freezeArtifact);
  const currentProviderCallSequence: A3ProviderCallRecord[] = [];
  let currentProviderInvocations = 0;
  try {
  params.onPreCallReport?.(preCallReport, frozenProviderBundle, freezeArtifact);
  if (params.executeProvider) params.onProviderReady?.(frozenProviderBundle);
  const currentCases: MeasuredCase[] = [];
  const allPersistedAnchorIds = new Set(preparation.pricingLayoutObservations.map((item) => item.id));
  const provider = params.provider ?? callClaudeForPricingInterpretation;
  if (params.executeProvider) {
    const runCandidate = async (index: number, repetition: A3AttemptKind,
      correctiveDetail?: string): Promise<void> => {
      if (priorCalls + currentProviderInvocations >= maximum) throw new Error('PROVIDER_CALL_BUDGET_EXCEEDED');
      let rawOutput: string | null = null;
      let providerInvoked = false;
      const startedAt = new Date();
      const attempts = await runForgewingPricingCandidateAttempts([preparation.candidates[index]], {
        config: { ...runtime, enabled: true, maxCalls: 1, timeoutMs: providerTimeoutMs,
          maxOutputTokens: providerMaxOutputTokens }, taskEnabled: true,
        provider: async (request) => {
          providerInvoked = true;
          currentProviderInvocations += 1;
          const correctiveInstruction = repetition === 'corrective_retry'
            ? `\n\nCORRECTIVE RETRY: The previous response failed strict validation: ${correctiveDetail ?? 'schema conformance failure'}. Return a complete replacement JSON object. missingEvidence is forbidden unless rowInterpretationState is exactly "insufficient_evidence"; otherwise omit the property entirely. Every sourceText must be an exact substring of its sourceCellId cell and every evidenceIds entry must be a supplied cell ID. Do not include or repair the prior output.`
            : '';
          try {
            const raw = await provider({ ...request,
              maxOutputTokens: providerMaxOutputTokens,
              inputJson: `${request.inputJson}${correctiveInstruction}` });
            rawOutput = raw;
            return raw;
          } catch (error) {
            if (error && typeof error === 'object' && 'rawOutput' in error
              && typeof error.rawOutput === 'string') rawOutput = error.rawOutput;
            throw error;
          }
        } });
      const measured = scoreAttempt({ attempt: attempts[0], candidate: frozenCandidates[index],
        repetition, rawOutput, allPersistedAnchorIds,
        ...(params.evaluationPromptVariant ? { effectivePromptVersion } : {}) });
      currentCases.push(measured);
      const completedAt = new Date();
      currentProviderCallSequence.push({ runIdentity,
        sequence: currentProviderCallSequence.length + 1,
        candidateId: frozenCandidates[index].candidateId, rowId: frozenCandidates[index].rowId,
        repetition, startedAt: startedAt.toISOString(), completedAt: completedAt.toISOString(),
        durationMs: completedAt.getTime() - startedAt.getTime(), providerInvoked,
        resultStatus: attempts[0].resultStatus, warnings: [...attempts[0].warnings],
        failureReason: attempts[0].failureReason,
        outputByteLength: rawOutput == null ? null : Buffer.byteLength(rawOutput, 'utf8'),
        outputSha256: rawOutput == null ? null : sha256Hex(rawOutput),
        acceptedForScoring: measured.acceptedForScoring });
    };
    for (let index = 0; index < preparation.candidates.length; index += 1) {
      const priorCandidateAttempts = priorCases
        .filter((item) => item.candidateId === frozenCandidates[index].candidateId);
      if (priorCandidateAttempts.length === 0) await runCandidate(index, 'primary');
    }
    for (let index = 0; index < preparation.candidates.length; index += 1) {
      const attempts = [...priorArtifacts.flatMap((item) => item.artifact.cases), ...currentCases]
        .filter((item) => item.candidateId === frozenCandidates[index].candidateId
          && item.repetition !== 'repeat');
      const latest = attempts.at(-1);
      const alreadyRetried = attempts.some((item) => item.repetition === 'corrective_retry');
      const retryWarning = latest?.warnings.find((warning) => [
        'invalid_model_json', 'model_schema_rejected', 'unknown_evidence_reference',
        'unsupported_source_text',
      ].includes(warning));
      if (!params.disableCorrectiveRetries && retryWarning && !alreadyRetried) {
        await runCandidate(index, 'corrective_retry', retryWarning);
      }
    }
    const allBaselineCases = [...priorArtifacts.flatMap((item) => item.artifact.cases), ...currentCases];
    const latestByCandidate = frozenCandidates.map((candidate) => allBaselineCases
      .filter((item) => item.candidateId === candidate.candidateId && item.repetition !== 'repeat').at(-1));
    const primariesSucceeded = latestByCandidate.every((item) => item != null
      && !['provider_failure', 'schema_failure'].includes(item.classification));
    if (params.repeatEachCandidate && (params.forcePlannedRepeats || primariesSucceeded)
      && priorCalls + currentProviderInvocations + pendingRepeatCandidates.length <= maximum) {
      for (let index = 0; index < preparation.candidates.length; index += 1) {
        if (!priorCases.some((item) => item.candidateId === frozenCandidates[index].candidateId
          && item.repetition === 'repeat')) await runCandidate(index, 'repeat');
      }
    }
  }
  const cases = [...priorArtifacts.flatMap((item) => item.artifact.cases), ...currentCases]
    .map((item) => ['provider_failure', 'schema_failure'].includes(item.classification)
      ? { ...item, abstained: false } : item);
  const currentCallsAttempted = currentProviderInvocations;
  const callsAttempted = priorCalls + currentCallsAttempted;
  const priorProviderCallSequence = priorArtifacts.flatMap((item) =>
    (item.artifact.currentProviderCallSequence ?? item.artifact.providerCallSequence ?? [])
      .map((record) => ({ ...record, runIdentity: record.runIdentity ?? item.artifact.runIdentity })));
  const providerCallSequence = [...priorProviderCallSequence, ...currentProviderCallSequence]
    .map((item, index) => ({ ...item, sequence: index + 1 }));
  if (providerCallSequence.length !== callsAttempted) {
    throw new Error('A3_PROVIDER_CALL_ACCOUNTING_MISMATCH');
  }
  const providerFailures = cases.filter((item) => item.classification === 'provider_failure').length;
  const truncatedOutputs = cases.filter((item) => item.warnings.includes('truncated_output')).length;
  const jsonParseFailures = cases.filter((item) => item.warnings.includes('invalid_model_json')).length;
  const strictSchemaFailures = cases.filter((item) => item.warnings.includes('model_schema_rejected')).length;
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
  const humanLabelCount = countValidatedHumanLabels(frozenCandidates);
  const { fieldScoreCount, correctlyClassifiedLabelCount, fieldScoringCoverage }
    = summarizeA3FieldScores(scoredCases, humanLabelCount);
  const unscoredLabelCount = humanLabelCount - fieldScoreCount;
  const roleLabelMetrics = Object.fromEntries([...new Set(frozenCandidates.flatMap((candidate) =>
    candidate.linkedLabels.map((label) => label.labelRole)))].sort((a, b) => a.localeCompare(b, 'en-US'))
    .map((role) => {
      const total = frozenCandidates.reduce((sum, candidate) => sum
        + candidate.linkedLabels.filter((label) => label.labelRole === role).length, 0);
      const roleScores = scoredCases.flatMap((item) => item.labelScores)
        .filter((item) => item.labelRole === role && item.state !== 'UNSCORED');
      const scored = roleScores.length;
      const correct = roleScores.filter((item) => item.correct).length;
      return [role, { total, scored, unscored: total - scored, correct,
        fieldScoringCoverage: ratio(scored, total),
        semanticAccuracyAmongScored: ratio(correct, scored),
        fixedDenominatorCorrectness: ratio(correct, total) }];
    }));
  const roleAccuracy = (role: string): number | null => {
    const scores = scoredCases.flatMap((item) => item.labelScores)
      .filter((item) => item.labelRole === role && item.state !== 'UNSCORED');
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
  const pairs = params.repeatEachCandidate ? frozenCandidates.flatMap((candidate) => {
    const attempts = cases.filter((item) => item.candidateId === candidate.candidateId);
    const pair = [attempts.filter((item) => item.repetition !== 'repeat').at(-1),
      attempts.find((item) => item.repetition === 'repeat')]
      .filter((item): item is MeasuredCase => item != null);
    const comparable = (item: MeasuredCase) => ({ classification: item.classification,
      semanticRoleCorrect: item.semanticRoleCorrect, proposal: item.proposalBundle?.proposals[0] ?? null });
    return pair.length === 2
      ? [hashCanonical(comparable(pair[0])) === hashCanonical(comparable(pair[1]))] : [];
  }) : [];
  const validCandidateCount = new Set(validScoredCases.filter((item) =>
    item.fieldScores.length > 0 && item.fieldScores.every((score) => score.state !== 'UNSCORED'))
    .map((item) => item.candidateId)).size;
  const completed = validCandidateCount === frozenCandidates.length && frozenCandidates.length > 0;
  const corpusStatus = !labelsReady ? 'labelled_a3_unmet_labels'
    : !params.executeProvider && !params.finalizePriorRuns ? 'labelled_a3_incomplete'
    : params.executeProvider && currentCases.filter((item) =>
      item.classification === 'provider_failure').length === currentCallsAttempted
      ? 'labelled_a3_provider_unavailable'
    : completed ? 'labelled_a3_measured' : 'labelled_a3_incomplete';
  const failureReasons = !labelsReady ? attestationValidation?.failureReasons ?? ['human_attestation_missing']
    : !linkageReady ? ['LABEL_LINKAGE_GAP', ...(linkageValidation?.failureReasons ?? [])]
    : !params.executeProvider && !params.finalizePriorRuns ? ['PROVIDER_DISABLED_PREFLIGHT']
    : [...new Set(cases.flatMap((item) => item.warnings))];
  return { reportVersion: FORGEWING_LABELLED_PRICING_A3_VERSION,
    authority: 'non_authoritative_measurement', promotionEvidence: false, promotionAuthorized: false,
    runIdentity, implementationIdentity: capturedImplementationIdentity,
    sourceIdentity: { path: preparation.source.sourcePdfPath,
      sha256: preparation.source.sourceSha256, byteLength: preparation.source.sourceByteLength,
      pages: labelAudit.source.pages, sourceDocumentId: preparation.source.sourceDocumentId,
      sourceArtifactId: preparation.source.sourceArtifactId,
      extractionSnapshotId: preparation.source.extractionSnapshotId },
    labelPackage: { ledgerPath, audit: labelAudit, promotionSuitable: false },
    humanAttestation: { path: attestationPath, sha256: attestationSha256,
      supplied: attestationPath != null,
      reviewer: parsedAttestation?.reviewer?.stable_handle && parsedAttestation.reviewer.reviewed_at
        ? { stableHandle: parsedAttestation.reviewer.stable_handle,
          reviewedAt: parsedAttestation.reviewer.reviewed_at } : null,
      scope: parsedAttestation?.scope ?? null,
      validation: attestationValidation, authority: 'evaluation_ground_truth_only', promotionAuthorized: false },
    exactLabelLinkage: { path: linkagePath, sha256: linkageSha256,
      supplied: linkagePath != null,
      status: linkageValidation?.status ?? 'label_linkage_gap',
      failureReasons: linkageValidation?.failureReasons ?? ['linkage_manifest_missing'],
      scoredLabelObservationIds: linkageValidation?.scoredLabelObservationIds ?? [], promotionAuthorized: false },
    modelIdentity: { provider: 'anthropic', providerConfigured: Boolean(params.provider
      || process.env.ANTHROPIC_API_KEY?.trim() || priorArtifacts.length > 0
      || historicalArtifacts.length > 0), model: preparation.runtime.model,
      taskVersion: preparation.runtime.promptTemplateId, promptVersion: effectivePromptVersion,
      schemaVersion: preparation.runtime.proposalSchemaVersion, evaluationTimeoutMs: providerTimeoutMs,
      evaluationMaxOutputTokens: providerMaxOutputTokens, temperature: 0,
      structuredOutput: 'json_schema', sdkRetries: 0,
      taskRetryLimitPerCandidate: params.disableCorrectiveRetries ? 0 : 1 }, frozenProviderBundle,
    candidateScope: { totalLabelledRows: labelAudit.denominators.totalDistinctRows,
      a2EligibleRows: preparation.candidates.length, providerCallCandidateRows: linkageReady ? frozenCandidates.length : 0,
      a3ScoredOutputs: cases.length, orderingDeterministic: preparation.orderingDeterministic, frozenCandidates },
    callBudget: { maximum, planned, priorCalls, currentCallsAttempted, callsAttempted, callsSucceeded,
      providerFailures, truncatedOutputs, jsonParseFailures, schemaFailures: strictSchemaFailures,
      schemaValidOutputs, retries: priorRetries
        + currentCases.filter((item) => item.repetition === 'corrective_retry').length },
    preCallReport, plannedCallSequence, priorProviderCallSequence,
    currentProviderCallSequence, providerCallSequence,
    outputs: { acceptedRawOutputs: cases.flatMap((item) => item.rawAcceptedOutput == null ? [] : [{
      candidateId: item.candidateId, repetition: item.repetition, rawOutput: item.rawAcceptedOutput }]),
    rejectedRawDiagnostics: cases.filter((item) => item.rawRejectedDiagnostic != null
      || item.warnings.length > 0 || item.failureReason != null).map((item) => ({
      candidateId: item.candidateId, repetition: item.repetition,
      rawOutput: item.rawRejectedDiagnostic, warnings: item.warnings,
      failureReason: item.failureReason })) },
    priorRuns: priorArtifacts.map((item) => ({ path: item.path, sha256: item.sha256,
      callsAttempted: item.artifact.callBudget.callsAttempted,
      providerFailures: item.artifact.callBudget.providerFailures,
      schemaValidOutputs: item.artifact.callBudget.schemaValidOutputs })), corpusStatus,
    historicalRuns: historicalArtifacts.map((item) => ({ path: item.path, sha256: item.sha256,
      runId: item.artifact.runIdentity.runId, corpusStatus: item.artifact.corpusStatus,
      callsAttempted: item.artifact.callBudget.callsAttempted })),
    measurementClassification: !params.executeProvider && !params.finalizePriorRuns
      ? 'UNMET' : completed ? 'MEASURED' : 'INCOMPLETE',
    metrics: { providerCallSuccessCount: callsSucceeded, providerCallSuccessRate: ratio(callsSucceeded, callsAttempted),
      schemaValidOutputCount: schemaValidOutputs, schemaValidOutputRate: ratio(schemaValidOutputs, callsAttempted),
      humanLabelCount, scoredLabelCount: fieldScoreCount, unscoredLabelCount,
      correctLabelCount: correctlyClassifiedLabelCount,
      correctlyClassifiedLabelCount, fieldScoreCount, fieldScoringCoverage,
      semanticAccuracyAmongScored: ratio(correctlyClassifiedLabelCount, fieldScoreCount),
      fixedDenominatorCorrectness: ratio(correctlyClassifiedLabelCount, humanLabelCount),
      roleLabelMetrics,
      labelLinkageRate: ratio(frozenCandidates.filter((item) => item.labelLinkage === 'exact_linkage_complete').length,
      frozenCandidates.length), semanticRoleAccuracy: completed
        ? ratio(correctlyClassifiedLabelCount, humanLabelCount) : null,
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
    cases, failureReasons, limitations: [
      'numeric_amount_not_measured_schema_has_no_numeric_proposal',
      'provider_native_token_usage_and_stop_reason_unavailable_to_evaluation_runner',
      'evaluation_only_non_authoritative_no_promotion',
    ] };
  } catch (error) {
    if (params.failureOutputPath) {
      const interruptionArtifact: A3InterruptionArtifact = { runIdentity,
        implementationIdentity: capturedImplementationIdentity, preCallReport,
        frozenProviderBundleDigest: frozenProviderBundle.digestSha256,
        interruption: { interruptedAt: new Date().toISOString(),
          reason: 'A3_RUN_INTERRUPTED_AFTER_FREEZE', callsAttempted: currentProviderInvocations,
          completedCallRecords: currentProviderCallSequence.length } };
      preserveA3InterruptionRootCause({ originalError: error,
        failureOutputPath: params.failureOutputPath, interruptionArtifact });
    }
    throw error;
  }
}

export function parseForgewingLabelledPricingA3Cli(argv: readonly string[]): Readonly<{
  entry: ForgewingPricingCorpusEntry; labelLedgerPath: string; attestationPath?: string;
  linkageManifestPath?: string; outputPath: string; freezeOutputPath?: string; callBudget: number;
  executeProvider: boolean; repeatEachCandidate: boolean; expectedCandidateIds?: readonly string[];
  expectedCandidateRowIds?: readonly string[];
  providerTimeoutMs?: number; providerMaxOutputTokens?: number;
  priorAttemptArtifactPaths?: readonly string[]; historicalRunArtifactPaths?: readonly string[];
  finalizePriorRuns: boolean }> {
  const { values } = parseArgs({ args: [...argv], strict: true, options: {
    source: { type: 'string' }, labels: { type: 'string' }, attestation: { type: 'string' },
    linkage: { type: 'string' }, 'document-type': { type: 'string' }, 'expected-sha256': { type: 'string' },
    'page-ranges': { type: 'string' }, output: { type: 'string' }, 'freeze-output': { type: 'string' },
    'max-calls': { type: 'string' }, 'execute-provider': { type: 'boolean' }, repeat: { type: 'boolean' },
    'expected-candidates': { type: 'string' }, 'expected-candidate-rows': { type: 'string' },
    'provider-timeout-ms': { type: 'string' },
    'provider-max-output-tokens': { type: 'string' },
    'prior-run': { type: 'string', multiple: true }, 'historical-run': { type: 'string', multiple: true },
    'finalize-prior-runs': { type: 'boolean' } } });
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
    ...(values['expected-candidate-rows']
      ? { expectedCandidateRowIds: values['expected-candidate-rows'].split(',') } : {}),
    ...(values['provider-timeout-ms'] ? { providerTimeoutMs: Number(values['provider-timeout-ms']) } : {}),
    ...(values['provider-max-output-tokens']
      ? { providerMaxOutputTokens: Number(values['provider-max-output-tokens']) } : {}),
    ...(values['prior-run'] ? { priorAttemptArtifactPaths: values['prior-run'] } : {}),
    ...(values['historical-run'] ? { historicalRunArtifactPaths: values['historical-run'] } : {}),
    finalizePriorRuns: values['finalize-prior-runs'] ?? false };
}

export async function main(): Promise<void> {
  const cli = parseForgewingLabelledPricingA3Cli(process.argv.slice(2));
  const artifact = await runForgewingLabelledPricingA3({ ...cli, failureOutputPath: cli.outputPath,
    onPreCallReport: (report) => {
      process.stdout.write(`A3_PRE_CALL_REPORT ${JSON.stringify(report)}\n`);
    } });
  const outputPath = resolve(cli.outputPath); mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${outputPath}\n`);
}

if (process.env.FORGEWING_LABELLED_A3_CLI === '1'
  || process.argv.some((value) => value.replaceAll('\\', '/').endsWith('/runForgewingLabelledPricingA3.ts'))) {
  void main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1; });
}
