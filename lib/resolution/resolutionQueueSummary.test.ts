import { describe, expect, it } from 'vitest';
import { filterResolutionQueue, summarizeResolutionQueue } from './resolutionQueueSummary';
import { selectDeepLinkedCase } from './resolutionDeepLink';
import { nextCaseIdAfterSave } from './resolutionActionRequest';
import type { ResolutionCase, ResolutionQueue } from './resolutionCases';
import { RESOLUTION_CASE_MODEL_VERSION } from './resolutionCases';

function entry(caseId: string, documentId: string | null, kind: ResolutionCase['kind'] = 'validator_finding'): ResolutionCase {
  return { caseId, documentId, kind, documentLabel: documentId ?? undefined, projectId: 'project',
    physicalPageNumber: null, title: caseId, problem: 'review', finding: null, previousReviews: [],
    deterministicState: 'open', originalSourceText: null, rootCauseKey: 'shared', evidence: [],
    suggestions: [], actions: [], sourceRefs: {}, tier: 'blocks_approval', exposureAmount: 10 };
}
function queue(cases: ResolutionCase[]): ResolutionQueue {
  return { modelVersion: RESOLUTION_CASE_MODEL_VERSION, projectId: 'project', cases, forgewingSuggestionsIncluded: false,
    groups: [{ rootCauseKey: 'shared', title: 'Shared source', tier: 'blocks_approval',
      caseIds: cases.map((item) => item.caseId), findingCount: cases.length, exposureAmount: cases.length * 10 }],
    countsByTier: { blocks_approval: cases.length, missing_authoritative_value: 0,
      missing_document_or_link: 0, affects_pricing: 0, structural: 0, informational: 0 } };
}

describe('document queue filtering', () => {
  it('keeps complete counts, primary-document attribution and server order without changing case authority', () => {
    const all = queue([entry('a', 'golden'), entry('b', 'hillsdale'), entry('c', 'golden', 'category_review'), entry('p', null)]);
    const original = JSON.stringify(all);
    expect(filterResolutionQueue(all, undefined)).toBe(all);
    const visible = filterResolutionQueue(all, 'golden');
    expect(visible.cases.map((item) => item.caseId)).toEqual(['a', 'c']);
    expect(visible.cases[0]).toBe(all.cases[0]);
    expect(visible.groups[0]).toMatchObject({ caseIds: ['a', 'c'], findingCount: 1, exposureAmount: 20 });
    expect(visible.countsByTier.blocks_approval).toBe(2);
    expect(summarizeResolutionQueue(all.cases).total).toBe(4);
    expect(filterResolutionQueue(all, null).cases.map((item) => item.caseId)).toEqual(['p']);
    expect(JSON.stringify(all)).toBe(original);
    expect(selectDeepLinkedCase(filterResolutionQueue(all, undefined), { caseId: 'b' })).toBe('b');
  });

  it('advances within the displayed document and leaves no selection after its last case closes', () => {
    const all = queue([entry('a', 'golden'), entry('b', 'hillsdale'), entry('c', 'golden')]);
    const previousOrder = filterResolutionQueue(all, 'golden').groups.flatMap((group) => group.caseIds);
    const refreshed = queue([entry('b', 'hillsdale'), entry('c', 'golden')]);
    const refreshedOrder = filterResolutionQueue(refreshed, 'golden').groups.flatMap((group) => group.caseIds);
    expect(nextCaseIdAfterSave({ previousOrder, savedCaseId: 'a', refreshedOrder })).toBe('c');
    const emptyOrder = filterResolutionQueue(queue([entry('b', 'hillsdale')]), 'golden').groups.flatMap((group) => group.caseIds);
    expect(nextCaseIdAfterSave({ previousOrder: refreshedOrder, savedCaseId: 'c', refreshedOrder: emptyOrder })).toBeNull();
    expect(filterResolutionQueue(refreshed, 'missing').groups).toEqual([]);
  });
});
