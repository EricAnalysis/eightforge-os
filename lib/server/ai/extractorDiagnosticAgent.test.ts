import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createMock, getClaudeClientMock, getClaudeExtractorModelMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getClaudeClientMock: vi.fn(),
  getClaudeExtractorModelMock: vi.fn(),
}));

vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: getClaudeClientMock,
  getClaudeExtractorModel: getClaudeExtractorModelMock,
}));

import {
  EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT,
  EXTRACTOR_FAILURE_CLASSIFICATIONS,
  buildExtractorDiagnosticUserContent,
  generateExtractorDiagnostic,
} from '@/lib/server/ai/extractorDiagnosticAgent';

afterEach(() => {
  createMock.mockReset();
  getClaudeClientMock.mockReset();
  getClaudeExtractorModelMock.mockReset();
});

describe('extractorDiagnosticAgent', () => {
  it('system prompt includes the full failure-classification list', () => {
    for (const classification of EXTRACTOR_FAILURE_CLASSIFICATIONS) {
      assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, new RegExp(classification));
    }
  });

  it('system prompt requires expected-vs-actual comparison and Phase A/B/C structure', () => {
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /expectedOutput against actualOutput directly/);
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /Operator-supplied expectedOutput is the gold review target/);
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /Phase A - Audit/);
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /Phase B - Implementation/);
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /Phase C - Verification/);
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /stop conditions/);
    assert.match(EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT, /regression fixture recommendation/);
  });

  it('builds user content with operator expected output as the gold target', () => {
    const content = buildExtractorDiagnosticUserContent({
      documentName: 'Rate Schedule A',
      expectedOutput: [{ description: 'Haul', rate: 12 }],
      actualOutput: [{ description: 'Haul', rate: 10 }],
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    });

    assert.match(content, /Operator-supplied expected output \(gold target; do not invent or replace\):/);
    assert.match(content, /EightForge actual output:/);
    assert.match(content, /"rate": 12/);
    assert.match(content, /"rate": 10/);
  });

  it('calls Claude with extractor model override and normalizes structured JSON', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            failureClassification: ['normalization failure'],
            confidence: 'high',
            discrepancyMatrix: [{ expected: 'CYD', actual: 'YD', discrepancy: 'Unit drift' }],
            likelyFailingLayer: 'normalization',
            evidenceNeeded: ['raw row'],
            recommendedMode: 'phase-b-implementation',
            implementationPrompt: 'Phase A - Audit\nPhase B - Implementation\nPhase C - Verification',
            stopConditions: ['schema change required'],
            regressionGates: ['fixture test'],
            prBoundary: 'service only',
            limitations: ['text-only'],
          }),
        },
      ],
    });
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
    getClaudeExtractorModelMock.mockReturnValue('claude-extractor');

    const result = await generateExtractorDiagnostic({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'full-plan',
    });

    assert.deepEqual(result.failureClassification, ['normalization failure']);
    assert.equal(result.confidence, 'high');
    assert.equal(result.recommendedMode, 'phase-b-implementation');
    assert.match(result.implementationPrompt, /Phase A/);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-extractor',
      temperature: 0,
      max_tokens: 5000,
      system: EXTRACTOR_DIAGNOSTIC_SYSTEM_PROMPT,
    }));
  });

  it('preserves UTF-8 punctuation from raw Claude text', async () => {
    createMock.mockResolvedValue({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            failureClassification: ['classification failure', 'canonical projection failure'],
            confidence: 'medium',
            discrepancyMatrix: [],
            likelyFailingLayer: 'classification — canonical projection',
            evidenceNeeded: ['Inspect A2–A6 evidence anchors'],
            recommendedMode: 'phase-a-audit',
            implementationPrompt: 'Phase A — Audit (codex)',
            stopConditions: ['Do not infer missing source text — require operator evidence.'],
            regressionGates: ['Assert clean UTF-8 punctuation — no mojibake markers.'],
            prBoundary: 'diagnostic only',
            limitations: ['AI-proposed expected output — requires operator confirmation.'],
          }),
        },
      ],
    });
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
    getClaudeExtractorModelMock.mockReturnValue('claude-extractor');

    const result = await generateExtractorDiagnostic({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'phase-a-audit',
    });
    const serialized = JSON.stringify(result);

    assert.deepEqual(result.failureClassification, ['classification failure', 'canonical projection failure']);
    assert.match(result.implementationPrompt, /Phase A — Audit/);
    assert.match(result.evidenceNeeded.join(' '), /A2–A6/);
    assert.doesNotMatch(serialized, /Ã|â|�/);
  });

  it('preserves raw prompt text with conservative metadata when Claude returns unparseable output', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'Phase A - Audit only for now' }],
    });
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
    getClaudeExtractorModelMock.mockReturnValue('claude-extractor');

    const result = await generateExtractorDiagnostic({
      expectedOutput: 'expected',
      actualOutput: 'actual',
      targetAgent: 'codex',
      requestedMode: 'phase-a-audit',
    });

    assert.deepEqual(result.failureClassification, ['insufficient evidence']);
    assert.equal(result.confidence, 'low');
    assert.equal(result.implementationPrompt, 'Phase A - Audit only for now');
    assert.match(result.limitations.join(' '), /unstructured output/);
  });
});
