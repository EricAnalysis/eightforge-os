import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildAskRelationships, detectReasoningCase } from '@/lib/ask/reasoning';

describe('ask reasoning', () => {
  it('detects ceiling versus billed questions', () => {
    const reasoningCase = detectReasoningCase({
      intent: 'fact_question',
      confidence: 'medium',
      keywords: ['ceiling', 'over'],
      originalQuestion: 'Are we over the ceiling?',
    });

    assert.equal(reasoningCase, 'ceiling_vs_billed');
  });

  it('builds a ceiling versus billed relationship from facts', () => {
    const relationships = buildAskRelationships({
      question: {
        intent: 'fact_question',
        confidence: 'medium',
        keywords: ['ceiling', 'billed'],
        originalQuestion: 'Are we over the ceiling?',
      },
      facts: [
        {
          id: 'fact-ceiling',
          label: 'contract ceiling',
          value: 500000,
          extractedFrom: 'doc-contract',
          documentName: 'Master Contract',
          confidence: 96,
          timestamp: '2026-04-02T12:00:00.000Z',
          factId: 'fact-ceiling',
          fieldKey: 'contract_ceiling',
        },
        {
          id: 'fact-billed-1',
          label: 'invoice total',
          value: 250000,
          extractedFrom: 'doc-invoice-1',
          documentName: 'Invoice 1',
          confidence: 89,
          timestamp: '2026-04-02T12:01:00.000Z',
          factId: 'fact-billed-1',
          fieldKey: 'invoice_total',
        },
        {
          id: 'fact-billed-2',
          label: 'invoice total',
          value: 275000,
          extractedFrom: 'doc-invoice-2',
          documentName: 'Invoice 2',
          confidence: 91,
          timestamp: '2026-04-02T12:02:00.000Z',
          factId: 'fact-billed-2',
          fieldKey: 'invoice_total',
        },
      ],
      decisions: [],
    });

    assert.equal(relationships[0]?.type, 'ceiling_vs_billed');
    assert.equal(relationships[0]?.status, 'over');
    assert.equal(relationships[0]?.delta, 25000);
  });

  it('builds a contractor mismatch relationship when names disagree', () => {
    const relationships = buildAskRelationships({
      question: {
        intent: 'fact_question',
        confidence: 'medium',
        keywords: ['contractor', 'conflicting'],
        originalQuestion: 'Are contractor names conflicting?',
      },
      facts: [
        {
          id: 'fact-contractor-1',
          label: 'contractor name',
          value: 'Acme Marine LLC',
          extractedFrom: 'doc-contract',
          documentName: 'Master Contract',
          confidence: 95,
          timestamp: '2026-04-02T12:00:00.000Z',
          factId: 'fact-contractor-1',
          fieldKey: 'contractor_name',
        },
        {
          id: 'fact-contractor-2',
          label: 'vendor name',
          value: 'Acme Dredging LLC',
          extractedFrom: 'doc-invoice',
          documentName: 'Invoice 1',
          confidence: 90,
          timestamp: '2026-04-02T12:05:00.000Z',
          factId: 'fact-contractor-2',
          fieldKey: 'vendor_name',
        },
      ],
      decisions: [],
    });

    assert.equal(relationships[0]?.type, 'contractor_mismatch');
    assert.equal(relationships[0]?.conflict, true);
    assert.deepEqual(relationships[0]?.names, ['Acme Marine LLC', 'Acme Dredging LLC']);
  });

  it('returns a non-conflict contractor relationship when names align', () => {
    const relationships = buildAskRelationships({
      question: {
        intent: 'fact_question',
        confidence: 'medium',
        keywords: ['contractor', 'conflicting'],
        originalQuestion: 'Are contractor names conflicting?',
      },
      facts: [
        {
          id: 'fact-contractor-1',
          label: 'contractor name',
          value: 'Acme Marine LLC',
          extractedFrom: 'doc-contract',
          documentName: 'Master Contract',
          confidence: 95,
          timestamp: '2026-04-02T12:00:00.000Z',
          factId: 'fact-contractor-1',
          fieldKey: 'contractor_name',
        },
        {
          id: 'fact-contractor-2',
          label: 'vendor name',
          value: 'Acme Marine, LLC',
          extractedFrom: 'doc-invoice',
          documentName: 'Invoice 1',
          confidence: 90,
          timestamp: '2026-04-02T12:05:00.000Z',
          factId: 'fact-contractor-2',
          fieldKey: 'vendor_name',
        },
      ],
      decisions: [],
    });

    assert.equal(relationships[0]?.type, 'contractor_mismatch');
    assert.equal(relationships[0]?.conflict, false);
    assert.deepEqual(relationships[0]?.names, ['Acme Marine LLC']);
  });
});
