import assert from 'node:assert/strict';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { createMock, getClaudeClientMock, getClaudeModelMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  getClaudeClientMock: vi.fn(),
  getClaudeModelMock: vi.fn(),
}));

vi.mock('@/lib/server/ai/claudeClient', () => ({
  getClaudeClient: getClaudeClientMock,
  getClaudeModel: getClaudeModelMock,
}));

import { ORCHESTRATOR_SYSTEM_PROMPT } from '@/lib/server/ai/orchestratorSystemPrompt';
import { buildOrchestratorUserContent, runOrchestrator } from '@/lib/server/ai/runOrchestrator';
import { ORCHESTRATOR_ROOT_CAUSE_CATEGORIES } from '@/lib/shared/orchestratorTaxonomy';

afterEach(() => {
  createMock.mockReset();
  getClaudeClientMock.mockReset();
  getClaudeModelMock.mockReset();
});

describe('runOrchestrator', () => {
  it('sends the orchestrator governing prompt as the system parameter', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'Phase A - Audit\nPhase B - Implementation\nPhase C - Verification' }],
    });
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
    getClaudeModelMock.mockReturnValue('claude-sonnet-4-6');

    const result = await runOrchestrator({
      diagnostic: 'Invoice total is duplicated in the UI.',
      structuredFields: {
        rootCauseCategory: 'duplicate_derivation_issue',
        affectedFiles: 'components/projects/ProjectOverview.tsx',
      },
    });

    assert.equal(result.model, 'claude-sonnet-4-6');
    assert.match(result.generatedPrompt, /Phase A/);
    expect(createMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'claude-sonnet-4-6',
      temperature: 0,
      max_tokens: 4000,
      system: ORCHESTRATOR_SYSTEM_PROMPT,
    }));
    const call = createMock.mock.calls[0][0];
    assert.match(call.messages[0].content, /Root cause category: Duplicate Derivation Issue \(duplicate_derivation_issue\)/);
    assert.match(call.messages[0].content, /Freeform diagnostic:/);
  });

  it('labels structured fields and freeform diagnostics', () => {
    const content = buildOrchestratorUserContent({
      diagnostic: 'Totals drift after validation.',
      structuredFields: { rootCauseCategory: 'totals_reconciliation_issue' },
    });

    assert.match(content, /Structured diagnostic fields:/);
    assert.match(content, /Root cause category: Totals Reconciliation Issue \(totals_reconciliation_issue\)/);
    assert.match(content, /Freeform diagnostic:\nTotals drift after validation/);
  });

  it('keeps the system prompt category text sourced from the shared taxonomy', () => {
    for (const category of ORCHESTRATOR_ROOT_CAUSE_CATEGORIES) {
      assert.match(ORCHESTRATOR_SYSTEM_PROMPT, new RegExp(`${category.key}: ${category.label}`));
    }
  });
});
