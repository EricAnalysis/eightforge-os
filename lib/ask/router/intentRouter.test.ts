import { describe, expect, it } from 'vitest';

import { classifyQueryIntent } from '@/lib/ask/router/intentRouter';
import type { IntentGroup } from '@/lib/ask/router/intentClassificationMap';

const ORIGINAL_HARNESS_QUERIES: Array<{
  query: string;
  surface: 'project' | 'portfolio';
  expected: IntentGroup;
}> = [
  { query: 'Is this project ready for invoice approval?', surface: 'project', expected: 'approval_execution_state' },
  { query: 'Which invoice amounts are fully supported?', surface: 'project', expected: 'invoice_support' },
  { query: 'What is blocking approval?', surface: 'project', expected: 'approval_execution_state' },
  { query: 'Where did the $815,559.35 total come from?', surface: 'project', expected: 'invoice_support' },
  { query: 'Show me unsupported ticket costs.', surface: 'project', expected: 'invoice_support' },
  { query: 'What is at risk in this project?', surface: 'project', expected: 'invoice_support' },
  { query: 'What changed since the last review?', surface: 'project', expected: 'review_audit_state' },
  { query: 'Which contract is governing?', surface: 'project', expected: 'contract_authority' },
  { query: 'Are tipping fees billable under this contract?', surface: 'project', expected: 'contract_authority' },
  { query: 'Is this FEMA reimbursable work?', surface: 'project', expected: 'contract_authority' },
  { query: 'What federal compliance requirements apply?', surface: 'project', expected: 'contract_authority' },
  { query: 'Can the contractor work on private property?', surface: 'project', expected: 'contract_authority' },
  { query: 'Is a performance bond required?', surface: 'project', expected: 'contract_authority' },
  { query: 'What happens if FEMA funding is denied?', surface: 'project', expected: 'contract_authority' },
  { query: 'Is monitoring required?', surface: 'project', expected: 'contract_authority' },
  { query: 'What documentation is required for payment?', surface: 'project', expected: 'contract_authority' },
  { query: 'Which projects are blocked right now?', surface: 'portfolio', expected: 'portfolio_project_status' },
  { query: 'What is the total at-risk amount across all projects?', surface: 'portfolio', expected: 'portfolio_project_status' },
  { query: 'Which projects need review first?', surface: 'portfolio', expected: 'portfolio_project_status' },
  { query: 'What issues are happening most across projects?', surface: 'portfolio', expected: 'portfolio_project_status' },
  { query: 'Which projects are ready for approval?', surface: 'portfolio', expected: 'portfolio_project_status' },
  { query: 'Are any projects approaching contract ceiling?', surface: 'portfolio', expected: 'portfolio_project_status' },
];

describe('classifyQueryIntent', () => {
  it('routes a clear project query with high confidence', () => {
    const result = classifyQueryIntent('Can we release payment on this?', 'project');

    expect(result.intent).toBe('approval_execution_state');
    expect(result.confidence).toBe('high');
  });

  it('routes a partial project signal with medium confidence', () => {
    const result = classifyQueryIntent('Coverage?', 'project');

    expect(result.intent).toBe('invoice_support');
    expect(result.confidence).toBe('medium');
  });

  it('returns ambiguous for tied project signals', () => {
    const result = classifyQueryIntent('approval invoice', 'project');

    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe('low');
    if (result.intent === 'ambiguous') {
      expect(result.candidates).toEqual(['approval_execution_state', 'invoice_support']);
      expect(result.clarificationPrompt).toContain('Which are you asking about?');
    }
  });

  it('returns ambiguous for a query with no project signal', () => {
    const result = classifyQueryIntent('What should I do?', 'project');

    expect(result.intent).toBe('ambiguous');
    expect(result.confidence).toBe('low');
    if (result.intent === 'ambiguous') {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.clarificationPrompt).toContain('Which are you asking about?');
    }
  });

  it('routes portfolio surface queries to the portfolio group regardless of keywords', () => {
    const result = classifyQueryIntent('Which invoice amounts are fully supported?', 'portfolio');

    expect(result.intent).toBe('portfolio_project_status');
    expect(result.confidence).not.toBe('low');
  });

  it('routes the original 22 harness phrasings to their selector groups', () => {
    for (const item of ORIGINAL_HARNESS_QUERIES) {
      const result = classifyQueryIntent(item.query, item.surface);
      expect(result.intent, item.query).toBe(item.expected);
      expect(result.confidence, item.query).not.toBe('low');
    }
  });
});
