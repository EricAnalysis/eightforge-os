import { beforeEach, describe, expect, it, vi } from 'vitest';

const actorContext = vi.hoisted(() => vi.fn());
const submit = vi.hoisted(() => vi.fn());

vi.mock('@/lib/server/getActorContext', () => ({ getActorContext: actorContext }));
vi.mock('@/lib/server/improvementSignalSubmissions', () => ({ submitImprovementSignal: submit }));

import { POST } from '@/app/api/internal/forgewing-friction/submissions/route';

/** B8.3b submission route: org owner/admin only; the body names a signal and nothing else. */

function request(body: unknown) {
  return new Request('http://test/api/internal/forgewing-friction/submissions', {
    method: 'POST', headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }) as never;
}

function actor(role: string) {
  return { ok: true, actor: { actorId: 'actor-1', organizationId: 'org-1', displayName: null, role, email: null } };
}

describe('POST /api/internal/forgewing-friction/submissions (B8.3b)', () => {
  beforeEach(() => { actorContext.mockReset(); submit.mockReset(); });

  it('refuses members who are not organization owners or admins', async () => {
    actorContext.mockResolvedValue(actor('member'));
    const response = await POST(request({ signalId: 'rule_semantics_review:FINANCIAL_NTE_EXCEEDED' }));
    expect(response.status).toBe(403);
    expect(submit).not.toHaveBeenCalled();
  });

  it('accepts exactly { signalId } and submits for the session organization and actor', async () => {
    actorContext.mockResolvedValue(actor('admin'));
    submit.mockResolvedValue({ status: 'submitted', submissionId: 's1', signalId: 'x', payloadDigestSha256: 'a'.repeat(64) });
    for (const body of [{}, { signalId: '' }, { signalId: 'x', payload: { note: 'Acme' } }, { signalId: 'x', organizationId: 'other' }]) {
      expect((await POST(request(body))).status, JSON.stringify(body)).toBe(400);
    }
    expect(submit).not.toHaveBeenCalled();
    const response = await POST(request({ signalId: 'rule_semantics_review:FINANCIAL_NTE_EXCEEDED' }));
    expect(response.status).toBe(201);
    expect(submit).toHaveBeenCalledWith({ organizationId: 'org-1', actorId: 'actor-1',
      signalId: 'rule_semantics_review:FINANCIAL_NTE_EXCEEDED' });
  });

  it('maps outcomes to statuses', async () => {
    actorContext.mockResolvedValue(actor('owner'));
    const cases: Array<[unknown, number]> = [
      [{ status: 'already_submitted', submissionId: 's1', signalId: 'x', payloadDigestSha256: 'a'.repeat(64) }, 200],
      [{ status: 'signal_not_found' }, 404], [{ status: 'not_submittable' }, 422], [{ status: 'not_configured' }, 503],
      [{ status: 'persist_failed', reason: 'denied' }, 500],
    ];
    for (const [result, status] of cases) {
      submit.mockResolvedValueOnce(result);
      expect((await POST(request({ signalId: 'x' }))).status).toBe(status);
    }
  });
});
