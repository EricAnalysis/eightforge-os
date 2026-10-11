import { describe, expect, it } from 'vitest';
import { classifyQuestion } from '@/lib/ask/classifier';
import { selectProjectContractAuthority } from '@/lib/ask/selectors/projectContractAuthority';
import type { ProjectSelectorParams } from '@/lib/ask/selectors';

function params(question: string): ProjectSelectorParams {
  return {
    question: classifyQuestion(question),
    projectId: 'synthetic-project',
    project: { id: 'synthetic-project', name: 'Synthetic', validationStatus: 'VALIDATED', validationSummary: null },
    retrieval: { facts: [], documents: [], decisions: [], relationships: [], validatorFindings: [], rawData: {} },
  };
}

describe('contract authority requires the requested stored statement', () => {
  it.each([
    'Which contract is governing this project?',
    'Are tipping fees billable under this contract?',
    'Is monitoring required?',
    'Does the contractor have authority to work on private property?',
    'Which amendment or exhibit controls the rate schedule?',
  ])('does not infer %s from a contract title or NTE amount', (question) => {
    const input = params(question);
    input.retrieval.facts = [{ id: 'ceiling', label: 'NTE amount', fieldKey: 'nte_amount', value: 999,
      extractedFrom: 'contract-doc', documentName: 'Contract', confidence: 100, timestamp: '2026-01-01' }];
    const result = selectProjectContractAuthority(input);
    expect(result.confidence).toBe('not_found');
    expect(result.evidence).toEqual([]);
    expect(result.value).not.toContain('999');
  });

  it('publishes only the actual stored statement with its exact provenance', () => {
    const input = params('Which contract is governing this project?');
    input.retrieval.facts = [{ id: 'authority-1', factId: 'authority-1', label: 'Governing contract',
      fieldKey: 'governing_contract', value: 'Synthetic signed contract A', extractedFrom: 'contract-a',
      page: 2, confidence: 100, timestamp: '2026-01-01' }];
    const result = selectProjectContractAuthority(input);
    expect(result.confidence).toBe('verified');
    expect(result.value).toBe('Governing contract: Synthetic signed contract A');
    expect(result.sources[0].documentId).toBe('contract-a');
    expect(result.evidence[0]).toEqual({ label: 'Governing contract', value: 'Synthetic signed contract A', sourceId: 'authority-1' });
    expect(result.value).not.toMatch(/precedence|effective date/);
  });

  it('withholds conflicting requested statements in either order', () => {
    const input = params('Which contract is governing this project?');
    input.retrieval.facts = ['A', 'B'].map((value) => ({ id: value, label: 'Governing contract',
      fieldKey: 'governing_contract', value, extractedFrom: value, confidence: 100, timestamp: '2026-01-01' }));
    expect(selectProjectContractAuthority(input).confidence).toBe('not_found');
    input.retrieval.facts.reverse();
    expect(selectProjectContractAuthority(input).confidence).toBe('not_found');
    expect(input.retrieval.facts).toHaveLength(2);
  });
});
