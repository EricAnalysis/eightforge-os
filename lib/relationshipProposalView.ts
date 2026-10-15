/**
 * Operator view of relationship proposals (P3.2 UI). Pure: derives each
 * proposal's review state and decides whether the operator's link form still
 * matches a prefilled proposal. A proposal is evidence only; the relationship
 * is created solely by the operator's `link_relationship` action, and the
 * proposal id rides along only while the form is exactly that proposal.
 */

export type RelationshipProposalReviewView = Readonly<{
  disposition: 'accepted' | 'already_linked' | 'rejected' | 'deferred';
  relationship_id: string | null;
  created_at: string;
}>;

export type RelationshipProposalView = Readonly<{
  id: string;
  source_document_id: string;
  target_document_id: string;
  relationship_type: 'amends';
  amendment_number: number | null;
  rationale: string;
  authority: 'non_authoritative';
  created_at: string;
  reviews: readonly RelationshipProposalReviewView[];
}>;

export type RelationshipProposalState =
  | Readonly<{ kind: 'open'; deferred: boolean }>
  | Readonly<{ kind: 'decided'; disposition: 'accepted' | 'already_linked' | 'rejected'; relationshipId: string | null }>;

/** The final (non-deferred) review decides a proposal; deferral keeps it open. */
export function relationshipProposalState(proposal: RelationshipProposalView): RelationshipProposalState {
  const final = proposal.reviews.find((review) => review.disposition !== 'deferred');
  if (final && final.disposition !== 'deferred') {
    return { kind: 'decided', disposition: final.disposition, relationshipId: final.relationship_id };
  }
  return { kind: 'open', deferred: proposal.reviews.some((review) => review.disposition === 'deferred') };
}

/** Open proposals first (oldest first, the order they were raised), then decided ones. */
export function orderRelationshipProposals(proposals: readonly RelationshipProposalView[]): RelationshipProposalView[] {
  const open = (proposal: RelationshipProposalView) => relationshipProposalState(proposal).kind === 'open';
  return [...proposals].sort((left, right) => {
    if (open(left) !== open(right)) return open(left) ? -1 : 1;
    return left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id);
  });
}

export type RelationshipLinkForm = Readonly<{
  sourceDocumentId: string;
  targetDocumentId: string;
  relationshipType: string;
  forgewingProposalId?: string;
}>;

/**
 * The proposal id to send with a `link_relationship` request: only when the
 * form still names the prefilled proposal's exact source, target and type, and
 * that proposal is still open. Any edit drops the proposal; the link is then
 * an ordinary operator link.
 */
export function proposalIdForLink(
  form: RelationshipLinkForm,
  proposals: readonly RelationshipProposalView[],
): string | null {
  if (!form.forgewingProposalId) return null;
  const proposal = proposals.find((candidate) => candidate.id === form.forgewingProposalId);
  if (!proposal || relationshipProposalState(proposal).kind !== 'open') return null;
  return proposal.source_document_id === form.sourceDocumentId
    && proposal.target_document_id === form.targetDocumentId
    && proposal.relationship_type === form.relationshipType
    ? proposal.id : null;
}
