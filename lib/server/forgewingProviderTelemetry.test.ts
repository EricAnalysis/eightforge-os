import { describe, expect, it, vi } from 'vitest';

import {
  FORGEWING_PROVIDER_CALL_OBSERVATIONS_TABLE,
  forgewingProviderCallObservationRow,
  providerFailureOutcome,
  recordForgewingProviderCallObservation,
} from '@/lib/server/forgewingProviderTelemetry';

const BASE = {
  workflow: 'project_ask' as const,
  organizationId: 'org-1',
  model: 'claude-sonnet-4-6',
  outcome: 'succeeded' as const,
  latencyMs: 1234.6,
};

describe('Forgewing provider telemetry (S7)', () => {
  it('writes identity and measurements only, every field bounded', () => {
    const row = forgewingProviderCallObservationRow({
      ...BASE,
      reservationId: 'r-1',
      requestDigestSha256: 'a'.repeat(64),
      returnedModel: 'claude-sonnet-4-6-20260101',
      providerRequestId: 'req_123',
      stopReason: 'end_turn',
      inputTokens: 1200,
      outputTokens: 300,
    });
    expect(row).toEqual({
      workflow: 'project_ask', organization_id: 'org-1', reservation_id: 'r-1',
      request_digest_sha256: 'a'.repeat(64), model: 'claude-sonnet-4-6',
      returned_model: 'claude-sonnet-4-6-20260101', provider_request_id: 'req_123',
      outcome: 'succeeded', stop_reason: 'end_turn', input_tokens: 1200, output_tokens: 300, latency_ms: 1235,
    });
    // Nothing that could carry content.
    expect(Object.keys(row).some((key) => /prompt|answer|question|excerpt|text|content|rationale/.test(key))).toBe(false);
  });

  it('drops malformed measurements instead of storing them', () => {
    expect(forgewingProviderCallObservationRow({
      ...BASE, requestDigestSha256: 'not-a-digest', inputTokens: -1, outputTokens: 1.5,
      stopReason: '   ', latencyMs: Number.NaN, providerRequestId: 'x'.repeat(500),
    })).toMatchObject({
      request_digest_sha256: null, input_tokens: null, output_tokens: null, stop_reason: null,
      latency_ms: 0, provider_request_id: 'x'.repeat(200),
    });
  });

  it('is best effort: a failed or throwing insert never throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const insert = vi.fn(async () => ({ error: { code: '42501' } }));
    const from = vi.fn(() => ({ insert }));
    await expect(recordForgewingProviderCallObservation({ from } as never, BASE)).resolves.toBe(false);
    expect(from).toHaveBeenCalledWith(FORGEWING_PROVIDER_CALL_OBSERVATIONS_TABLE);
    await expect(recordForgewingProviderCallObservation({ from: () => { throw new Error('down'); } } as never, BASE))
      .resolves.toBe(false);
    const ok = vi.fn(async () => ({ error: null }));
    await expect(recordForgewingProviderCallObservation({ from: () => ({ insert: ok }) } as never, BASE))
      .resolves.toBe(true);
    warn.mockRestore();
  });

  it('maps provider failure reasons to outcomes', () => {
    expect(providerFailureOutcome('provider_timeout')).toBe('provider_timeout');
    expect(providerFailureOutcome('provider_truncated_output')).toBe('output_truncated');
    expect(providerFailureOutcome('provider_error')).toBe('provider_failed');
    expect(providerFailureOutcome(undefined)).toBe('provider_failed');
  });
});
