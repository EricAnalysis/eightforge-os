import assert from 'node:assert/strict';
import { describe, expect, it, vi } from 'vitest';
import { executeProjectExecutionResolution } from './projectExecutionResolution';

describe('projectExecutionResolution', () => {
  it('routes approve through the execution item outcome endpoint', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'resolved', outcome: 'confirmed' }),
    }));

    const result = await executeProjectExecutionResolution({
      executionItemId: 'execution-1',
      action: 'approve',
      accessToken: 'token-1',
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    assert.equal(path, '/api/execution-items/execution-1/outcome');
    assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init.body)), {
      action: 'approve',
      reason: null,
    });
    assert.equal(result.successMessage, 'Execution item approved.');
  });

  it('passes override reasons through to the execution item outcome endpoint', async () => {
    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 'resolved', outcome: 'overridden' }),
    }));

    const result = await executeProjectExecutionResolution({
      executionItemId: 'execution-2',
      action: 'override',
      reason: 'Approved as an operator exception.',
      accessToken: 'token-2',
      fetcher,
    });

    expect(fetcher).toHaveBeenCalledTimes(1);
    const [path, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    assert.equal(path, '/api/execution-items/execution-2/outcome');
    assert.equal(init.method, 'PATCH');
    assert.deepEqual(JSON.parse(String(init.body)), {
      action: 'override',
      reason: 'Approved as an operator exception.',
    });
    assert.equal(result.successMessage, 'Execution item overridden.');
  });
});
