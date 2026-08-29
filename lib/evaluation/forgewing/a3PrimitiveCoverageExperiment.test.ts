import { describe, expect, it } from 'vitest';

import type { ForgewingLabelledPricingA3Artifact } from '@/scripts/evaluation/runForgewingLabelledPricingA3';
import type { A3FieldScore, A3FieldScoreState, FrozenCandidate,
  FrozenLinkedLabel } from '@/scripts/evaluation/runForgewingLabelledPricingA3';
import { summarizeFixedDenominatorPrimaryMetrics,
  summarizePrimitiveCoverage } from '@/scripts/evaluation/runForgewingA3PrimitiveCoverageExperiment';

const ROLES = ['description', 'unit', 'cost'] as const;

function linkedLabel(candidateId: string, role: typeof ROLES[number]): FrozenLinkedLabel {
  const sourceCellRole = role === 'cost' ? 'rate' : role;
  return { labelObservationId: `${candidateId}-${role}-label`, labelRole: role,
    expectedSemanticRole: role === 'description' ? 'description_like_text'
      : role === 'unit' ? 'unit_like_text' : 'rate_like_amount',
    expectedRawText: `${candidateId}-${role}-text`, sourceObservationIds: [`${candidateId}-${role}-cell`],
    sourceCellGroup: { sourceCellRole, sourceObservationIds: [`${candidateId}-${role}-cell`],
      authoredRawText: `${candidateId}-${role}-text` } };
}

function fieldScore(label: FrozenLinkedLabel, state: A3FieldScoreState): A3FieldScore {
  return { labelObservationId: label.labelObservationId, labelRole: label.labelRole,
    expectedSemanticRole: label.expectedSemanticRole, sourceCellRole: label.sourceCellGroup.sourceCellRole,
    linkedSourceObservationIds: label.sourceObservationIds, state, correct: state === 'CORRECT',
    supportingSourceObservationIds: state === 'CORRECT' ? label.sourceObservationIds : [],
    neutralSourceObservationIds: [],
    missingSourceObservationIds: state === 'INSUFFICIENT_SEMANTIC_SUPPORT'
      || state === 'UNSCORED' ? label.sourceObservationIds : [],
    contradictoryInterpretations: state === 'INCORRECT_CONTRADICTORY_ROLE'
      ? [{ sourceCellId: label.sourceObservationIds[0]!, semanticRole: 'unknown',
        evidenceArtifactIds: label.sourceObservationIds }] : [] };
}

function candidate(candidateId: string): FrozenCandidate {
  const linkedLabels = ROLES.map((role) => linkedLabel(candidateId, role));
  return { candidateId, candidateDigestSha256: `${candidateId}-digest`, rowId: `${candidateId}-row`,
    physicalPage: 1, candidateInput: {} as FrozenCandidate['candidateInput'],
    sourceCellGroups: linkedLabels.map((label) => label.sourceCellGroup),
    sourceAnchorIds: linkedLabels.flatMap((label) => label.sourceObservationIds),
    resolutionState: 'unresolved', eligibilityReason: 'authoritative_scope_match',
    labelLinkage: 'exact_linkage_complete',
    labelObservationIds: linkedLabels.map((label) => label.labelObservationId),
    linkedRoles: linkedLabels.map((label) => label.labelRole), linkedLabels };
}

type CaseShape = Readonly<{ candidateId: string; accepted: boolean; classification: string;
  states: readonly A3FieldScoreState[]; repetition?: 'primary' | 'repeat' }>;

function fixedDenominatorArtifact(caseShapes: readonly CaseShape[],
  candidates: readonly FrozenCandidate[] = [candidate('c1'), candidate('c2')]): ForgewingLabelledPricingA3Artifact {
  const byId = new Map(candidates.map((item) => [item.candidateId, item]));
  const artifact = { frozenProviderBundle: { candidates }, cases: caseShapes.map((shape) => {
    const item = byId.get(shape.candidateId)!;
    return { candidateId: shape.candidateId, repetition: shape.repetition ?? 'primary',
      acceptedForScoring: shape.accepted, classification: shape.classification,
      fieldScores: item.linkedLabels.map((label, index) => fieldScore(label, shape.states[index]!)),
      contradictoryInterpretations: [], citedEvidenceIds: [], hallucinatedEvidenceIds: [],
      foreignCandidateEvidenceIds: [], confidence: null, proposalBundle: null };
  }), metrics: { repeatedRunStableCount: 0, repeatedRunComparableCount: 0 } };
  return artifact as unknown as ForgewingLabelledPricingA3Artifact;
}

