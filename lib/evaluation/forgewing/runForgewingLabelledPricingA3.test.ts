/**
 * SYNTHETIC FIXTURES ONLY. These tests exercise evaluation-runner scoring
 * mechanics and are not pricing-corpus evidence or promotion evidence.
 */
import { describe, expect, it } from 'vitest';

import {
  countValidatedHumanLabels,
  resolveHumanLabelSourceGroup,
  scoreAttempt,
  scoreHumanLinkedField,
  summarizeA3FieldScores,
  validateSourceCellGroupClosure,
  type A3PrimitiveInterpretation,
  type FrozenLinkedLabel,
  type FrozenCandidate,
  type SourceCellGroup,
} from '@/scripts/evaluation/runForgewingLabelledPricingA3';
import type { ForgewingPricingSemanticRole } from '@/lib/forgewing/proposal/schema';
import type { ForgewingPricingCorpusAttempt } from '@/scripts/evaluation/runForgewingPricingCorpus';

function group(sourceCellRole: SourceCellGroup['sourceCellRole'], ids: readonly string[]): SourceCellGroup {
  return { sourceCellRole, sourceObservationIds: [...ids], authoredRawText: 'synthetic authored field' };
}

function label(params: { role: 'description' | 'unit' | 'cost';
  expected: ForgewingPricingSemanticRole; ids: readonly string[];
  groupRole: SourceCellGroup['sourceCellRole'] }): FrozenLinkedLabel {
  return { labelObservationId: `label-${params.role}`, labelRole: params.role,
    expectedSemanticRole: params.expected, expectedRawText: 'synthetic authored field',
    sourceObservationIds: [...params.ids], sourceCellGroup: group(params.groupRole, params.ids) };
}

function interpretation(sourceCellId: string, semanticRole: ForgewingPricingSemanticRole,
  evidenceArtifactIds: readonly string[] = [sourceCellId]): A3PrimitiveInterpretation {
  return { sourceCellId, semanticRole, evidenceArtifactIds: [...evidenceArtifactIds] };
}

function score(params: { role: 'description' | 'unit' | 'cost';
  expected: ForgewingPricingSemanticRole; ids: readonly string[];
  groupRole: SourceCellGroup['sourceCellRole']; interpretations: readonly A3PrimitiveInterpretation[] | null }) {
  return scoreHumanLinkedField({ label: label(params), interpretations: params.interpretations });
}

function measuredCandidate(linkedLabel: FrozenLinkedLabel): FrozenCandidate {
  return { candidateId: 'candidate-digest', candidateDigestSha256: 'candidate-digest',
    rowId: 'row-1', physicalPage: 1, candidateInput: {} as FrozenCandidate['candidateInput'],
    sourceCellGroups: [linkedLabel.sourceCellGroup],
    sourceAnchorIds: [...linkedLabel.sourceObservationIds], resolutionState: 'unresolved',
    eligibilityReason: 'authoritative_scope_match', labelLinkage: 'exact_linkage_complete',
    labelObservationIds: [linkedLabel.labelObservationId], linkedRoles: [linkedLabel.labelRole],
    linkedLabels: [linkedLabel] };
}

function measuredAttempt(params: { resultStatus?: ForgewingPricingCorpusAttempt['resultStatus'];
  rowInterpretationState?: 'observed' | 'insufficient_evidence';
  interpretations: readonly A3PrimitiveInterpretation[] }): ForgewingPricingCorpusAttempt {
  const state = params.rowInterpretationState ?? 'observed';
  return { rowObservationId: 'row-1', resultStatus: params.resultStatus ?? 'applied',
    model: 'synthetic-model', promptTemplateId: 'pricing-interpretation',
    promptTemplateVersion: 'v-test', proposalSchemaVersion: 'proposal-v-test',
    inputSnapshotHash: 'input-hash', taskId: 'task-1', runId: 'run-1', providerCallCount: 1,
    proposalBundle: { proposals: [{ rowInterpretationState: state, confidence: state === 'observed' ? 0.8 : null,
      interpretations: params.interpretations }], abstentions: [] } as unknown as
      ForgewingPricingCorpusAttempt['proposalBundle'], evaluation: null, warnings: [], failureReason: null };
}

