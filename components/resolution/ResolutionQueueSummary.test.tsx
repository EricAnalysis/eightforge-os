import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: () => null }));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));
vi.mock('@/components/recovery/SourceEvidencePage', () => ({ SourceEvidencePage: () => null }));
vi.mock('@/components/validator/ManualRateLinkResolutionPanel', () => ({ ManualRateLinkResolutionPanel: () => null }));

import { ResolutionQueueSummaryLine, ResolutionDocumentFilter } from '@/components/resolution/ResolutionWorkspace';
import type { ResolutionCase } from '@/lib/resolution/resolutionCases';
import { summarizeResolutionQueue } from '@/lib/resolution/resolutionQueueSummary';

function resolutionCase(overrides: Partial<ResolutionCase>): ResolutionCase {
  return {
    caseId: 'case-1', kind: 'unreadable_priced_line', tier: 'missing_authoritative_value', exposureAmount: null,
    projectId: 'project-1', documentId: 'doc-1', physicalPageNumber: 8, title: 't', problem: 'p', finding: null,
    previousReviews: [], deterministicState: 'd', originalSourceText: null, rootCauseKey: 'r', evidence: [],
    suggestions: [], actions: [], sourceRefs: {}, ...overrides,
  };
}

describe('Resolution queue summary', () => {
  it('summarizes the open work by kind, counting value cases that also need a category', () => {
    const cases = [
      resolutionCase({ caseId: 'a', kind: 'review_required_value', alsoUnresolved: ['category'] }),
      resolutionCase({ caseId: 'b', kind: 'review_required_value' }),
      resolutionCase({ caseId: 'c', kind: 'category_review', alsoUnresolved: ['category'] }),
      resolutionCase({ caseId: 'd', kind: 'coverage_gap' }),
    ];
    expect(summarizeResolutionQueue(cases)).toEqual({ total: 4, alsoCategory: 1, byKind: [
      { kind: 'review_required_value', label: 'Rate to confirm', count: 2 },
      { kind: 'coverage_gap', label: 'Page not read', count: 1 },
      { kind: 'category_review', label: 'Category', count: 1 },
    ], byDocument: [{ documentId: 'doc-1', label: 'Document', count: 4 }] });
    expect(renderToStaticMarkup(<ResolutionQueueSummaryLine summary={summarizeResolutionQueue(cases)} />))
      .toContain('4 open: 2 rate to confirm · 1 page not read · 1 category · 1 also need a category');
  });

  it('shows document counts from the complete queue, including project-level work', () => {
    const summary = summarizeResolutionQueue([
      resolutionCase({ caseId: 'a', documentId: 'golden', documentLabel: 'Golden' }),
      resolutionCase({ caseId: 'b', documentId: 'hillsdale', documentLabel: 'Hillsdale' }),
      resolutionCase({ caseId: 'c', documentId: 'golden', documentLabel: 'Golden' }),
      resolutionCase({ caseId: 'd', documentId: null }),
    ]);
    expect(summary.byDocument).toEqual([
      { documentId: 'golden', label: 'Golden', count: 2 },
      { documentId: 'hillsdale', label: 'Hillsdale', count: 1 },
      { documentId: null, label: 'Project-level work', count: 1 },
    ]);
    const html = renderToStaticMarkup(<ResolutionDocumentFilter summary={summary} documentId="golden" onChange={() => {}} />);
    expect(html).toContain('All documents (4)');
    expect(html).toContain('Golden (2)');
    expect(html).toContain('Project-level work (1)');
    expect(html).toContain('aria-label="Filter resolution queue by document"');
    expect(renderToStaticMarkup(<ResolutionDocumentFilter summary={summary} documentId="removed" onChange={() => {}} />))
      .toContain('Selected document (0)');
  });
});