describe('SYNTHETIC: A3 primitive-coverage diagnostics', () => {
  it('preserves rejected raw output while reporting missing, duplicate, and foreign evidence', () => {
    const ids = ['description', 'unit', 'route', 'currency', 'amount'];
    const rawOutput = JSON.stringify({ interpretations: [
      { sourceCellId: 'description', semanticRole: 'description_like_text', sourceText: 'Work',
        evidenceIds: ['description'] },
      { sourceCellId: 'unit', semanticRole: 'unit_like_text', sourceText: 'Each', evidenceIds: ['unit'] },
      { sourceCellId: 'route', semanticRole: 'unknown', sourceText: 'N/A', evidenceIds: ['route'] },
      { sourceCellId: 'currency', semanticRole: 'rate_like_amount', sourceText: '$',
        evidenceIds: ['currency', 'mistyped-amount'] },
      { sourceCellId: 'currency', semanticRole: 'unknown', sourceText: '$ 1.00', evidenceIds: ['currency'] },
    ] });
    const artifact = { frozenProviderBundle: { candidates: [{ candidateId: 'candidate-1',
      rowId: 'row-1', sourceAnchorIds: ids,
      sourceCellGroups: [{ sourceCellRole: 'description', sourceObservationIds: ['description'],
        authoredRawText: 'Work' }, { sourceCellRole: 'unit', sourceObservationIds: ['unit'],
        authoredRawText: 'Each' }, { sourceCellRole: 'origin_destination', sourceObservationIds: ['route'],
        authoredRawText: 'N/A' }, { sourceCellRole: 'rate', sourceObservationIds: ['currency', 'amount'],
        authoredRawText: '$ 1.00' }],
      candidateInput: { rowObservation: { cells: [
        { observationId: 'description', rawText: 'Work' }, { observationId: 'unit', rawText: 'Each' },
        { observationId: 'route', rawText: 'N/A' }, { observationId: 'currency', rawText: '$' },
        { observationId: 'amount', rawText: '1.00' },
      ] } } }] }, cases: [{ candidateId: 'candidate-1', rowObservationId: 'row-1',
        repetition: 'repeat', acceptedForScoring: false, warnings: ['unknown_evidence_reference'],
        rawAcceptedOutput: null, rawRejectedDiagnostic: rawOutput }],
    } as unknown as ForgewingLabelledPricingA3Artifact;
    const [coverage] = summarizePrimitiveCoverage(artifact);
    expect(coverage).toMatchObject({ admittedPrimitiveCount: 5, interpretationCount: 5,
      uniqueSourceCellIdCount: 4, missingPrimitiveIds: ['amount'], duplicatePrimitiveIds: ['currency'],
      duplicateInterpretationCount: 1, selfCitedPrimitiveCount: 4,
      completeExactlyOnceSelfCited: false, anchorTranscriptionFailures: ['mistyped-amount'],
      groupTextSourceFailures: ['currency'] });
  });
});