describe('SYNTHETIC: A3 human fields score by exact source group', () => {
  it.each([
    ['single-primitive description', 'description', 'description_like_text', ['desc-1'],
      'description', [interpretation('desc-1', 'description_like_text')]],
    ['multi-primitive unit', 'unit', 'unit_like_text', ['unit-1', 'unit-2'],
      'unit', [interpretation('unit-1', 'unit_like_text'), interpretation('unit-2', 'unit_like_text')]],
    ['multi-primitive rate', 'cost', 'rate_like_amount', ['rate-1', 'rate-2'],
      'rate', [interpretation('rate-1', 'rate_like_amount'), interpretation('rate-2', 'rate_like_amount')]],
  ] as const)('scores %s with direct semantic support', (_name, role, expected, ids, groupRole, items) => {
    expect(score({ role, expected, ids, groupRole, interpretations: items })).toMatchObject({
      state: 'CORRECT', correct: true, supportingSourceObservationIds: ids,
      missingSourceObservationIds: [], contradictoryInterpretations: [],
    });
  });

  it('allows a neutral unknown punctuation companion in a split description field', () => {
    const result = score({ role: 'description', expected: 'description_like_text',
      ids: ['word-1', 'punctuation-1', 'word-2'], groupRole: 'description', interpretations: [
        interpretation('word-1', 'description_like_text'),
        interpretation('punctuation-1', 'unknown'),
        interpretation('word-2', 'description_like_text'),
      ] });
    expect(result).toMatchObject({ state: 'CORRECT', correct: true,
      neutralSourceObservationIds: ['punctuation-1'] });
  });

  it('allows an unknown placeholder companion when the exact rate field has direct rate support', () => {
    const result = score({ role: 'cost', expected: 'rate_like_amount',
      ids: ['marker-1', 'placeholder-1'], groupRole: 'rate', interpretations: [
        interpretation('marker-1', 'rate_like_amount'), interpretation('placeholder-1', 'unknown'),
      ] });
    expect(result).toMatchObject({ state: 'CORRECT', correct: true,
      supportingSourceObservationIds: ['marker-1'], neutralSourceObservationIds: ['placeholder-1'] });
  });

  it('fails closed on a contradictory companion role', () => {
    const result = score({ role: 'cost', expected: 'rate_like_amount',
      ids: ['marker-1', 'amount-1'], groupRole: 'rate', interpretations: [
        interpretation('marker-1', 'rate_like_amount'), interpretation('amount-1', 'quantity_like_amount'),
      ] });
    expect(result).toMatchObject({ state: 'INCORRECT_CONTRADICTORY_ROLE', correct: false,
      contradictoryInterpretations: [{ sourceCellId: 'amount-1', semanticRole: 'quantity_like_amount' }] });
  });

  it('lets a contradiction win when one primitive receives both expected and incompatible roles', () => {
    const result = score({ role: 'cost', expected: 'rate_like_amount', ids: ['part-1'],
      groupRole: 'rate', interpretations: [interpretation('part-1', 'rate_like_amount'),
        interpretation('part-1', 'quantity_like_amount')] });
    expect(result).toMatchObject({ state: 'INCORRECT_CONTRADICTORY_ROLE', correct: false });
  });

  it('does not award correctness from source structure when every primitive is unknown', () => {
    const result = score({ role: 'cost', expected: 'rate_like_amount', ids: ['part-1', 'part-2'],
      groupRole: 'rate', interpretations: [
        interpretation('part-1', 'unknown'), interpretation('part-2', 'unknown'),
      ] });
    expect(result).toMatchObject({ state: 'INSUFFICIENT_SEMANTIC_SUPPORT', correct: false,
      supportingSourceObservationIds: [], missingSourceObservationIds: [] });
  });

  it('requires every linked primitive to have its own self-cited interpretation', () => {
    const result = score({ role: 'cost', expected: 'rate_like_amount', ids: ['part-1', 'part-2'],
      groupRole: 'rate', interpretations: [
        interpretation('part-1', 'rate_like_amount', ['part-1', 'part-2']),
      ] });
    expect(result).toMatchObject({ state: 'INSUFFICIENT_SEMANTIC_SUPPORT', correct: false,
      supportingSourceObservationIds: ['part-1'], missingSourceObservationIds: ['part-2'] });
  });

  it('ignores an unknown interpretation from a different group', () => {
    const result = score({ role: 'description', expected: 'description_like_text', ids: ['desc-1'],
      groupRole: 'description', interpretations: [
        interpretation('desc-1', 'description_like_text'), interpretation('other-1', 'unknown'),
      ] });
    expect(result).toMatchObject({ state: 'CORRECT', correct: true,
      neutralSourceObservationIds: [] });
  });

  it('does not accept foreign or uncited semantic support', () => {
    const foreign = score({ role: 'unit', expected: 'unit_like_text', ids: ['unit-1'],
      groupRole: 'unit', interpretations: [interpretation('foreign-1', 'unit_like_text')] });
    const uncited = score({ role: 'unit', expected: 'unit_like_text', ids: ['unit-1'],
      groupRole: 'unit', interpretations: [interpretation('unit-1', 'unit_like_text', ['other-1'])] });
    expect(foreign).toMatchObject({ state: 'INSUFFICIENT_SEMANTIC_SUPPORT', correct: false,
      missingSourceObservationIds: ['unit-1'] });
    expect(uncited).toMatchObject({ state: 'INSUFFICIENT_SEMANTIC_SUPPORT', correct: false,
      missingSourceObservationIds: ['unit-1'] });
  });

  it('keeps a task-valid output without an accepted proposal explicitly unscored', () => {
    expect(score({ role: 'description', expected: 'description_like_text', ids: ['desc-1'],
      groupRole: 'description', interpretations: null })).toMatchObject({ state: 'UNSCORED', correct: false });
  });
});

