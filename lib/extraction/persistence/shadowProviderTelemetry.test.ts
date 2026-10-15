import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  record: vi.fn(async () => true),
  admin: { from: vi.fn() } as unknown,
  behaviour: 'ok' as 'ok' | 'timeout' | 'truncated' | 'error',
}));

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => mocks.admin }));
vi.mock('@/lib/server/forgewingProviderTelemetry', () => ({ recordForgewingProviderCallObservation: mocks.record }));
vi.mock('@/lib/forgewing/runtime/observedProviders', () => ({
  createObservedForgewingProvider: (_task: string, observer: (entry: Record<string, unknown>) => void) => async () => {
    if (mocks.behaviour === 'timeout') throw new Error('provider_timeout');
    if (mocks.behaviour === 'error') throw new Error('boom');
    observer({ requestId: 'req_1', returnedModel: 'claude-sonnet-4-6', stopReason: 'end_turn', inputTokens: 7,
      outputTokens: 3, latencyMs: 900, messageId: 'm', systemPromptSha256: 'x' });
    if (mocks.behaviour === 'truncated') throw new Error('provider_truncated_output');
    return '{"secret":"never recorded"}';
  },
}));

import { reservedShadowProvider, ShadowBudgetRefusal, withShadowProviderTelemetry } from '@/lib/extraction/persistence/complianceShadow';

const REQUEST = { model: 'claude-sonnet-4-6', timeoutMs: 3000, maxOutputTokens: 800, inputJson: '{}' };
const reserve = vi.fn(async () => ({ status: 'reserved' as const, reservationId: 'res-1', usedInWindow: 1 }));
const ENV = { FORGEWING_EXTRACTION_SHADOW_DAILY_CAP: '5', FORGEWING_EXTRACTION_RECOVERY_DAILY_CAP: '3' };
const BUDGETED = { reserve: reserve as never, env: ENV };

afterEach(() => { mocks.record.mockClear(); mocks.behaviour = 'ok'; reserve.mockClear(); });

describe('shadow / recovery provider telemetry', () => {
  it('records one content-free row per provider call and returns the task result unchanged', async () => {
    const result = await withShadowProviderTelemetry('table_continuation', 'org-1', async (provider) => {
      await provider(REQUEST);
      return { status: 'applied' };
    }, BUDGETED);
    expect(result).toEqual({ status: 'applied' });
    expect(mocks.record).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(mocks.admin, expect.objectContaining({
      workflow: 'table_continuation', organizationId: 'org-1', model: 'claude-sonnet-4-6', outcome: 'succeeded',
      reservationId: 'res-1', requestDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      providerRequestId: 'req_1', inputTokens: 7, outputTokens: 3, latencyMs: 900 }));
    expect(JSON.stringify(mocks.record.mock.calls[0])).not.toContain('never recorded');
  });

  it('records nothing when the task never calls the provider (gate closed, nothing to send)', async () => {
    await withShadowProviderTelemetry('region_classification', 'org-1', async () => ({ status: 'skipped' }), BUDGETED);
    expect(mocks.record).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
  });

  it.each([['timeout', 'provider_timeout'], ['truncated', 'output_truncated'], ['error', 'provider_failed']] as const)(
    'maps a %s to %s and lets the task handle the failure as before', async (behaviour, outcome) => {
      mocks.behaviour = behaviour;
      const result = await withShadowProviderTelemetry('recovery_candidate_v2', 'org-1', async (provider) => {
        try { await provider(REQUEST); return 'ok'; } catch { return 'task_handled_failure'; }
      }, BUDGETED);
      expect(result).toBe('task_handled_failure');
      expect(mocks.record).toHaveBeenCalledWith(mocks.admin, expect.objectContaining({ outcome }));
    });

  it('spends one durable slot per provider call, on the task budget, before calling (D2)', async () => {
    await withShadowProviderTelemetry('column_mapping', 'org-1', async (provider) => provider(REQUEST), BUDGETED);
    expect(reserve).toHaveBeenCalledWith(mocks.admin, expect.objectContaining({
      organizationId: 'org-1', workflow: 'extraction_shadow', dailyCap: 5, reservedBy: null,
      requestDigestSha256: expect.stringMatching(/^[0-9a-f]{64}$/u) }));
    await withShadowProviderTelemetry('recovery_candidate_v2', 'org-1', async (provider) => provider(REQUEST), BUDGETED);
    expect(reserve).toHaveBeenLastCalledWith(mocks.admin, expect.objectContaining({ workflow: 'extraction_recovery', dailyCap: 3 }));
  });

  it.each([
    ['budget_exhausted', { status: 'budget_exhausted', usedInWindow: 5 }],
    ['reservation_failed', { status: 'failed' }],
  ] as const)('never calls the provider without a durable reservation (%s)', async (code, reservation) => {
    const provider = vi.fn();
    reserve.mockResolvedValueOnce(reservation as never);
    const result = await withShadowProviderTelemetry('observation_arbitration', 'org-1', async (call) => {
      try { await call(REQUEST); return 'called'; } catch (error) {
        return error instanceof ShadowBudgetRefusal ? error.code : 'other';
      }
    }, { ...BUDGETED, createProvider: (() => provider) as never });
    expect(result).toBe(code);
    expect(provider).not.toHaveBeenCalled();
    expect(mocks.record).not.toHaveBeenCalled();
  });

  it('fails closed without a database client, and the default cap is zero calls', async () => {
    const outcome = await withShadowProviderTelemetry('pricing_interpretation', 'org-1', async (call) => {
      try { await call(REQUEST); return 'called'; } catch (error) { return (error as ShadowBudgetRefusal).code; }
    }, { ...BUDGETED, admin: null });
    expect(outcome).toBe('budget_unavailable');
    await withShadowProviderTelemetry('pricing_interpretation', 'org-1', async (call) => call(REQUEST).catch(() => null),
      { reserve: reserve as never, env: {} });
    expect(reserve).toHaveBeenCalledWith(mocks.admin, expect.objectContaining({ dailyCap: 0 }));
  });

  it('the reserving provider spends a recovery slot, then calls its base request unchanged (V1 path)', async () => {
    const base = vi.fn(async () => 'answer');
    const provider = reservedShadowProvider('extraction_recovery', 'org-1', base as never, BUDGETED);
    expect(await provider(REQUEST as never)).toBe('answer');
    expect(reserve).toHaveBeenCalledWith(mocks.admin, expect.objectContaining({ workflow: 'extraction_recovery', dailyCap: 3, reservedBy: null }));
    expect(base).toHaveBeenCalledWith(REQUEST);
  });

  it('a refused reservation never reaches the base provider and is signalled', async () => {
    const base = vi.fn(async () => 'answer');
    const onRefused = vi.fn();
    reserve.mockResolvedValueOnce({ status: 'budget_exhausted', usedInWindow: 3 } as never);
    const provider = reservedShadowProvider('extraction_recovery', 'org-1', base as never, { ...BUDGETED, onRefused });
    await expect(provider(REQUEST as never)).rejects.toBeInstanceOf(ShadowBudgetRefusal);
    expect(base).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith('budget_exhausted');
    // The observed wrapper signals the same way, so an outcome records no provider call.
    const wrapperRefused = vi.fn();
    reserve.mockResolvedValueOnce({ status: 'failed' } as never);
    await withShadowProviderTelemetry('recovery_candidate_v2', 'org-1', async (call) => call(REQUEST).catch(() => null),
      { ...BUDGETED, onRefused: wrapperRefused });
    expect(wrapperRefused).toHaveBeenCalledWith('reservation_failed');
  });
});
