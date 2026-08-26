/** Evaluation-only A/B runner for the fixed A3 primitive-coverage prompt suffix. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA } from '@/lib/forgewing/runtime/structuredOutput';
import { parseRatePageRanges } from '@/lib/contracts/parseRatePageRanges';
import {
  countValidatedHumanLabels,
  runForgewingLabelledPricingA3,
  type A3FieldScore,
  type ForgewingLabelledPricingA3Artifact,
} from '@/scripts/evaluation/runForgewingLabelledPricingA3';
import {
  A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX,
  createA3PrimitiveCoverageExperimentProvider,
} from '@/scripts/evaluation/forgewingA3PrimitiveCoveragePrompt';

const EXPERIMENT_VERSION = 'forgewing-a3-primitive-coverage-ab-v1' as const;
const EXPECTED_BASELINE_RUN_ID = 'forgewing-labelled-a3-60f22eb88306c2e5dc4e898ed8ede1dc';
const EXPECTED_BASELINE_SHA256 = '84f8c0cc242f9a07e85708e9889629d1a2b5c8289cab38a5000962e27b1e4b5a';
const EXPECTED_IMPLEMENTATION_COMMIT = '197d06bd16de50b6c1675c3bb69bf2f0af83e606';
const EXPECTED_BUNDLE_DIGEST = 'ad7c6df803b6da2c89bac6020c77ee4fb9598ca7d496141e96d0bbf562915448';

type RawInterpretation = Readonly<{ sourceCellId?: unknown; semanticRole?: unknown;
  sourceText?: unknown; evidenceIds?: unknown }>;

function rawOutputForCase(item: ForgewingLabelledPricingA3Artifact['cases'][number]): string | null {
  return item.rawAcceptedOutput ?? item.rawRejectedDiagnostic;
}

function rawInterpretations(rawOutput: string | null): readonly RawInterpretation[] {
  if (rawOutput == null) return [];
  try {
    const parsed = JSON.parse(rawOutput) as { interpretations?: unknown };
    return Array.isArray(parsed.interpretations) ? parsed.interpretations as RawInterpretation[] : [];
  } catch {
    return [];
  }
}

export function summarizePrimitiveCoverage(
  artifact: ForgewingLabelledPricingA3Artifact,
): readonly Readonly<Record<string, unknown>>[] {
  const candidateById = new Map(artifact.frozenProviderBundle.candidates
    .map((candidate) => [candidate.candidateId, candidate]));
  return artifact.cases.map((item) => {
    const candidate = candidateById.get(item.candidateId)!;
    const admitted = [...candidate.sourceAnchorIds];
    const admittedSet = new Set(admitted);
    const raw = rawInterpretations(rawOutputForCase(item));
    const sourceCellIds = raw.flatMap((entry) => typeof entry.sourceCellId === 'string'
      ? [entry.sourceCellId] : []);
    const counts = new Map<string, number>();
    for (const id of sourceCellIds) counts.set(id, (counts.get(id) ?? 0) + 1);
    const unique = [...counts.keys()];
    const missing = admitted.filter((id) => !counts.has(id));
    const duplicate = [...counts.entries()].filter(([, count]) => count > 1)
      .map(([id]) => id);
    const foreignSourceCellIds = unique.filter((id) => !admittedSet.has(id));
    const cellRawText = new Map(candidate.candidateInput.rowObservation.cells
      .map((cell) => [cell.observationId, cell.rawText]));
    const groupDisplayTexts = new Set(candidate.sourceCellGroups.map((group) => group.authoredRawText));
    const interpretations = raw.map((entry) => {
      const sourceCellId = typeof entry.sourceCellId === 'string' ? entry.sourceCellId : null;
      const evidenceIds = Array.isArray(entry.evidenceIds)
        ? entry.evidenceIds.filter((id): id is string => typeof id === 'string') : [];
      const sourceText = typeof entry.sourceText === 'string' ? entry.sourceText : null;
      return { sourceCellId,
        semanticRole: typeof entry.semanticRole === 'string' ? entry.semanticRole : null,
        sourceText, evidenceIds,
        selfCited: sourceCellId != null && evidenceIds.includes(sourceCellId),
        foreignEvidenceIds: evidenceIds.filter((id) => !admittedSet.has(id)),
        usesGroupDisplayTextInsteadOfPrimitive: sourceCellId != null && sourceText != null
          && groupDisplayTexts.has(sourceText) && cellRawText.get(sourceCellId) !== sourceText };
    });
    return { candidateId: item.candidateId, rowId: item.rowObservationId,
      repetition: item.repetition, acceptedForScoring: item.acceptedForScoring,
      warnings: item.warnings, admittedPrimitiveCount: admitted.length,
      interpretationCount: raw.length, uniqueSourceCellIdCount: unique.length,
      admittedPrimitiveIds: admitted, interpretedSourceCellIds: unique,
      missingPrimitiveIds: missing, duplicatePrimitiveIds: duplicate,
      duplicateInterpretationCount: sourceCellIds.length - unique.length,
      foreignSourceCellIds, selfCitedPrimitiveCount: new Set(interpretations
        .filter((entry) => entry.selfCited && entry.sourceCellId != null
          && admittedSet.has(entry.sourceCellId)).map((entry) => entry.sourceCellId)).size,
      completeExactlyOnceSelfCited: missing.length === 0 && duplicate.length === 0
        && foreignSourceCellIds.length === 0 && interpretations.length === admitted.length
        && interpretations.every((entry) => entry.selfCited),
      anchorTranscriptionFailures: [...new Set(interpretations.flatMap((entry) => entry.foreignEvidenceIds))],
      groupTextSourceFailures: interpretations.filter((entry) => entry.usesGroupDisplayTextInsteadOfPrimitive)
        .map((entry) => entry.sourceCellId),
      interpretations };
  });
}

type FixedDenominatorCount = Readonly<{
  correct: number;
  scored: number;
  unscored: number;
  total: number;
  incorrectContradictoryRole: number;
  insufficientSemanticSupport: number;
  fieldScoringCoverage: number | null;
  semanticAccuracyAmongScored: number | null;
  fixedDenominatorCorrectness: number | null;
}>;

export type A3FixedDenominatorPrimarySummary = Readonly<{
  humanLabelCount: number;
  scoredLabelCount: number;
  unscoredLabelCount: number;
  correctLabelCount: number;
  fieldScoringCoverage: number | null;
  semanticAccuracyAmongScored: number | null;
  fixedDenominatorCorrectness: number | null;
  stateCounts: Readonly<Record<A3FieldScore['state'], number>>;
  unscoredByCaseClassification: Readonly<Record<string, number>>;
  roles: Readonly<Record<string, FixedDenominatorCount>>;
  descriptionScore: FixedDenominatorCount;
  unitScore: FixedDenominatorCount;
  rateScore: FixedDenominatorCount;
  totalScore: FixedDenominatorCount;
  candidateAcceptance: Readonly<{ accepted: number; total: number; rate: number | null }>;
  repeatAcceptance: Readonly<{ accepted: number; total: number; rate: number | null }>;
  primaryAcceptedOutputs: number;
  repeatAcceptedOutputs: number;
  contradictoryRoles: number;
  missingPrimitiveInterpretations: number;
  unknownRoles: number;
  anchorFailures: number;
  sourceTextFailures: number;
  evidenceFidelity: Readonly<{ valid: number; cited: number }>;
  confidence: readonly Readonly<{ candidateId: string; confidence: number | null }>[];
  rowStates: readonly Readonly<{ candidateId: string; state: string | null }>[];
  repeatStableCount: number;
  repeatComparableCount: number;
}>;

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function fixedDenominatorCount(scores: readonly A3FieldScore[]): FixedDenominatorCount {
  const scored = scores.filter((score) => score.state !== 'UNSCORED').length;
  const correct = scores.filter((score) => score.state === 'CORRECT').length;
  const total = scores.length;
  return { correct, scored, unscored: total - scored, total,
    incorrectContradictoryRole: scores.filter((score) =>
      score.state === 'INCORRECT_CONTRADICTORY_ROLE').length,
    insufficientSemanticSupport: scores.filter((score) =>
      score.state === 'INSUFFICIENT_SEMANTIC_SUPPORT').length,
    fieldScoringCoverage: ratio(scored, total),
    semanticAccuracyAmongScored: ratio(correct, scored),
    fixedDenominatorCorrectness: ratio(correct, total) };
}

export function summarizeFixedDenominatorPrimaryMetrics(
  artifact: ForgewingLabelledPricingA3Artifact,
  coverage: readonly Readonly<Record<string, unknown>>[] = [],
): A3FixedDenominatorPrimarySummary {
  const primaries = artifact.cases.filter((item) => item.repetition === 'primary');
  const repeats = artifact.cases.filter((item) => item.repetition === 'repeat');
  const candidates = artifact.frozenProviderBundle.candidates;
  const humanLabelCount = countValidatedHumanLabels(candidates);
  const candidateIds = candidates.map((candidate) => candidate.candidateId);
  const primaryIds = primaries.map((item) => item.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length
    || new Set(primaryIds).size !== primaryIds.length
    || candidateIds.length !== primaryIds.length
    || candidateIds.some((id) => !primaryIds.includes(id))) {
    throw new Error('A3_EXPERIMENT_PRIMARY_SCORE_CONTRACT_MISMATCH');
  }
  const scores: A3FieldScore[] = [];
  const unscoredByCaseClassification: Record<string, number> = {};
  for (const candidate of candidates) {
    const primary = primaries.find((item) => item.candidateId === candidate.candidateId)!;
    const labels = candidate.linkedLabels;
    const expectedIds = labels.map((label) => label.labelObservationId);
    const scoreIds = primary.fieldScores.map((score) => score.labelObservationId);
    if (new Set(scoreIds).size !== scoreIds.length || scoreIds.length !== expectedIds.length
      || expectedIds.some((id) => !scoreIds.includes(id))) {
      throw new Error('A3_EXPERIMENT_PRIMARY_SCORE_CONTRACT_MISMATCH');
    }
    for (const label of labels) {
      const score = primary.fieldScores.find((item) => item.labelObservationId === label.labelObservationId)!;
      if (score.labelRole !== label.labelRole
        || (!primary.acceptedForScoring && score.state !== 'UNSCORED')) {
        throw new Error('A3_EXPERIMENT_PRIMARY_SCORE_CONTRACT_MISMATCH');
      }
      scores.push(score);
      if (score.state === 'UNSCORED') {
        unscoredByCaseClassification[primary.classification]
          = (unscoredByCaseClassification[primary.classification] ?? 0) + 1;
      }
    }
  }
  if (scores.length !== humanLabelCount) {
    throw new Error('A3_EXPERIMENT_PRIMARY_SCORE_CONTRACT_MISMATCH');
  }
  const roles = Object.fromEntries([...new Set(candidates.flatMap((candidate) =>
    candidate.linkedLabels.map((label) => label.labelRole)))].sort((a, b) => a.localeCompare(b, 'en-US'))
    .map((labelRole) => [labelRole, fixedDenominatorCount(scores.filter((score) =>
      score.labelRole === labelRole))]));
  const totalScore = fixedDenominatorCount(scores);
  const primaryCoverage = coverage.filter((entry) => entry.repetition === 'primary');
  const primaryAcceptedOutputs = primaries.filter((item) => item.acceptedForScoring).length;
  const repeatAcceptedOutputs = repeats.filter((item) => item.acceptedForScoring).length;
  const stateCounts = { CORRECT: 0, INCORRECT_CONTRADICTORY_ROLE: 0,
    INSUFFICIENT_SEMANTIC_SUPPORT: 0, UNSCORED: 0 };
  for (const score of scores) stateCounts[score.state] += 1;
  return { humanLabelCount, scoredLabelCount: totalScore.scored,
    unscoredLabelCount: totalScore.unscored, correctLabelCount: totalScore.correct,
    fieldScoringCoverage: totalScore.fieldScoringCoverage,
    semanticAccuracyAmongScored: totalScore.semanticAccuracyAmongScored,
    fixedDenominatorCorrectness: totalScore.fixedDenominatorCorrectness,
    stateCounts, unscoredByCaseClassification, roles,
    descriptionScore: roles.description ?? fixedDenominatorCount([]),
    unitScore: roles.unit ?? fixedDenominatorCount([]),
    rateScore: roles.cost ?? fixedDenominatorCount([]), totalScore,
    candidateAcceptance: { accepted: primaryAcceptedOutputs, total: primaries.length,
      rate: ratio(primaryAcceptedOutputs, primaries.length) },
    repeatAcceptance: { accepted: repeatAcceptedOutputs, total: repeats.length,
      rate: ratio(repeatAcceptedOutputs, repeats.length) },
    primaryAcceptedOutputs, repeatAcceptedOutputs,
    contradictoryRoles: scores.reduce((sum, score) => sum + score.contradictoryInterpretations.length, 0),
    missingPrimitiveInterpretations: primaryCoverage.reduce((sum, entry) =>
      sum + (entry.missingPrimitiveIds as readonly string[]).length, 0),
    unknownRoles: primaryCoverage.reduce((sum, entry) => sum
      + (entry.interpretations as readonly Readonly<Record<string, unknown>>[])
        .filter((interpretation) => interpretation.semanticRole === 'unknown').length, 0),
    anchorFailures: coverage.reduce((sum, entry) => sum
      + (entry.anchorTranscriptionFailures as readonly string[]).length, 0),
    sourceTextFailures: coverage.reduce((sum, entry) => sum
      + (entry.groupTextSourceFailures as readonly string[]).length, 0),
    evidenceFidelity: { valid: primaries.reduce((sum, item) => sum
      + item.citedEvidenceIds.length - item.hallucinatedEvidenceIds.length
      - item.foreignCandidateEvidenceIds.length, 0),
    cited: primaries.reduce((sum, item) => sum + item.citedEvidenceIds.length, 0) },
    confidence: primaries.map((item) => ({ candidateId: item.candidateId, confidence: item.confidence })),
    rowStates: primaries.map((item) => ({ candidateId: item.candidateId,
      state: item.proposalBundle?.proposals[0]?.rowInterpretationState ?? null })),
    repeatStableCount: artifact.metrics.repeatedRunStableCount,
    repeatComparableCount: artifact.metrics.repeatedRunComparableCount };
}

function validateBaseline(path: string): Readonly<{ path: string; sha256: string;
  artifact: ForgewingLabelledPricingA3Artifact }> {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath);
  const sha256 = sha256Hex(bytes);
  if (sha256 !== EXPECTED_BASELINE_SHA256) throw new Error('A3_EXPERIMENT_BASELINE_SHA256_MISMATCH');
  const artifact = JSON.parse(bytes.toString('utf8')) as ForgewingLabelledPricingA3Artifact;
  if (artifact.runIdentity.runId !== EXPECTED_BASELINE_RUN_ID
    || artifact.implementationIdentity.commit !== EXPECTED_IMPLEMENTATION_COMMIT
    || artifact.frozenProviderBundle.digestSha256 !== EXPECTED_BUNDLE_DIGEST
    || artifact.modelIdentity.model !== 'claude-sonnet-4-6'
    || artifact.modelIdentity.promptVersion !== 'v3'
    || artifact.modelIdentity.schemaVersion !== 'forgewing-pricing-interpretation-proposal-v1') {
    throw new Error('A3_EXPERIMENT_BASELINE_IDENTITY_MISMATCH');
  }
  return { path: absolutePath, sha256, artifact };
}

export async function runA3PrimitiveCoverageExperiment(params: {
  source: string; labels: string; attestation: string; linkage: string; baseline: string;
  documentType: string; expectedSha256: string; pageRanges: string;
  outputPath: string; freezeOutputPath: string;
}): Promise<Readonly<Record<string, unknown>>> {
  const baseline = validateBaseline(params.baseline);
  const prompt = createA3PrimitiveCoverageExperimentProvider();
  const treatment = await runForgewingLabelledPricingA3({
    entry: { sourcePdfPath: params.source, optionalLabelPackagePath: params.labels,
      corpusKind: 'real_labelled_corpus', expectedSourceSha256: params.expectedSha256,
      documentType: params.documentType,
      authoritativeRatePageRanges: parseRatePageRanges(params.pageRanges) },
    labelLedgerPath: params.labels, attestationPath: params.attestation,
    linkageManifestPath: params.linkage, freezeOutputPath: params.freezeOutputPath,
    failureOutputPath: params.outputPath, callBudget: 4, executeProvider: true,
    repeatEachCandidate: true, expectedCandidateIds: baseline.artifact.frozenProviderBundle.candidates
      .map((candidate) => candidate.candidateId),
    expectedCandidateRowIds: baseline.artifact.frozenProviderBundle.candidates
      .map((candidate) => candidate.rowId),
    providerTimeoutMs: 30_000, providerMaxOutputTokens: 2_000, provider: prompt.provider,
    evaluationPromptVariant: { identifier: prompt.promptIdentifier,
      promptSha256: prompt.promptSha256 },
    experimentHardCallLimit: 4, disableCorrectiveRetries: true, forcePlannedRepeats: true,
    onPreCallReport: (report, bundle) => {
      if (bundle.digestSha256 !== EXPECTED_BUNDLE_DIGEST
        || hashCanonical(bundle.candidates)
          !== hashCanonical(baseline.artifact.frozenProviderBundle.candidates)
        || report.plannedCalls !== 4 || report.hardCallLimit !== 4
        || report.taskRetryLimitPerCandidate !== 0
        || report.evaluationPromptVariant?.promptSha256 !== prompt.promptSha256) {
        throw new Error('A3_EXPERIMENT_TREATMENT_CONTRACT_MISMATCH');
      }
      process.stdout.write(`A3_EXPERIMENT_PRE_CALL_REPORT ${JSON.stringify(report)}\n`);
    },
  });
  if (treatment.providerCallSequence.length !== 4
    || treatment.providerCallSequence.map((item) => `${item.rowId}:${item.repetition}`).join('|')
      !== 'page_priced_schedule:p46:r24:primary|page_priced_schedule:p46:r31:primary|page_priced_schedule:p46:r24:repeat|page_priced_schedule:p46:r31:repeat') {
    throw new Error('A3_EXPERIMENT_CALL_SEQUENCE_MISMATCH');
  }
  const baselineCoverage = summarizePrimitiveCoverage(baseline.artifact);
  const treatmentCoverage = summarizePrimitiveCoverage(treatment);
  const baselineSummary = summarizeFixedDenominatorPrimaryMetrics(baseline.artifact, baselineCoverage);
  const treatmentSummary = summarizeFixedDenominatorPrimaryMetrics(treatment, treatmentCoverage);
  const artifact = { experimentVersion: EXPERIMENT_VERSION,
    authority: 'non_authoritative_measurement', promotionEvidence: false, promotionAuthorized: false,
    runIdentity: treatment.runIdentity, implementationIdentity: treatment.implementationIdentity,
    baselineArtifactIdentity: { path: baseline.path, sha256: baseline.sha256,
      runId: baseline.artifact.runIdentity.runId,
      frozenProviderBundleDigestSha256: baseline.artifact.frozenProviderBundle.digestSha256 },
    sourceCandidateBundle: { baselineDigestSha256: baseline.artifact.frozenProviderBundle.digestSha256,
      treatmentDigestSha256: treatment.frozenProviderBundle.digestSha256,
      candidatesOnlyDigestSha256: hashCanonical(treatment.frozenProviderBundle.candidates),
      exactCandidateInputsEqual: hashCanonical(treatment.frozenProviderBundle.candidates)
        === hashCanonical(baseline.artifact.frozenProviderBundle.candidates) },
    experimentPrompt: { identifier: prompt.promptIdentifier,
      basePromptIdentifier: baseline.artifact.modelIdentity.taskVersion,
      basePromptVersion: 'v3', promptSha256: prompt.promptSha256,
      suffixSha256: sha256Hex(A3_PRIMITIVE_COVERAGE_PROMPT_SUFFIX),
      effectiveCallContractDigestSha256:
        treatment.preCallReport.evaluationPromptVariant?.effectiveCallContractDigestSha256,
      structuredOutputSchemaSha256: hashCanonical(PRICING_INTERPRETATION_OUTPUT_JSON_SCHEMA) },
    providerConfiguration: treatment.modelIdentity,
    frozenCandidateInputs: treatment.frozenProviderBundle.candidates,
    callBudget: treatment.callBudget, providerCallSequence: treatment.providerCallSequence,
    treatmentOutputs: treatment.outputs, treatmentCases: treatment.cases,
    primitiveCoverageMetrics: { baseline: baselineCoverage, treatment: treatmentCoverage },
    controlVsTreatment: { baseline: baselineSummary, treatment: treatmentSummary },
    treatmentArtifact: treatment,
    limitations: [...treatment.limitations,
      'two_candidate_experiment_does_not_authorize_production_prompt_change',
      'primitive_coverage_instruction_conflicts_with_zero-interpretation_insufficient_evidence_shape'] };
  const absolutePath = resolve(params.outputPath);
  const bytes = `${JSON.stringify(artifact, null, 2)}\n`;
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, bytes, { encoding: 'utf8', flag: 'wx' });
  if (readFileSync(absolutePath, 'utf8') !== bytes) {
    throw new Error('A3_EXPERIMENT_ARTIFACT_PERSISTENCE_VERIFICATION_FAILED');
  }
  return artifact;
}

export async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, options: {
    source: { type: 'string' }, labels: { type: 'string' }, attestation: { type: 'string' },
    linkage: { type: 'string' }, baseline: { type: 'string' }, 'document-type': { type: 'string' },
    'expected-sha256': { type: 'string' }, 'page-ranges': { type: 'string' },
    output: { type: 'string' }, 'freeze-output': { type: 'string' },
  } });
  if (!values.source || !values.labels || !values.attestation || !values.linkage || !values.baseline
    || !values['document-type'] || !values['expected-sha256'] || !values['page-ranges']
    || !values.output || !values['freeze-output']) throw new Error('A3_EXPERIMENT_MISSING_ARGUMENT');
  await runA3PrimitiveCoverageExperiment({ source: values.source, labels: values.labels,
    attestation: values.attestation, linkage: values.linkage, baseline: values.baseline,
    documentType: values['document-type'], expectedSha256: values['expected-sha256'],
    pageRanges: values['page-ranges'], outputPath: values.output,
    freezeOutputPath: values['freeze-output'] });
  process.stdout.write(`${resolve(values.output)}\n`);
}

if (process.env.FORGEWING_A3_PRIMITIVE_COVERAGE_EXPERIMENT_CLI === '1') {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
