import { describe, expect, it } from 'vitest';

import {
  orderRelationshipProposals,
  proposalIdForLink,
  relationshipProposalState,
  type RelationshipProposalView,
} from './relationshipProposalView';

const proposal = (id: string, reviews: RelationshipProposalView['reviews'] = [], createdAt = '2026-10-15T00:00:00Z'): RelationshipProposalView => ({
  id, source_document_id: 'amendment', target_document_id: 'contract', relationship_type: 'amends',
  amendment_number: 3, rationale: 'The invoice cites Amendment 3.', authority: 'non_authoritative',
  created_at: createdAt, reviews,
});
const review = (disposition: RelationshipProposalView['reviews'][number]['disposition'], relationshipId: string | null = null) =>
  ({ disposition, relationship_id: relationshipId, created_at: '2026-10-15T01:00:00Z' });

describe('relationship proposal view (P3.2 UI)', () => {
  it('a proposal stays open until a non-deferred review decides it', () => {
    expect(relationshipProposalState(proposal('p'))).toEqual({ kind: 'open', deferred: false });
    expect(relationshipProposalState(proposal('p', [review('deferred')]))).toEqual({ kind: 'open', deferred: true });
    expect(relationshipProposalState(proposal('p', [review('deferred'), review('accepted', 'rel-1')])))
      .toEqual({ kind: 'decided', disposition: 'accepted', relationshipId: 'rel-1' });
    expect(relationshipProposalState(proposal('p', [review('rejected')])))
      .toEqual({ kind: 'decided', disposition: 'rejected', relationshipId: null });
  });

  it('lists open proposals before decided ones', () => {
    const ordered = orderRelationshipProposals([
      proposal('decided', [review('rejected')], '2026-10-01T00:00:00Z'),
      proposal('later', [], '2026-10-03T00:00:00Z'),
      proposal('earlier', [review('deferred')], '2026-10-02T00:00:00Z'),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['earlier', 'later', 'decided']);
  });

  it('sends the proposal id only while the form is exactly that open proposal', () => {
    const open = proposal('p');
    const form = { sourceDocumentId: 'amendment', targetDocumentId: 'contract', relationshipType: 'amends', forgewingProposalId: 'p' };
    expect(proposalIdForLink(form, [open])).toBe('p');
    // Any edit makes it an ordinary operator link.
    expect(proposalIdForLink({ ...form, targetDocumentId: 'other' }, [open])).toBeNull();
    expect(proposalIdForLink({ ...form, relationshipType: 'supersedes' }, [open])).toBeNull();
    expect(proposalIdForLink({ ...form, forgewingProposalId: undefined }, [open])).toBeNull();
    // A decided or unknown proposal is never cited.
    expect(proposalIdForLink(form, [proposal('p', [review('rejected')])])).toBeNull();
    expect(proposalIdForLink(form, [])).toBeNull();
  });
});
