import { describe, expect, it } from 'vitest';
import { classifyQuestion } from '@/lib/ask/classifier';
import { buildAskResponse } from '@/lib/ask/answerBuilder';
import type { ProjectSelectorParams } from './index';
import { selectProjectInvoiceSupport } from './projectInvoiceSupport';
import { project as fixture } from '../../../scripts/ask/diagnosticFixture';

function input(question: string, summary: unknown): ProjectSelectorParams {
  return {
    question: classifyQuestion(question), projectId: 'p',
    project: { id: 'p', name: 'P', validationStatus: 'VALIDATED', validationSummary: summary },
    retrieval: { facts: [{ id: 'total', label: 'Total billed', fieldKey: 'total_billed', value: 100,
      extractedFrom: 'project:p', sourceKind: 'canonical_project_fact', confidence: 96, timestamp: '2026-01-01' }],
      validatorFindings: [], decisions: [], documents: [], relationships: [], rawData: { matchedLayer: 'facts' } },
  };
}

describe('invoice support requires requested canonical values', () => {
  it.each([
    'Which invoice amounts are unsupported?', 'Which invoice amounts are fully supported?',
    'What is the total invoice exposure?', 'Is the project approaching contract ceiling?',
  ])('withholds %s with only unrelated billed evidence', (question) => {
    const params = input(question, { status: 'VALIDATED', blocker_count: 0, warning_count: 0 });
    const result = selectProjectInvoiceSupport(params);
    expect(result.confidence).toBe('not_found');
    expect(result.sources).toEqual([]);
    const response = buildAskResponse({ ...params, orgId: 'o' });
    expect(response.actionableGap).toBeDefined();
    expect(response.sections?.confidenceState).toBe('Not Found');
  });

  it.each(['supported_amount', 'unreconciled_amount', 'billed_amount'])('withholds incomplete per-invoice %s', field => {
    const summary = structuredClone(fixture.validationSummary);
    const invoice = summary.exposure.invoices[0] as unknown as Record<string, unknown>;
    invoice[field] = null;
    if (field === 'unreconciled_amount') invoice.at_risk_amount = null;
    const result = selectProjectInvoiceSupport(input('Which invoice amounts are unsupported?', summary));
    expect(result.confidence).toBe('not_found');
  });

  it('keeps complete invoice support sourced to its snapshot, not a billed fact', () => {
    const result = selectProjectInvoiceSupport(input('Which invoice amounts are fully supported?', fixture.validationSummary));
    expect(result.confidence).toBe('verified');
    expect(result.sources.map(source => source.factId)).toEqual(['project:p:validator-summary']);
    expect(result.value).toContain('700,000');
  });

  it('reads a present zero exposure without requiring unrelated optional totals', () => {
    const result = selectProjectInvoiceSupport(input('What is the total invoice exposure?', { at_risk_amount: 0 }));
    expect(result.confidence).toBe('verified');
    expect(result.value).toContain('$0.00');
    expect(result.value).not.toContain('unresolved');
    expect(result.sources.map(source => source.factId)).toEqual(['project:p:validator-summary']);
  });

  it('reads ceiling and billed amounts without inventing remaining or proximity values', () => {
    const result = selectProjectInvoiceSupport(input('Is the project approaching contract ceiling?', { nte_amount: 1000 }));
    expect(result.confidence).toBe('verified');
    expect(result.value).toContain('NTE ceiling $1,000');
    expect(result.value).toContain('billed total $100.00');
    expect(result.value).toContain('No remaining amount, overage or proximity conclusion');
  });

  it('does not present invoice totals as ticket-specific cost evidence', () => {
    const result = selectProjectInvoiceSupport(input('Show me unsupported ticket costs.', fixture.validationSummary));
    expect(result.confidence).toBe('not_found');
    expect(result.value).toContain('ticket-specific unsupported cost amounts');
    expect(result.sources).toEqual([]);
  });
});
