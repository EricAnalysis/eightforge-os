import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AskProjectClaudeContext } from '@/lib/server/ai/askProjectContext';

const { createMock, getClaudeClientMock, getClaudeModelMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getClaudeClientMock: vi.fn(),
  getClaudeModelMock: vi.fn(),
}));

vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: getClaudeClientMock,
  getClaudeModel: getClaudeModelMock,
}));

import {
  ASK_PROJECT_CLAUDE_SYSTEM_PROMPT,
  askProjectWithClaude,
} from '@/lib/server/ai/askProject';

afterEach(() => {
  createMock.mockReset();
  getClaudeClientMock.mockReset();
  getClaudeModelMock.mockReset();
});

describe('askProjectWithClaude', () => {
  it('sends canonical context with read-only safety constraints', async () => {
    const context: AskProjectClaudeContext = {
      contextSource: 'canonical_project_truth_retrieval',
      project: {
        id: 'project-1',
        name: 'Williamson',
        validationStatus: 'BLOCKED',
        validationSummary: null,
      },
      scope: { projectId: 'project-1' },
      retrieval: {
        matchedLayer: 'facts',
        structuredFactsSource: 'canonical_project_facts',
        facts: [
          {
            id: 'fact-1',
            label: 'Contract ceiling (NTE)',
            value: 1000,
            extractedFrom: 'project:project-1',
            confidence: 96,
            timestamp: '2026-06-01T00:00:00.000Z',
            fieldKey: 'nte_amount',
            sourceKind: 'canonical_project_fact',
            sourceLabel: 'Canonical project validation snapshot',
          },
        ],
        validatorFindings: [],
        decisions: [],
        documents: [],
        relationships: [],
        rawData: {
          validatorContext: null,
          totalDocumentCount: 0,
          processedDocumentCount: 0,
          openDecisionCount: 0,
          executionSummary: null,
          reasoningCase: null,
        },
      },
    };
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'The canonical ceiling is $1,000.' }],
    });
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
    getClaudeModelMock.mockReturnValue('claude-sonnet-4-6');

    const result = await askProjectWithClaude({
      question: 'What is the ceiling?',
      context,
    });

    assert.equal(result.answer, 'The canonical ceiling is $1,000.');
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6',
      temperature: 0,
      max_tokens: 1200,
      system: expect.stringContaining('Answer only from the provided EightForge project context.'),
    }));
    const call = createMock.mock.calls[0][0];
    assert.match(call.system, /Do not invent facts/);
    assert.match(call.system, /Do not mutate, approve, override, resolve/);
    assert.match(call.system, /Preserve evidence references/);
    assert.match(call.messages[0].content, /canonical_project_truth_retrieval/);
    assert.match(call.messages[0].content, /Contract ceiling/);
    assert.equal(ASK_PROJECT_CLAUDE_SYSTEM_PROMPT.includes('Surfaces read canonical truth'), true);
  });
});
