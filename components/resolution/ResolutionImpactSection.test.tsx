import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

import { ResolutionImpactView } from '@/components/resolution/ResolutionImpactSection';
import type { ResolutionImpact } from '@/lib/resolution/resolutionImpact';

const finding = (findingKey: string, blocksApproval: boolean) => ({
  findingKey, findingId: null, ruleId: findingKey, title: `${findingKey} title`, severity: 'critical', blocksApproval,
  subjectType: 'invoice_line', subjectId: 'line-1',
});

const available: ResolutionImpact = {
  modelVersion: 'resolution_impact_v1', status: 'available', caseId: 'c', actionKind: 'enter_reviewed_value',
  resolvesFindingIds: ['A', 'B'], opensFindingIds: ['N'], changesFindingIds: [],
  resolves: [finding('A', true), finding('B', false)], opens: [finding('N', false)], changes: [],
  findingsBefore: 12, findingsAfter: 11, blockersBefore: 9, blockersAfter: 8, approvalBefore: 'blocked', approvalAfter: 'blocked',
  affectedInvoiceLines: ['line-1'], affectedDocuments: ['doc'], resolvesCaseIds: ['finding:f1', 'finding:f2'], financialExposureDelta: null,
  impactDigest: 'd'.repeat(64),
};

describe('impact display (B5-C)', () => {
  it('shows the server counts, including what it would open', () => {
    const html = renderToStaticMarkup(<ResolutionImpactView impact={available} />);
    expect(html).toContain('Resolves 2 findings');
    expect(html).toContain('Clears 1 approval blocker');
    expect(html).toContain('Affects 1 invoice line');
    // One root-cause action, aggregated once across the cases it closes.
    expect(html).toContain('Closes 2 cases in this queue');
    expect(html).toContain('Opens 1 new finding');
    expect(html).toContain('Open findings 12 → 11');
    expect(html).toContain('View affected findings');
    // No exposure line when the Validator did not compute one.
    expect(html).not.toContain('At risk');
  });

  it('reports added blockers as added', () => {
    const html = renderToStaticMarkup(<ResolutionImpactView impact={{ ...available, blockersAfter: 11 } as ResolutionImpact} />);
    expect(html).toContain('Adds 2 approval blockers');
  });

  it('shows no counts at all when impact cannot be computed', () => {
    const html = renderToStaticMarkup(<ResolutionImpactView impact={{
      modelVersion: 'resolution_impact_v1', status: 'unsupported', caseId: 'c', actionKind: 'resolve_execution_item',
      code: 'not_simulated', reason: 'An execution outcome changes the finding’s lifecycle.',
    }} />);
    expect(html).toContain('Impact cannot yet be computed for this action.');
    expect(html).toContain('An execution outcome changes');
    expect(html).not.toMatch(/Resolves|Opens|Clears|\b0\b/);
  });
});
