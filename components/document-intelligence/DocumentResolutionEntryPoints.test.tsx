import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({ default: ({ href, children }: { href: string; children: ReactNode }) => <a href={href}>{children}</a> }));
vi.mock('@/lib/supabaseClient', () => ({ supabase: { auth: { getSession: async () => ({ data: { session: null } }) } } }));

import { documentCorrectionCases, DocumentResolutionCaseList } from '@/components/document-intelligence/DocumentResolutionEntryPoints';
import type { ResolutionCase, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { selectDeepLinkedCase } from '@/lib/resolution/resolutionDeepLink';

const caseFor = (caseId: string, documentId: string, anchor: string): ResolutionCase => ({
  caseId, kind: 'review_required_value', tier: 'missing_authoritative_value', exposureAmount: null,
  projectId: 'project-1', documentId, physicalPageNumber: 10, title: 'Review printed row',
  problem: '', finding: null, previousReviews: [], deterministicState: '', originalSourceText: 'Equipment | Excavator | Hour | $220',
  rootCauseKey: caseId, evidence: [], suggestions: [], alsoUnresolved: ['category'], sourceRefs: { anchorKey: anchor },
  actions: [{ kind: 'enter_reviewed_value', method: 'POST', endpoint: '/facts', factKey: 'contract_rate_row',
    target: { anchorKey: anchor, physicalPageNumber: 10, pageRepresentationDigest: 'a'.repeat(64),
      unresolvedReason: 'review', rawText: 'Excavator | Hour | $220', sourceObservationIds: ['o1'],
      sourceRegion: { coordinate_space: 'source', boxes: [] }, visual: null }, supersedesAssertionId: null,
    category: { required: true, options: ['Equipment'] } }],
});
const own = caseFor('case-1', 'doc-1', 'p10:priced_line:one');
const other = caseFor('case-2', 'doc-2', 'p10:priced_line:two');
const queue: ResolutionQueue = { modelVersion: 'resolution_case_v1', projectId: 'project-1', forgewingSuggestionsIncluded: false,
  countsByTier: {} as ResolutionQueue['countsByTier'], cases: [own, other], groups: [
    { rootCauseKey: 'one', tier: own.tier, title: '', caseIds: [own.caseId], findingCount: 0, exposureAmount: null },
    { rootCauseKey: 'two', tier: other.tier, title: '', caseIds: [other.caseId], findingCount: 0, exposureAmount: null },
  ] };

describe('document correction navigation', () => {
  it.each(['Extraction', 'Evidence'])('%s uses the same server case identity and source row context', () => {
    const cases = documentCorrectionCases(queue, 'doc-1');
    expect(cases).toEqual([own]);
    const html = renderToStaticMarkup(<DocumentResolutionCaseList projectId="project-1" documentId="doc-1" cases={cases} />);
    expect(html).toContain('Equipment | Excavator | Hour | $220');
    expect(html).toContain('Category review');
    expect(html).toContain('case=case-1&amp;document=doc-1&amp;anchor=p10%3Apriced_line%3Aone');
    expect(html).not.toContain('case-2');
    expect(html).not.toContain('Ask Forgewing');
    expect(selectDeepLinkedCase(queue, { caseId: own.caseId, documentId: 'doc-1', anchorKey: own.sourceRefs.anchorKey })).toBe(own.caseId);
  });

  it('rejects cross-document and absent case identity', () => {
    expect(documentCorrectionCases(queue, 'doc-3')).toEqual([]);
    expect(selectDeepLinkedCase(queue, { caseId: own.caseId, documentId: 'doc-2', anchorKey: own.sourceRefs.anchorKey })).toBeNull();
    expect(selectDeepLinkedCase(queue, { caseId: 'fabricated', documentId: 'doc-1' })).toBeNull();
  });
});
