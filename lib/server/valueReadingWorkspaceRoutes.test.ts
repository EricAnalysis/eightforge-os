import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: vi.fn() }));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));
vi.mock('@/lib/server/resolutionQueueRead', () => ({ readResolutionQueue: vi.fn() }));
vi.mock('@/lib/server/valueReadingEngine', () => ({ runValueReading: vi.fn() }));
vi.mock('@/lib/server/valueReadingProposals', () => ({ recordValueReadingReview: vi.fn() }));

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { readResolutionQueue } from '@/lib/server/resolutionQueueRead';
import { runValueReading } from '@/lib/server/valueReadingEngine';
import { recordValueReadingReview } from '@/lib/server/valueReadingProposals';
import type { ResolutionAction, ResolutionCase, ResolutionQueue } from '@/lib/resolution/resolutionCases';
import { POST as requestReading } from '@/app/api/projects/[id]/resolution-cases/value-reading/route';
import { POST as reviewReading } from '@/app/api/projects/[id]/resolution-cases/value-reading-review/route';

const CASE = 'unreadable:doc:anchor';
const PROPOSAL = `forgewing-proposal-value-reading-${'a'.repeat(64)}`;
const DIGEST = 'a'.repeat(64);
const admin = { rpc: vi.fn() };
const params = { params: Promise.resolve({ id: 'project' }) };
const askAction: ResolutionAction = { kind: 'request_value_reading', method: 'POST', endpoint: '/api/projects/project/resolution-cases/value-reading' };
const reviewAction: ResolutionAction = { kind: 'review_value_reading', method: 'POST', endpoint: '/api/projects/project/resolution-cases/value-reading-review',
  proposalId: PROPOSAL, proposalDigestSha256: DIGEST, dispositions: ['rejected', 'deferred'] };

function request(body: unknown) {
  return new NextRequest('http://localhost/api/projects/project/resolution-cases/value-reading', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' }, body: JSON.stringify(body) });
}
function queue(actions: readonly ResolutionAction[] = [askAction, reviewAction]) {
  return { modelVersion: 'resolution_case_v1', projectId: 'project', cases: [{ caseId: CASE, actions } as ResolutionCase],
    groups: [], countsByTier: { blocks_approval: 0, missing_authoritative_value: 0,
      missing_document_or_link: 0, affects_pricing: 0, structural: 0, informational: 0 },
    forgewingSuggestionsIncluded: true } as ResolutionQueue;
}
const reviewBody = () => ({ caseId: CASE, proposalId: PROPOSAL, proposalDigestSha256: DIGEST,
  disposition: 'rejected', rationale: 'Source is not readable', idempotencyKey: 'review1' });

describe('B4.4 request and review routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getActorContext).mockResolvedValue({ ok: true, actor: { actorId: 'actor', organizationId: 'org', role: null, email: null, displayName: null } });
    vi.mocked(getSupabaseAdmin).mockReturnValue(admin as never);
    vi.mocked(readResolutionQueue).mockResolvedValue({ status: 'ok', queue: queue() });
    vi.mocked(runValueReading).mockResolvedValue({ status: 'completed', outcome: { code: 'activation_not_allowed', reason: 'activation_disabled', providerInvoked: false },
      proposal: null, replayed: false, outcomeRecorded: true });
    vi.mocked(recordValueReadingReview).mockResolvedValue({ status: 'recorded', reviewId: 'review', reviewVersion: 1, inserted: true });
  });

  it.each([requestReading, reviewReading])('authenticates before any server read or engine/review call', async (route) => {
    vi.mocked(getActorContext).mockResolvedValue({ ok: false, status: 401, error: 'Unauthorized' });
    expect((await route(request({}), params)).status).toBe(401);
    expect(readResolutionQueue).not.toHaveBeenCalled();
    expect(runValueReading).not.toHaveBeenCalled();
    expect(recordValueReadingReview).not.toHaveBeenCalled();
  });

  it('passes only server-derived actor/project/case identity to the engine without wiring a provider', async () => {
    const response = await requestReading(request({ caseId: CASE, requestKey: 'click1' }), params);
    expect(response.status).toBe(200);
    expect(readResolutionQueue).toHaveBeenCalledWith({ organizationId: 'org', projectId: 'project' });
    expect(runValueReading).toHaveBeenCalledWith(admin, { organizationId: 'org', projectId: 'project', caseId: CASE,
      requestedBy: 'actor', requestKey: 'click1', includeTextExcerpts: false });
    expect(await response.json()).toMatchObject({ outcome: { code: 'activation_not_allowed' }, proposal: null });
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('rejects invented request actions, including Core or stale cases', async () => {
    vi.mocked(readResolutionQueue).mockResolvedValue({ status: 'ok', queue: queue([]) });
    expect((await requestReading(request({ caseId: CASE, requestKey: 'click1' }), params)).status).toBe(409);
    expect(runValueReading).not.toHaveBeenCalled();
  });

  it('rejects client-provided evidence instead of passing it to the engine', async () => {
    expect((await requestReading(request({ caseId: CASE, requestKey: 'click1', sourceRegion: { boxes: [] } }), params)).status).toBe(400);
    expect(runValueReading).not.toHaveBeenCalled();
  });

  it('returns a refreshable 409 for an evidence or request-key collision from the engine', async () => {
    vi.mocked(runValueReading).mockResolvedValue({ status: 'not_resolved', reason: 'request_key_collision' });
    const response = await requestReading(request({ caseId: CASE, requestKey: 'click1' }), params);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'request_key_collision' });
  });

  it('does not report success if durable outcome persistence failed', async () => {
    vi.mocked(runValueReading).mockResolvedValue({ status: 'completed', outcome: { code: 'provider_failed', reason: 'provider_timeout', providerInvoked: true },
      proposal: null, replayed: false, outcomeRecorded: false });
    expect((await requestReading(request({ caseId: CASE, requestKey: 'click1' }), params)).status).toBe(503);
  });

  it.each(['rejected', 'deferred'])('records %s with the exact re-derived proposal pin and no human assertion', async (disposition) => {
    const response = await reviewReading(request({ ...reviewBody(), disposition }), params);
    expect(response.status).toBe(201);
    expect(recordValueReadingReview).toHaveBeenCalledWith(admin, { organizationId: 'org', reviewerActorId: 'actor', proposalId: PROPOSAL,
      proposalDigestSha256: DIGEST, disposition, rationale: 'Source is not readable', idempotencyKey: 'review1' });
    expect(runValueReading).not.toHaveBeenCalled();
    expect(admin.rpc).not.toHaveBeenCalled();
  });

  it('refuses stale client proposal pins when the re-derived suggestion changed', async () => {
    vi.mocked(readResolutionQueue).mockResolvedValue({ status: 'ok', queue: queue([{ ...reviewAction, proposalId: `forgewing-proposal-value-reading-${'b'.repeat(64)}` }]) });
    expect((await reviewReading(request(reviewBody()), params)).status).toBe(409);
    expect(recordValueReadingReview).not.toHaveBeenCalled();
  });

  it('offers no generic approve/accept mutation', async () => {
    expect((await reviewReading(request({ ...reviewBody(), disposition: 'accepted' }), params)).status).toBe(400);
    expect(recordValueReadingReview).not.toHaveBeenCalled();
  });

  it('refuses a review action absent from the re-derived case', async () => {
    vi.mocked(readResolutionQueue).mockResolvedValue({ status: 'ok', queue: queue([askAction]) });
    expect((await reviewReading(request(reviewBody()), params)).status).toBe(409);
    expect(recordValueReadingReview).not.toHaveBeenCalled();
  });
});
