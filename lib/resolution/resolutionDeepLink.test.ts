import { describe, expect, it } from 'vitest';

import type { ResolutionCase, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { resolutionWorkspaceHref, selectDeepLinkedCase } from '@/lib/resolution/resolutionDeepLink';

function entry(caseId: string, documentId: string | null, sourceRefs: ResolutionCase['sourceRefs']): ResolutionCase {
  return {
    caseId, kind: 'validator_finding', tier: 'structural', exposureAmount: null, projectId: 'p', documentId,
    physicalPageNumber: null, title: caseId, problem: '', finding: null, previousReviews: [], deterministicState: '',
    originalSourceText: null, rootCauseKey: caseId, evidence: [], suggestions: [], actions: [], sourceRefs,
  };
}

const queue: ResolutionQueue = {
  modelVersion: 'resolution_case_v1', projectId: 'p', forgewingSuggestionsIncluded: false,
  countsByTier: {} as ResolutionQueue['countsByTier'],
  cases: [
    entry('finding:f1', 'doc-2', { findingId: 'f1' }),
    entry('unreadable:doc-1:a', 'doc-1', { anchorKey: 'a' }),
    entry('rereview:doc-1:b', 'doc-1', { anchorKey: 'b', assertionIds: ['x'] }),
  ],
  groups: [
    { rootCauseKey: '1', tier: 'structural', title: '', caseIds: ['unreadable:doc-1:a'], findingCount: 0, exposureAmount: null },
    { rootCauseKey: '2', tier: 'structural', title: '', caseIds: ['finding:f1'], findingCount: 1, exposureAmount: null },
    { rootCauseKey: '3', tier: 'structural', title: '', caseIds: ['rereview:doc-1:b'], findingCount: 0, exposureAmount: null },
  ],
};

describe('resolution workspace deep links (B5-B)', () => {
  it('selects the case whose server-given refs match the link', () => {
    expect(selectDeepLinkedCase(queue, { findingId: 'f1' })).toBe('finding:f1');
    expect(selectDeepLinkedCase(queue, { documentId: 'doc-1', anchorKey: 'b' })).toBe('rereview:doc-1:b');
    expect(selectDeepLinkedCase(queue, { caseId: 'rereview:doc-1:b' })).toBe('rereview:doc-1:b');
    // A document alone picks its first case in queue order.
    expect(selectDeepLinkedCase(queue, { documentId: 'doc-1' })).toBe('unreadable:doc-1:a');
  });

  it('falls back to the first queued case for a link that matches nothing', () => {
    expect(selectDeepLinkedCase(queue, { findingId: 'missing' })).toBe('unreadable:doc-1:a');
    expect(selectDeepLinkedCase(queue, { caseId: 'invented' })).toBe('unreadable:doc-1:a');
    expect(selectDeepLinkedCase({ ...queue, cases: [], groups: [] }, {})).toBeNull();
  });

  it('builds links from records, never from case ids it composes', () => {
    expect(resolutionWorkspaceHref('p 1', { findingId: 'f1' })).toBe('/platform/projects/p%201/resolve?finding=f1');
    expect(resolutionWorkspaceHref('p', { documentId: 'd', anchorKey: 'p8:priced_line:x' }))
      .toBe('/platform/projects/p/resolve?document=d&anchor=p8%3Apriced_line%3Ax');
    expect(resolutionWorkspaceHref('p')).toBe('/platform/projects/p/resolve');
  });
});
