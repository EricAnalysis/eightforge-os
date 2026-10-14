import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * P3.2: a relationship proposal is confirmed only through the operator's
 * existing link_relationship action. The proposal is verified before the
 * link; the relationship row is created by the operator; the acceptance is
 * recorded against the row the operator created.
 */

const mocks = vi.hoisted(() => ({
  actor: vi.fn(),
  admin: vi.fn(),
  snapshot: vi.fn(),
  activity: vi.fn(),
  revalidate: vi.fn(),
  readProposal: vi.fn(),
  decided: vi.fn(),
  recordReview: vi.fn(),
}));

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: mocks.actor }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: mocks.admin }));
vi.mock('@/lib/server/documentPrecedence', () => ({ loadProjectDocumentPrecedenceSnapshot: mocks.snapshot }));
vi.mock('@/lib/server/activity/logActivityEvent', () => ({ logActivityEvent: mocks.activity }));
vi.mock('@/lib/validator/revalidationRequests', () => ({ requestDocumentPrecedenceRevalidation: mocks.revalidate }));
vi.mock('@/lib/server/relationshipProposals', () => ({
  readProposalForLink: mocks.readProposal,
  relationshipProposalDecided: mocks.decided,
  recordRelationshipProposalReview: mocks.recordReview,
}));

import { PATCH } from '@/app/api/projects/[id]/document-precedence/route';

const ORG = 'org-1';
const PROJECT = 'project-1';
const AMENDMENT = 'doc-amendment-3';
const CONTRACT = 'doc-contract';
const PROPOSAL = 'proposal-1';

let inserted: Array<Record<string, unknown>>;

function relationshipsTable(existing: Array<{ id: string; source_document_id: string; target_document_id: string; relationship_type: string }>) {
  return {
    insert(payload: Record<string, unknown>) {
      inserted.push(payload);
      return { select: () => ({ maybeSingle: async () => ({ data: { id: 'rel-new' }, error: null }) }) };
    },
    select: () => {
      const chain = { eq: () => chain, maybeSingle: async () => ({ data: existing[0] ? { id: existing[0].id } : null, error: null }) };
      return chain;
    },
  };
}

function setup(existing: Array<{ id: string; source_document_id: string; target_document_id: string; relationship_type: string }> = []) {
  mocks.snapshot.mockResolvedValue({
    documents: [
      { id: AMENDMENT, title: 'Amendment No. 3', name: 'a3.pdf', project_id: PROJECT },
      { id: CONTRACT, title: 'Agreement', name: 'msa.pdf', project_id: PROJECT },
    ],
    relationships: existing.map((row) => ({ ...row, project_id: PROJECT, created_by: 'someone', created_at: null })),
    families: [],
  });
  mocks.admin.mockReturnValue({
    from(name: string) {
      if (name === 'projects') {
        return { select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { id: PROJECT }, error: null }) }) }) }) };
      }
      if (name === 'document_relationships') return relationshipsTable(existing);
      throw new Error(`unexpected table ${name}`);
    },
  });
}

const link = (extra: Record<string, unknown> = {}) => PATCH(new Request(`http://localhost/api/projects/${PROJECT}/document-precedence`, {
  method: 'PATCH',
  body: JSON.stringify({ action: 'link_relationship', sourceDocumentId: AMENDMENT, targetDocumentId: CONTRACT,
    relationshipType: 'amends', ...extra }),
}), { params: Promise.resolve({ id: PROJECT }) });

const PROPOSAL_ROW = { id: PROPOSAL, project_id: PROJECT, source_document_id: AMENDMENT, target_document_id: CONTRACT,
  relationship_type: 'amends' };

beforeEach(() => {
  inserted = [];
  mocks.actor.mockResolvedValue({ ok: true, actor: { actorId: 'operator-1', organizationId: ORG, displayName: 'O', role: 'admin' } });
  mocks.activity.mockResolvedValue({ ok: true, id: 'event-1' });
  mocks.revalidate.mockResolvedValue(undefined);
  mocks.readProposal.mockResolvedValue(PROPOSAL_ROW);
  mocks.decided.mockResolvedValue(false);
  mocks.recordReview.mockResolvedValue({ status: 'recorded', reviewId: 'review-1' });
});
afterEach(() => vi.clearAllMocks());

describe('relationship proposal confirmation through link_relationship (P3.2)', () => {
  it('the operator creates the relationship; the acceptance cites that row', async () => {
    setup();
    const response = await link({ forgewingProposalId: PROPOSAL, reason: 'Confirmed against the signed amendment' });
    expect(response.status).toBe(200);
    expect(inserted).toEqual([expect.objectContaining({ source_document_id: AMENDMENT, target_document_id: CONTRACT,
      relationship_type: 'amends', created_by: 'operator-1', organization_id: ORG })]);
    expect(mocks.recordReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      organizationId: ORG, proposalId: PROPOSAL, disposition: 'accepted', relationshipId: 'rel-new', reviewerActorId: 'operator-1' }));
    expect((await response.json()).proposalReview).toBe('recorded');
  });

  it('records already_linked against the existing edge and creates nothing', async () => {
    setup([{ id: 'rel-existing', source_document_id: AMENDMENT, target_document_id: CONTRACT, relationship_type: 'amends' }]);
    expect((await link({ forgewingProposalId: PROPOSAL })).status).toBe(200);
    expect(inserted).toEqual([]);
    expect(mocks.recordReview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      disposition: 'already_linked', relationshipId: 'rel-existing' }));
  });

  it('refuses a link that does not match the proposal, an unknown proposal, or a decided one, before any write', async () => {
    setup();
    mocks.readProposal.mockResolvedValueOnce({ ...PROPOSAL_ROW, target_document_id: 'doc-other' });
    expect((await link({ forgewingProposalId: PROPOSAL })).status).toBe(409);
    mocks.readProposal.mockResolvedValueOnce(null);
    expect((await link({ forgewingProposalId: PROPOSAL })).status).toBe(404);
    mocks.decided.mockResolvedValueOnce(true);
    expect((await link({ forgewingProposalId: PROPOSAL })).status).toBe(409);
    expect(inserted).toEqual([]);
    expect(mocks.recordReview).not.toHaveBeenCalled();
  });

  it('keeps the operator link when only the review record fails, and says so', async () => {
    setup();
    mocks.recordReview.mockResolvedValueOnce({ status: 'rejected', reason: 'x' });
    const response = await link({ forgewingProposalId: PROPOSAL });
    expect(response.status).toBe(200);
    expect(inserted).toHaveLength(1);
    expect((await response.json()).proposalReview).toBe('rejected');
  });

  it('an ordinary link touches no proposal', async () => {
    setup();
    expect((await link()).status).toBe(200);
    expect(mocks.readProposal).not.toHaveBeenCalled();
    expect(mocks.recordReview).not.toHaveBeenCalled();
  });
});
