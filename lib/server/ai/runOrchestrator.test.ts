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
      question: 'Invoice total is duplicated in the UI.',
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
      max_tokens: 6000,
      system: ORCHESTRATOR_SYSTEM_PROMPT,
    }));
    const call = createMock.mock.calls[0][0];
    assert.match(call.messages[0].content, /Root cause category: Duplicate Derivation Issue \(duplicate_derivation_issue\)/);
    assert.match(call.messages[0].content, /Freeform question or diagnostic:/);
  });

  it('labels optional structured fields and freeform questions', () => {
    const content = buildOrchestratorUserContent({
      question: 'Totals drift after validation.',
      structuredFields: { rootCauseCategory: 'totals_reconciliation_issue' },
    });

    assert.match(content, /Optional structured context:/);
    assert.match(content, /Root cause category: Totals Reconciliation Issue \(totals_reconciliation_issue\)/);
    assert.match(content, /Freeform question or diagnostic:\nTotals drift after validation/);
  });

  it('allows a general question without a root cause category', async () => {
    createMock.mockResolvedValue({
      content: [{ type: 'text', text: 'A decision records operator intent; execution turns it into tracked work.' }],
    });
    getClaudeClientMock.mockReturnValue({ messages: { create: createMock } });
    getClaudeModelMock.mockReturnValue('claude-sonnet-4-6');

    const result = await runOrchestrator({
      question: "What's the difference between a decision and an execution item in EightForge?",
    });

    assert.match(result.generatedPrompt, /decision records operator intent/);
    const call = createMock.mock.calls[0][0];
    assert.match(call.messages[0].content, /Optional structured context:\nNone provided/);
    assert.match(call.messages[0].content, /Freeform question or diagnostic:/);
  });

  it('keeps the system prompt category text sourced from the shared taxonomy', () => {
    for (const category of ORCHESTRATOR_ROOT_CAUSE_CATEGORIES) {
      assert.match(ORCHESTRATOR_SYSTEM_PROMPT, new RegExp(`${category.key}: ${category.label}`));
    }
  });

  it('keeps representative doctrine sections in the system prompt', () => {
    for (const phrase of [
      'turns messy project documents into source-backed operational truth',
      'Documents -> Extraction -> Canonical Facts -> Validator -> Decisions/Execution -> Audit',
      'Operator-confirmed facts outrank model guesses',
      'The Orchestrator is not a fifth user-facing project surface',
      'It does not execute fixes itself',
      'Prefer reuse over rewrite',
      'Extraction is high risk because a bad extraction can poison canonical facts',
      'The Validator consumes canonical facts, document relationships, contract family context, operator decisions, execution state, and audit state',
      'Document families can include Contract -> Amendment -> Attachment -> Exhibit -> Price Sheet -> Invoice -> Ticket Spreadsheet -> Supporting Evidence',
      'old hidden path still influencing behavior',
      'Use judgment. Not every casual answer needs a heavy template.',
      'Do not claim something was fixed when only advice was generated.',
    ]) {
      assert.match(ORCHESTRATOR_SYSTEM_PROMPT, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });
});
