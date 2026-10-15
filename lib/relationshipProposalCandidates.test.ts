import { describe, expect, it } from 'vitest';

import {
  precedenceSnapshotDigest,
  referencedAmendmentCandidates,
  relationshipProposalDigest,
} from '@/lib/relationshipProposalCandidates';

const CONTRACT = 'contract-base';
const documents = [
  { id: CONTRACT, title: 'Master Services Agreement', name: 'msa.pdf' },
  { id: 'amend-3', title: 'Amendment No. 3 to the Agreement', name: 'a3.pdf' },
  { id: 'invoice-1', title: 'Invoice 104', name: 'inv104.pdf' },
];
const families = [{ family: 'contract', governing_document_id: CONTRACT }];
const finding = (number = 3) => ({
  checkKey: `SOURCES_REFERENCED_AMENDMENT_MISSING:p1:amendment:${number}`,
  subjectId: `p1:amendment:${number}`,
  evidence: [{ documentId: 'invoice-1', page: 2, matchedText: `per Amendment No. ${number}` }],
});
const candidates = (overrides: Partial<Parameters<typeof referencedAmendmentCandidates>[0]> = {}) =>
  referencedAmendmentCandidates({ documents, relationships: [], families, findings: [finding()], ...overrides });

describe('referenced-amendment relationship candidates (P3.2 V1)', () => {
  it('proposes "the identified amendment amends the governing contract", with the cited evidence', () => {
    expect(candidates()).toEqual([expect.objectContaining({
      sourceDocumentId: 'amend-3', targetDocumentId: CONTRACT, relationshipType: 'amends', amendmentNumber: 3,
      proposer: 'deterministic_b7_candidate', anchorCheckKey: 'SOURCES_REFERENCED_AMENDMENT_MISSING:p1:amendment:3',
      evidence: [{ documentId: 'invoice-1', page: 2, matchedText: 'per Amendment No. 3' }],
    })]);
    expect(candidates()[0]!.rationale).toContain('Confirm only if it amends that contract');
  });

  it('never guesses: no candidate, several candidates, or no governing contract propose nothing', () => {
    expect(candidates({ findings: [finding(7)] })).toEqual([]);
    expect(candidates({ documents: [...documents, { id: 'amend-3b', title: 'Amendment 3 (signed copy)', name: 'a3b.pdf' }] }))
      .toEqual([]);
    expect(candidates({ families: [{ family: 'contract', governing_document_id: null }] })).toEqual([]);
  });

  it('skips documents that already amend, are duplicates, or are superseded', () => {
    for (const relationship_type of ['amends', 'duplicate_of', 'supersedes']) {
      expect(candidates({ relationships: [{ source_document_id: 'amend-3', target_document_id: 'x', relationship_type }] }))
        .toEqual([]);
    }
  });

  it('proposes only amends, never governance or precedence changes', () => {
    for (const candidate of candidates()) {
      expect(candidate.relationshipType).toBe('amends');
      expect(candidate.targetDocumentId).toBe(CONTRACT);
    }
  });

  it('gives the same proposal the same identity, and a changed state a new one', () => {
    const digest = precedenceSnapshotDigest({ documents, relationships: [], families });
    const [candidate] = candidates();
    expect(relationshipProposalDigest('p1', candidate!, digest)).toBe(relationshipProposalDigest('p1', candidate!, digest));
    const changed = precedenceSnapshotDigest({ documents, relationships: [], families: [{ family: 'contract', governing_document_id: 'other' }] });
    expect(changed).not.toBe(digest);
    expect(relationshipProposalDigest('p1', candidate!, changed)).not.toBe(relationshipProposalDigest('p1', candidate!, digest));
  });
});
