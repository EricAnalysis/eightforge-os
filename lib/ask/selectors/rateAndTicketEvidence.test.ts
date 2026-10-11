import { describe, expect, it } from 'vitest';
import type { ProjectSelectorParams } from './index';
import type { ValidatorFinding } from '../types';
import { selectProjectInvoiceSupport } from './projectInvoiceSupport';
import { selectProjectTicketValidation } from './projectTicketValidation';

function finding(description: string, id = 'finding-1'): ValidatorFinding {
  return { id, description, category: 'reconciliation', severity: 'warning', blocksProject: false,
    lastRun: '2026-01-01T00:00:00Z', timestamp: '2026-01-01T00:00:00Z', documentId: 'doc-1', page: 3 };
}

function params(query: string, findings: ValidatorFinding[]): ProjectSelectorParams {
  return {
    question: { originalQuestion: query, intent: 'fact_question', confidence: 'high', keywords: [] },
    projectId: 'project-1', project: { id: 'project-1', name: 'Synthetic Project', validationStatus: 'FINDINGS_OPEN',
      validationSummary: { total_billed: 100, at_risk_amount: 20, unsupported_amount: 20 } },
    retrieval: { facts: [], validatorFindings: findings, decisions: [], documents: [], relationships: [], rawData: {} },
  };
}

describe('Ask stored rate and ticket evidence boundaries', () => {
  const unrelated = finding('The contract expiration date requires review.', 'unrelated');
  it.each([
    'Does this invoice use the correct contract rates?',
    'Are any invoice line items missing from the contract rate table?',
  ])('refuses unrelated invoice findings for %s', (query) => {
    const result = selectProjectInvoiceSupport(params(query, [unrelated]));
    expect(result.confidence).toBe('not_found');
    expect(result.value).toContain('Missing upstream field');
    expect(result.sources).toEqual([]);
    expect(result.findings).toEqual([]);
    expect(result.value).not.toContain(unrelated.description);
  });
  it('returns only the stored rate comparison, preserving full evidence', () => {
    const relevant = finding('Invoice line L1 rate mismatch: expected contract rate 10; actual billed rate 12.', 'rate');
    const result = selectProjectInvoiceSupport(params('Does this invoice use the correct contract rates?', [unrelated, relevant]));
    expect(result.findings).toEqual([relevant]);
    expect(result.value).toBe(`Stored validator rate findings: ${relevant.description}`);
    expect(result.evidence[0].value).toBe(relevant.description);
    expect(result.sources[0].documentId).toBe('doc-1');
    expect(result.sources[0].page).toBe(3);
    expect(result.value).not.toContain('all invoice');
  });
  it('separates missing contract rows from rate comparisons', () => {
    const missing = finding('Invoice line L2 has no contract rate row.', 'missing-rate');
    const query = 'Are any invoice line items missing from the contract rate table?';
    const result = selectProjectInvoiceSupport(params(query, [unrelated, missing]));
    expect(result.findings).toEqual([missing]);
    expect(result.value).toBe(`Stored validator rate findings: ${missing.description}`);
    const mismatch = finding('Invoice line L1 rate mismatch: expected contract rate 10; actual billed rate 12.');
    expect(selectProjectInvoiceSupport(params(query, [mismatch])).confidence).toBe('not_found');
  });
  it('preserves ordinary invoice snapshot support answers', () => {
    const result = selectProjectInvoiceSupport(params('What is the total invoice exposure?', [unrelated]));
    expect(result.value).toContain('Invoice exposure selector');
    expect(result.value).not.toContain('Missing upstream field');
  });
  it.each([
    'Which tickets need correction?',
    'Which tickets have missing disposal site, material, CYD, tonnage, or mileage?',
    'Which tickets have rate-code mismatches?',
    'Which tickets are unresolved by reviewer?',
  ])('refuses unrelated ticket findings for %s', (query) => {
    const result = selectProjectTicketValidation(params(query, [unrelated]));
    expect(result.confidence).toBe('not_found');
    expect(result.value).toContain('Missing upstream field');
    expect(result.sources).toEqual([]);
    expect(result.value).not.toContain('review status open');
  });
  it.each([
    ['Which tickets have missing disposal site, material, CYD, tonnage, or mileage?', 'Ticket T1 is missing disposal site.'],
    ['Which tickets have rate-code mismatches?', 'Ticket T2 has rate-code mismatch: observed A; expected B.'],
    ['Which tickets are unresolved by reviewer?', 'Ticket T3 reviewer status is pending.'],
  ])('exposes only matching stored ticket statement for %s', (query, statement) => {
    const relevant = finding(statement, 'ticket');
    const result = selectProjectTicketValidation(params(query, [unrelated, relevant]));
    expect(result.findings).toEqual([relevant]);
    expect(result.value).toBe(`Stored validator ticket findings: ${statement}`);
    expect(result.evidence[0].value).toBe(statement);
    expect(result.sources[0].factId).toBe('ticket');
  });
  it('does not invent other missing fields or a reviewer state', () => {
    const relevant = finding('Ticket T1 is missing disposal site.');
    const result = selectProjectTicketValidation(params('Which tickets have missing disposal site, material, CYD, tonnage, or mileage?', [relevant]));
    expect(result.value).not.toMatch(/tonnage|mileage|CYD/);
    expect(selectProjectTicketValidation(params('Which tickets are unresolved by reviewer?', [relevant])).confidence).toBe('not_found');
  });
});
