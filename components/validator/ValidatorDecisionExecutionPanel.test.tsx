import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IssueObject } from '@/lib/issueObjects';
import { ValidatorDecisionExecutionPanel } from './ValidatorDecisionExecutionPanel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: vi.fn() } } }));

function issueFor(ruleId: string, executionStatus: 'open' | 'resolved' = 'open'): IssueObject {
  return {
    issueId: `issue-${ruleId}`,
    projectId: 'project-1',
    finding: {
      id: `finding-${ruleId}`,
      project_id: 'project-1',
      rule_id: ruleId,
      subject_id: 'fact:invoice-doc-1:line:6',
    },
    executionItemId: 'execution-1',
    executionItem: { status: executionStatus, outcome: null, override_reason: null },
  } as unknown as IssueObject;
}

function renderPanel(issue: IssueObject): string {
  return renderToStaticMarkup(<ValidatorDecisionExecutionPanel issue={issue} onActionComplete={() => {}} />);
}

// Marker rendered only by ManualRateLinkResolutionPanel.
const RATE_LINK_PANEL_MARKER = 'Source invoice rate code';

describe('ValidatorDecisionExecutionPanel primary workflow', () => {
  it('keeps Confirm / Correct / Override primary for CROSS_DOCUMENT_CONTRACT_RATE_EXISTS, rate link secondary', () => {
    const html = renderPanel(issueFor('CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'));
    for (const label of ['Confirm', 'Correct', 'Override']) expect(html).toContain(`>${label}</button>`);
    expect(html).toContain('data-testid="secondary-rate-link"');
    expect(html).toContain('Link Rate Manually');
    // Collapsed until the operator asks for it; never replaces the decision panel.
    expect(html).not.toContain(RATE_LINK_PANEL_MARKER);
    expect(html.indexOf('>Override</button>')).toBeLessThan(html.indexOf('Link Rate Manually'));
  });

  it('leads with the rate-link panel for FINANCIAL_RATE_CODE_MISSING', () => {
    const html = renderPanel(issueFor('FINANCIAL_RATE_CODE_MISSING'));
    expect(html).toContain(RATE_LINK_PANEL_MARKER);
    expect(html).not.toContain('>Confirm</button>');
    expect(html).not.toContain('data-testid="secondary-rate-link"');
  });

  it('offers no rate link for rules a manual link cannot close, or once the item is resolved', () => {
    const other = renderPanel(issueFor('FINANCIAL_NTE_EXCEEDED'));
    expect(other).toContain('>Confirm</button>');
    expect(other).not.toContain('data-testid="secondary-rate-link"');

    const resolved = renderPanel(issueFor('CROSS_DOCUMENT_CONTRACT_RATE_EXISTS', 'resolved'));
    expect(resolved).toContain('Resolved');
    expect(resolved).not.toContain('data-testid="secondary-rate-link"');
  });
});
