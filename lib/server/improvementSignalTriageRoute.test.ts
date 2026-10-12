import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const actorContext = vi.hoisted(() => vi.fn());
const record = vi.hoisted(() => vi.fn());
const queue = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: actorContext }));
vi.mock('@/lib/server/improvementSignalTriage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/server/improvementSignalTriage')>()),
  recordImprovementSignalTriage: record,
  readImprovementSignalTriageQueue: queue,
}));
vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { POST } from '@/app/api/internal/improvement-signals/triage/route';
import { GET } from '@/app/api/internal/improvement-signals/triage-queue/route';

/** B8.3c routes: platform reviewers only; identity from the session; strict body. */

const PLATFORM = 'platform.reviewer@example.test';
const body = {
  submissionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1', expectedTriageVersion: 0, disposition: 'reject',
  capabilityScope: null, semanticsDefectClass: null, rationale: 'Not a defect.',
};
const request = (payload?: unknown) => new Request('http://test/x', {
  method: payload === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
  ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
});
const actor = (email: string, role = 'admin') => ({ ok: true, actor: {
  actorId: '22222222-2222-4222-8222-222222222222', organizationId: 'org-1', displayName: null, role, email } });

describe('improvement signal triage routes (B8.3c)', () => {
  beforeEach(() => { actorContext.mockReset(); record.mockReset(); queue.mockReset();
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', PLATFORM); vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_ROLES', ''); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('refuses tenant administrators who are not platform reviewers', async () => {
    actorContext.mockResolvedValue(actor('tenant.owner@example.test', 'owner'));
    expect((await GET(request())).status).toBe(403);
    expect((await POST(request(body))).status).toBe(403);
    expect(queue).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('records with the session identity and rejects a body that names a reviewer', async () => {
    actorContext.mockResolvedValue(actor(PLATFORM));
    expect((await POST(request({ ...body, reviewerActorId: 'someone-else' }))).status).toBe(400);
    expect(record).not.toHaveBeenCalled();
    record.mockResolvedValue({ status: 'triage_recorded', triageId: 't1', triageVersion: 1, disposition: 'reject' });
    expect((await POST(request(body))).status).toBe(201);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ submissionId: body.submissionId, disposition: 'reject' }),
      { actorId: '22222222-2222-4222-8222-222222222222', email: PLATFORM, role: 'admin' });
    record.mockResolvedValue({ status: 'version_conflict', currentTriageVersion: 2 });
    expect((await POST(request(body))).status).toBe(409);
  });

  it('serves the queue to platform reviewers', async () => {
    actorContext.mockResolvedValue(actor(PLATFORM));
    queue.mockResolvedValue({ status: 'ok', rows: [] });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rows: [] });
  });
});