describe('SYNTHETIC: A3 fixed human-label denominator', () => {
  const correct: readonly A3FieldScoreState[] = ['CORRECT', 'CORRECT', 'CORRECT'];
  const unscored: readonly A3FieldScoreState[] = ['UNSCORED', 'UNSCORED', 'UNSCORED'];

  it('keeps all six accepted baseline labels and reports four correct', () => {
    const summary = summarizeFixedDenominatorPrimaryMetrics(fixedDenominatorArtifact([
      { candidateId: 'c1', accepted: true, classification: 'unsafe_confident_answer',
        states: ['CORRECT', 'CORRECT', 'INSUFFICIENT_SEMANTIC_SUPPORT'] },
      { candidateId: 'c2', accepted: true, classification: 'unsafe_confident_answer',
        states: ['CORRECT', 'CORRECT', 'INSUFFICIENT_SEMANTIC_SUPPORT'] },
    ]));
    expect(summary).toMatchObject({ humanLabelCount: 6, scoredLabelCount: 6,
      unscoredLabelCount: 0, correctLabelCount: 4, fieldScoringCoverage: 1,
      semanticAccuracyAmongScored: 4 / 6, fixedDenominatorCorrectness: 4 / 6,
      totalScore: { correct: 4, scored: 6, unscored: 0, total: 6 } });
  });

  it.each(['provider_failure', 'schema_failure', 'safe_abstention'])(
    'retains failed or abstained labels as UNSCORED for %s', (classification) => {
      const summary = summarizeFixedDenominatorPrimaryMetrics(fixedDenominatorArtifact([
        { candidateId: 'c1', accepted: false, classification, states: unscored },
        { candidateId: 'c2', accepted: true, classification: 'correct_answer', states: correct },
      ]));
      expect(summary).toMatchObject({ humanLabelCount: 6, scoredLabelCount: 3,
        unscoredLabelCount: 3, correctLabelCount: 3, fieldScoringCoverage: 0.5,
        semanticAccuracyAmongScored: 1, fixedDenominatorCorrectness: 0.5,
        candidateAcceptance: { accepted: 1, total: 2, rate: 0.5 },
        descriptionScore: { correct: 1, scored: 1, unscored: 1, total: 2 },
        unitScore: { correct: 1, scored: 1, unscored: 1, total: 2 },
        rateScore: { correct: 1, scored: 1, unscored: 1, total: 2 },
        unscoredByCaseClassification: { [classification]: 3 } });
    });

  it('preserves a six-label denominator when zero candidates are accepted', () => {
    const summary = summarizeFixedDenominatorPrimaryMetrics(fixedDenominatorArtifact([
      { candidateId: 'c1', accepted: false, classification: 'provider_failure', states: unscored },
      { candidateId: 'c2', accepted: false, classification: 'schema_failure', states: unscored },
    ]));
    expect(summary).toMatchObject({ humanLabelCount: 6, scoredLabelCount: 0,
      unscoredLabelCount: 6, correctLabelCount: 0, fieldScoringCoverage: 0,
      semanticAccuracyAmongScored: null, fixedDenominatorCorrectness: 0,
      totalScore: { correct: 0, scored: 0, unscored: 6, total: 6 } });
  });

  it('counts accepted contradiction and insufficient support as scored but incorrect', () => {
    const summary = summarizeFixedDenominatorPrimaryMetrics(fixedDenominatorArtifact([
      { candidateId: 'c1', accepted: true, classification: 'unsafe_confident_answer',
        states: ['CORRECT', 'CORRECT', 'INCORRECT_CONTRADICTORY_ROLE'] },
      { candidateId: 'c2', accepted: true, classification: 'unsafe_confident_answer',
        states: ['CORRECT', 'CORRECT', 'INSUFFICIENT_SEMANTIC_SUPPORT'] },
    ]));
    expect(summary).toMatchObject({ humanLabelCount: 6, scoredLabelCount: 6,
      unscoredLabelCount: 0, correctLabelCount: 4,
      stateCounts: { CORRECT: 4, INCORRECT_CONTRADICTORY_ROLE: 1,
        INSUFFICIENT_SEMANTIC_SUPPORT: 1, UNSCORED: 0 },
      totalScore: { incorrectContradictoryRole: 1, insufficientSemanticSupport: 1 } });
  });

  it('keeps repeat acceptance separate and never substitutes repeat scores for primaries', () => {
    const summary = summarizeFixedDenominatorPrimaryMetrics(fixedDenominatorArtifact([
      { candidateId: 'c1', accepted: false, classification: 'schema_failure', states: unscored },
      { candidateId: 'c2', accepted: false, classification: 'schema_failure', states: unscored },
      { candidateId: 'c1', accepted: true, classification: 'correct_answer', states: correct,
        repetition: 'repeat' },
      { candidateId: 'c2', accepted: true, classification: 'correct_answer', states: correct,
        repetition: 'repeat' },
    ]));
    expect(summary).toMatchObject({ correctLabelCount: 0,
      candidateAcceptance: { accepted: 0, total: 2 },
      repeatAcceptance: { accepted: 2, total: 2, rate: 1 } });
  });

  it('fails closed on duplicate label IDs or a malformed primary score set', () => {
    const duplicateCandidates = [candidate('c1'), candidate('c2')];
    duplicateCandidates[1] = { ...duplicateCandidates[1], linkedLabels: [
      { ...duplicateCandidates[1]!.linkedLabels[0]!,
        labelObservationId: duplicateCandidates[0]!.linkedLabels[0]!.labelObservationId },
      ...duplicateCandidates[1]!.linkedLabels.slice(1),
    ] };
    expect(() => summarizeFixedDenominatorPrimaryMetrics(fixedDenominatorArtifact([
      { candidateId: 'c1', accepted: true, classification: 'correct_answer', states: correct },
      { candidateId: 'c2', accepted: true, classification: 'correct_answer', states: correct },
    ], duplicateCandidates))).toThrow('A3_SCORING_CONTRACT_REQUIRES_REVIEW');

    const malformed = fixedDenominatorArtifact([
      { candidateId: 'c1', accepted: true, classification: 'correct_answer', states: correct },
      { candidateId: 'c2', accepted: true, classification: 'correct_answer', states: correct },
    ]) as unknown as { cases: Array<{ fieldScores: A3FieldScore[] }> };
    malformed.cases[0]!.fieldScores = malformed.cases[0]!.fieldScores.slice(1);
    expect(() => summarizeFixedDenominatorPrimaryMetrics(
      malformed as unknown as ForgewingLabelledPricingA3Artifact))
      .toThrow('A3_EXPERIMENT_PRIMARY_SCORE_CONTRACT_MISMATCH');
  });
});