describe('SYNTHETIC: A3 attempt classification and metric wiring', () => {
  const linkedLabel = label({ role: 'cost', expected: 'rate_like_amount',
    ids: ['rate-1', 'rate-2'], groupRole: 'rate' });
  const candidate = measuredCandidate(linkedLabel);
  const persisted = new Set(['rate-1', 'rate-2']);

  it('classifies expected support plus a neutral companion as correct and retains primitive diagnostics', () => {
    const result = scoreAttempt({ candidate, repetition: 'primary', rawOutput: '{}',
      allPersistedAnchorIds: persisted, attempt: measuredAttempt({ interpretations: [
        interpretation('rate-1', 'rate_like_amount'), interpretation('rate-2', 'unknown'),
      ] }) });
    expect(result).toMatchObject({ classification: 'correct_answer', semanticRoleCorrect: true,
      acceptedForScoring: true, fieldScores: [{ state: 'CORRECT', correct: true }],
      primitiveInterpretations: [{ sourceCellId: 'rate-1', semanticRole: 'rate_like_amount' },
        { sourceCellId: 'rate-2', semanticRole: 'unknown' }] });
  });

  it('classifies an incompatible companion as unsafe confident', () => {
    const result = scoreAttempt({ candidate, repetition: 'primary', rawOutput: '{}',
      allPersistedAnchorIds: persisted, attempt: measuredAttempt({ interpretations: [
        interpretation('rate-1', 'rate_like_amount'), interpretation('rate-2', 'quantity_like_amount'),
      ] }) });
    expect(result).toMatchObject({ classification: 'unsafe_confident_answer',
      semanticRoleCorrect: false, fieldScores: [{ state: 'INCORRECT_CONTRADICTORY_ROLE' }] });
  });

  it('keeps an insufficient-evidence abstention unscored and out of field coverage', () => {
    const result = scoreAttempt({ candidate, repetition: 'primary', rawOutput: '{}',
      allPersistedAnchorIds: persisted, attempt: measuredAttempt({ resultStatus: 'abstained',
        rowInterpretationState: 'insufficient_evidence', interpretations: [] }) });
    expect(result).toMatchObject({ classification: 'safe_abstention', acceptedForScoring: false,
      fieldScores: [{ state: 'UNSCORED' }] });
    expect(summarizeA3FieldScores([result], countValidatedHumanLabels([candidate])))
      .toEqual({ fieldScoreCount: 0, correctlyClassifiedLabelCount: 0, fieldScoringCoverage: 0 });
  });
});

describe('SYNTHETIC: A3 scoring-contract preflight', () => {
  it('requires complete, unique source-group closure over the candidate cells', () => {
    expect(() => validateSourceCellGroupClosure({ cellIds: ['a', 'b', 'c'],
      sourceCellGroups: [group('description', ['a', 'b']), group('rate', ['c'])] })).not.toThrow();
    for (const sourceCellGroups of [
      [group('description', ['a'])],
      [group('description', ['a', 'b']), group('rate', ['b'])],
      [group('description', ['a', 'foreign'])],
      [],
    ]) {
      expect(() => validateSourceCellGroupClosure({ cellIds: ['a', 'b'], sourceCellGroups }))
        .toThrow('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
    }
  });

  it('requires exact group set equality and the expected structural role', () => {
    expect(resolveHumanLabelSourceGroup({ labelRole: 'cost', sourceObservationIds: ['a', 'b'],
      sourceCellGroups: [group('rate', ['b', 'a']), group('description', ['c'])] }))
      .toMatchObject({ sourceCellRole: 'rate', sourceObservationIds: ['b', 'a'] });

    for (const sourceCellGroups of [
      [group('rate', ['a'])],
      [group('rate', ['a', 'b', 'c'])],
      [group('quantity', ['a', 'b'])],
      [group('rate', ['a', 'b']), group('rate', ['b', 'a'])],
    ]) {
      expect(() => resolveHumanLabelSourceGroup({ labelRole: 'cost',
        sourceObservationIds: ['a', 'b'], sourceCellGroups }))
        .toThrow('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
    }
  });

  it('counts validated human fields rather than linked primitives', () => {
    const first = label({ role: 'description', expected: 'description_like_text',
      ids: ['desc-1', 'desc-2', 'desc-3'], groupRole: 'description' });
    const second = label({ role: 'cost', expected: 'rate_like_amount',
      ids: ['rate-1', 'rate-2'], groupRole: 'rate' });
    expect(countValidatedHumanLabels([{ linkedLabels: [first, second] }])).toBe(2);
    expect(() => countValidatedHumanLabels([{ linkedLabels: [first, first] }]))
      .toThrow('A3_SCORING_CONTRACT_REQUIRES_REVIEW');
  });
});
