import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { buildAskResponse } from '@/lib/ask/answerBuilder';

describe('ask answer builder', () => {
  it('returns sourced fact response', () => {
    const response = buildAskResponse({
      question: {
        intent: 'fact_question',
        confidence: 'high',
        keywords: ['contract', 'ceiling'],
        originalQuestion: 'What is the contract ceiling?',
      },
      retrieval: {
        facts: [
          {
            id: 'fact-1',
            label: 'contract ceiling',
            value: 2500000,
            extractedFrom: 'doc-1',
            documentName: 'Master Contract',
            confidence: 96,
            timestamp: '2026-04-02T12:00:00.000Z',
            factId: 'fact-1',
            fieldKey: 'contract_ceiling',
          },
        ],
        validatorFindings: [],
        decisions: [],
        documents: [],
        relationships: [],
        rawData: {
          matchedLayer: 'facts',
        },
      },
      project: {
        id: 'project-1',
        name: 'Example Project',
      },
      projectId: 'project-1',
      orgId: 'org-1',
    });

    assert.match(response.answer, /\$2,500,000/);
    assert.equal(response.retrievalUsed, 'facts');
    assert.equal(response.sources[0]?.type, 'fact');
    assert.ok(response.confidenceScore >= 80);
  });

  it('returns validator-backed blocker answer', () => {
    const response = buildAskResponse({
      question: {
        intent: 'validator_question',
        confidence: 'high',
        keywords: ['blocked'],
        originalQuestion: 'Why is this blocked?',
      },
      retrieval: {
        facts: [],
        validatorFindings: [
          {
            id: 'finding-1',
            severity: 'critical',
            category: 'financial_integrity',
            description: 'Invoice total exceeds contract ceiling',
            blocksProject: true,
            lastRun: '2026-04-02T12:00:00.000Z',
            timestamp: '2026-04-02T12:00:00.000Z',
            blockedReason: '1 critical finding blocking progress',
          },
        ],
        decisions: [],
        documents: [],
        relationships: [],
        rawData: {
          matchedLayer: 'validator',
          validatorContext: {
            projectStatus: 'blocked',
            criticalFindings: [],
            blockedReason: '1 critical finding blocking progress',
            lastRun: '2026-04-02T12:00:00.000Z',
          },
        },
      },
      project: {
        id: 'project-1',
        name: 'Example Project',
        validationStatus: 'BLOCKED',
      },
      projectId: 'project-1',
      orgId: 'org-1',
    });

    assert.match(response.answer, /blocked/i);
    assert.equal(response.retrievalUsed, 'validator');
    assert.ok(response.sources.some((source) => source.type === 'validator'));
  });

  it('returns ceiling versus billed reasoning answer', () => {
    const response = buildAskResponse({
      question: {
        intent: 'fact_question',
        confidence: 'medium',
        keywords: ['ceiling', 'billed', 'over'],
        originalQuestion: 'Are we over the ceiling?',
      },
      retrieval: {
        facts: [],
        validatorFindings: [],
        decisions: [],
        documents: [],
        relationships: [
          {
            type: 'ceiling_vs_billed',
            ceiling: 500000,
            billed: 540000,
            delta: 40000,
            status: 'over',
            message:
              'Total billed is $540,000 against a contract ceiling of $500,000, so the project is over the ceiling by $40,000.',
          },
        ],
        rawData: {
          matchedLayer: 'relationships',
          reasoningFacts: [
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
              id: 'fact-billed',
              label: 'invoice total',
              value: 540000,
              extractedFrom: 'doc-invoice-1',
              documentName: 'Invoice Register',
              confidence: 91,
              timestamp: '2026-04-02T12:05:00.000Z',
              factId: 'fact-billed',
              fieldKey: 'invoice_total',
            },
          ],
        },
      },
      project: {
        id: 'project-1',
        name: 'Example Project',
      },
      projectId: 'project-1',
      orgId: 'org-1',
    });

    assert.match(response.answer, /over the ceiling/i);
    assert.equal(response.retrievalUsed, 'relationships');
    assert.equal(response.relationships?.[0]?.type, 'ceiling_vs_billed');
    assert.ok(response.sources.some((source) => source.type === 'calculation'));
    assert.ok(response.sources.some((source) => source.type === 'fact'));
  });

  it('returns contractor mismatch reasoning answer', () => {
    const response = buildAskResponse({
      question: {
        intent: 'fact_question',
        confidence: 'medium',
        keywords: ['contractor', 'conflicting'],
        originalQuestion: 'Are contractor names conflicting?',
      },
      retrieval: {
        facts: [],
        validatorFindings: [],
        decisions: [],
        documents: [],
        relationships: [
          {
            type: 'contractor_mismatch',
            names: ['Acme Marine LLC', 'Acme Dredging LLC'],
            conflict: true,
            message:
              'Contractor names conflict across project documents: Acme Marine LLC, Acme Dredging LLC.',
          },
        ],
        rawData: {
          matchedLayer: 'relationships',
          reasoningFacts: [
            {
              id: 'fact-contractor-1',
              label: 'contractor name',
              value: 'Acme Marine LLC',
              extractedFrom: 'doc-contract',
              documentName: 'Master Contract',
              confidence: 94,
              timestamp: '2026-04-02T12:00:00.000Z',
              factId: 'fact-contractor-1',
              fieldKey: 'contractor_name',
            },
            {
              id: 'fact-contractor-2',
              label: 'vendor name',
              value: 'Acme Dredging LLC',
              extractedFrom: 'doc-invoice',
              documentName: 'Invoice 12',
              confidence: 89,
              timestamp: '2026-04-02T12:05:00.000Z',
              factId: 'fact-contractor-2',
              fieldKey: 'vendor_name',
            },
          ],
        },
      },
      project: {
        id: 'project-1',
        name: 'Example Project',
      },
      projectId: 'project-1',
      orgId: 'org-1',
    });

    assert.match(response.answer, /conflict/i);
    assert.equal(response.retrievalUsed, 'relationships');
    assert.equal(response.relationships?.[0]?.type, 'contractor_mismatch');
    assert.equal(response.sources.length, 2);
    assert.ok(response.sources.every((source) => source.type === 'fact'));
  });

  it('returns ranked risk answer for fix-first questions', () => {
    const response = buildAskResponse({
      question: {
        intent: 'action_needed',
        confidence: 'high',
        keywords: ['fix', 'first'],
        originalQuestion: 'What should I fix first?',
      },
      retrieval: {
        facts: [],
        validatorFindings: [
          {
            id: 'finding-1',
            severity: 'critical',
            category: 'contract',
            description: 'Missing executed contract ceiling',
            blocksProject: true,
            lastRun: '2026-04-02T12:00:00.000Z',
            timestamp: '2026-04-02T12:00:00.000Z',
          },
        ],
        decisions: [
          {
            id: 'decision-1',
            title: 'Review invoice exception',
            status: 'open',
            severity: 'warning',
            summary: 'Potential overage needs review',
            confidence: 82,
            createdAt: '2026-04-01T12:00:00.000Z',
          },
        ],
        documents: [],
        relationships: [],
        rawData: {
          matchedLayer: 'validator',
          riskAssessments: [
            {
              issue: 'Missing executed contract ceiling',
              severity: 'critical',
              rank: 1,
              reasoning: 'critical validator, blocking progress, open for 8 days',
            },
            {
              issue: 'Review invoice exception',
              severity: 'warning',
              rank: 2,
              reasoning: 'warning decision, exposure $125,000, open for 5 days',
            },
          ],
        },
      },
      project: {
        id: 'project-1',
        name: 'Example Project',
      },
      projectId: 'project-1',
      orgId: 'org-1',
    });

    assert.match(response.answer, /Start with "Missing executed contract ceiling"/);
    assert.equal(response.riskAssessments?.[0]?.rank, 1);
    assert.ok(response.sources.some((source) => source.type === 'validator'));
    assert.ok(response.sources.some((source) => source.type === 'decision'));
  });
});
