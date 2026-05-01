import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { executeProjectDecisionResolution } from './projectDecisionResolution';

describe('projectDecisionResolution', () => {
  it('marks a decision resolved through the decision status route', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'resolved' }),
    }));

    const result = await executeProjectDecisionResolution({
      decisionId: 'decision-1',
      action: 'mark_resolved',
      accessToken: 'token-1',
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    assert.equal(path, '/api/decisions/decision-1/status');
    assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init.body)), { status: 'resolved' });
    assert.equal(result.kind, 'status');
    assert.equal(result.optimisticStatus, 'resolved');
  });

  it('requests correction through decision feedback with an operator-review disposition', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
    }));

    const result = await executeProjectDecisionResolution({
      decisionId: 'decision-2',
      action: 'request_correction',
      accessToken: 'token-2',
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    assert.equal(path, '/api/decisions/decision-2/feedback');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(String(init.body)), {
      is_correct: false,
      review_error_type: 'edge_case',
      feedback_type: 'needs_review',
      disposition: 'escalate',
    });
    assert.equal(result.kind, 'feedback');
    assert.equal(result.optimisticStatus, 'in_review');
  });
});
