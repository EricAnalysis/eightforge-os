import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import { isRiskAnalysisQuestion, rankProjectIssues } from '@/lib/ask/riskAnalysis';

describe('ask risk analysis', () => {
  it('detects fix-first and biggest-issue questions', () => {
    assert.equal(
      isRiskAnalysisQuestion({
        intent: 'action_needed',
        confidence: 'high',
        keywords: ['fix', 'first'],
        originalQuestion: 'What should I fix first?',
      }),
      true,
    );

    assert.equal(
      isRiskAnalysisQuestion({
        intent: 'validator_question',
        confidence: 'medium',
        keywords: ['biggest', 'issue'],
        originalQuestion: 'What is the biggest issue?',
      }),
      true,
    );
  });

  it('ranks critical blockers above lower-severity items', () => {
    const ranked = rankProjectIssues({
      now: new Date('2026-04-02T12:00:00.000Z'),
      findings: [
        {
          id: 'finding-1',
          severity: 'critical',
          category: 'contract',
          description: 'Missing executed contract ceiling',
          blocksProject: true,
          lastRun: '2026-03-25T12:00:00.000Z',
          timestamp: '2026-03-25T12:00:00.000Z',
        },
        {
          id: 'finding-2',
          severity: 'warning',
          category: 'docs',
          description: 'Missing supporting invoice backup',
          blocksProject: false,
          lastRun: '2026-03-20T12:00:00.000Z',
          timestamp: '2026-03-20T12:00:00.000Z',
        },
      ],
      decisions: [
        {
          id: 'decision-1',
          title: 'Review invoice exception',
          status: 'open',
          severity: 'warning',
          summary: 'Potential $125,000 overage needs review',
          confidence: 82,
          createdAt: '2026-03-22T12:00:00.000Z',
          detectedAt: '2026-03-23T12:00:00.000Z',
          details: {
            financial_impact: 125000,
          },
        },
      ],
    });

    assert.equal(ranked.length, 3);
    assert.equal(ranked[0]?.issue, 'Missing executed contract ceiling');
    assert.equal(ranked[0]?.severity, 'critical');
    assert.equal(ranked[0]?.rank, 1);
    assert.match(ranked[0]?.reasoning ?? '', /blocking progress/i);
  });
});
