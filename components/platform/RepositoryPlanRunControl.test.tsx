import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import RepositoryPlanRunControl, { pollRepositoryPlanRun, readRepositoryPlanRun, requestRepositoryPlanRun } from './RepositoryPlanRunControl';

const request = {
  assessmentId: '22222222-2222-4222-8222-222222222222', assessmentVersion: 3,
  reviewId: '33333333-3333-4333-8333-333333333333', reviewVersion: 4,
  classification: 'RULE' as const,
};
const jobId = '44444444-4444-4444-8444-444444444444';
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('repository Plan run operator control', () => {
  it('creates one classification-scoped run with exact identity and bearer authorization', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({
      ok: true, job: { jobId, status: 'pending', classification: 'RULE' },
    }, 201));
    await expect(requestRepositoryPlanRun(request, 'token', new AbortController().signal, fetcher))
      .resolves.toEqual({ ok: true, jobId });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith('/api/internal/repository-plan-runs', expect.objectContaining({
      method: 'POST', headers: { authorization: 'Bearer token', 'content-type': 'application/json' },
      body: JSON.stringify(request), cache: 'no-store',
    }));
  });

  it('fails closed on HTTP/envelope disagreement, malformed data, or classification mismatch', async () => {
    for (const [body, status] of [
      [{ ok: true, job: { jobId, status: 'pending', classification: 'VERIFY' } }, 201],
      [{ ok: true, job: { jobId, status: 'claimed', classification: 'RULE' } }, 201],
      [{ ok: true, job: { jobId, status: 'pending', classification: 'RULE', source: 'private' } }, 201],
      [{ ok: true, job: { jobId, status: 'pending', classification: 'RULE' } }, 200],
    ] as const) {
      await expect(requestRepositoryPlanRun(request, 'token', new AbortController().signal,
        vi.fn<typeof fetch>().mockResolvedValue(response(body, status)))).resolves.toEqual({ ok: false });
    }
  });

  it.each([
    [{ jobId, status: 'pending', classification: 'RULE' }, { kind: 'queued', jobId }],
    [{ jobId, status: 'claimed', classification: 'RULE' }, { kind: 'analyzing', jobId }],
    [{ jobId, status: 'failed', classification: 'RULE', failureCode: 'provider_disabled' }, { kind: 'unavailable', jobId }],
    [{ jobId, status: 'failed', classification: 'RULE', failureCode: 'worker_failed' }, { kind: 'failed', jobId }],
  ])('maps a safe job response to operator state', async (job, expected) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, job }));
    await expect(readRepositoryPlanRun(jobId, 'token', new AbortController().signal, fetcher, 'RULE'))
      .resolves.toEqual(expected);
    expect(fetcher).toHaveBeenCalledWith(`/api/internal/repository-plan-runs/${jobId}`,
      expect.objectContaining({ method: 'GET', headers: { authorization: 'Bearer token' }, cache: 'no-store' }));
  });

  it('selects only the exact persisted Plan V2 result', async () => {
    const result = { planV2RunId: '55555555-5555-4555-8555-555555555555',
      planV2DigestSha256: 'a'.repeat(64), repositoryCommitSha: 'b'.repeat(40), providerCallCount: 1 };
    await expect(readRepositoryPlanRun(jobId, 'token', new AbortController().signal,
      vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true,
        job: { jobId, status: 'succeeded', classification: 'RULE', result } })), 'RULE'))
      .resolves.toEqual({ kind: 'complete', jobId, planV2RunId: result.planV2RunId,
        planV2DigestSha256: result.planV2DigestSha256 });
  });

  it('polls queued and claimed states, then stops permanently at success', async () => {
    const result = { planV2RunId: '55555555-5555-4555-8555-555555555555',
      planV2DigestSha256: 'a'.repeat(64), repositoryCommitSha: 'b'.repeat(40), providerCallCount: 1 };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ok: true, job: { jobId, status: 'pending', classification: 'RULE' } }))
      .mockResolvedValueOnce(response({ ok: true, job: { jobId, status: 'claimed', classification: 'RULE' } }))
      .mockResolvedValueOnce(response({ ok: true, job: { jobId, status: 'succeeded', classification: 'RULE', result } }));
    const states: string[] = [];
    const wait = vi.fn().mockResolvedValue(undefined);
    await pollRepositoryPlanRun(jobId, 'token', new AbortController().signal, 'RULE',
      (state) => states.push(state.kind), { fetcher, wait });
    expect(states).toEqual(['queued', 'analyzing', 'complete']);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(3);
  });

  it('stops at failure and does not retry or create another job', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true,
      job: { jobId, status: 'failed', classification: 'RULE', failureCode: 'provider_timeout' } }));
    const states: string[] = [];
    await pollRepositoryPlanRun(jobId, 'token', new AbortController().signal, 'RULE',
      (state) => states.push(state.kind), { fetcher, wait: vi.fn().mockResolvedValue(undefined) });
    expect(states).toEqual(['failed']);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1]).toMatchObject({ method: 'GET' });
  });

  it('does not read or emit after cancellation', async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>();
    const emit = vi.fn();
    await pollRepositoryPlanRun(jobId, 'token', controller.signal, 'RULE', emit, {
      fetcher,
      wait: async () => { controller.abort(); },
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('fails closed for the wrong job, classification, malformed response, or network failure', async () => {
    const cases = [
      vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, job: { jobId: '55555555-5555-4555-8555-555555555555', status: 'pending', classification: 'RULE' } })),
      vi.fn<typeof fetch>().mockResolvedValue(response({ ok: true, job: { jobId, status: 'pending', classification: 'VERIFY' } })),
      vi.fn<typeof fetch>().mockResolvedValue(new Response('{')),
      vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
    ];
    for (const fetcher of cases) {
      await expect(readRepositoryPlanRun(jobId, 'token', new AbortController().signal, fetcher, 'RULE'))
        .resolves.toEqual({ kind: 'failed', jobId });
    }
  });

  it('renders explicit human authority and no automatic review or Linear controls', () => {
    const html = renderToStaticMarkup(<RepositoryPlanRunControl request={request} accessToken="token" />);
    for (const text of ['Ready', 'Run Forgewing analysis', 'Forgewing suggests. Human decides.',
      'non-authoritative', 'never approves, executes, or projects to Linear']) expect(html).toContain(text);
    expect(html).not.toContain('Record engineering review');
    expect(html).not.toContain('Project to Linear');
  });
});
