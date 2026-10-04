import { describe, expect, it, vi } from 'vitest';

import {
  decideForgewingDataPolicy,
  decideValueReadingEligibility,
  readValueReadingDailyCap,
  VALUE_READING_POLICY,
  valueReadingActivation,
  reserveForgewingProviderCall,
  resolveForgewingDataPolicy,
  resolveValueReadingEligibility,
  type AiProviderContentClass,
} from '@/lib/server/forgewingGates';

const ORG = 'org-1';
const entitled = { entitled: true as const, reason: 'entitled' as const, eventId: 'ent-1' };
const approved = { approved: true as const, eventIds: ['dp-1'] };

function dataPolicyClient(rowsByClass: Partial<Record<AiProviderContentClass, unknown[]>>, error: unknown = null) {
  const calls: Record<string, unknown>[] = [];
  const client = {
    from: vi.fn(() => {
      const filters: Record<string, unknown> = {};
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters[column] = value; return query; },
        order: () => query,
        limit: async () => {
          calls.push({ ...filters });
          return { data: error ? null : rowsByClass[filters.content_class as AiProviderContentClass] ?? [], error };
        },
      };
      return query;
    }),
  };
  return { client: client as never, calls };
}

describe('Forgewing data policy (B4.1)', () => {
  it('denies by default, per class, and honours the latest event', () => {
    expect(decideForgewingDataPolicy(new Map(), ['page_region_images']))
      .toEqual({ approved: false, reason: 'not_approved', contentClass: 'page_region_images' });
    expect(decideForgewingDataPolicy(new Map([['page_region_images', { id: 'e', approved: false }]]), ['page_region_images']))
      .toEqual({ approved: false, reason: 'revoked', contentClass: 'page_region_images' });
    // Approval of one class never implies another.
    expect(decideForgewingDataPolicy(new Map([['page_region_images', { id: 'e1', approved: true }]]),
      ['page_region_images', 'text_excerpts'])).toEqual({ approved: false, reason: 'not_approved', contentClass: 'text_excerpts' });
    expect(decideForgewingDataPolicy(new Map([
      ['page_region_images', { id: 'e1', approved: true }], ['text_excerpts', { id: 'e2', approved: true }],
    ]), ['page_region_images', 'text_excerpts'])).toEqual({ approved: true, eventIds: ['e1', 'e2'] });
    // Asking to send nothing is not an approval to send something.
    expect(decideForgewingDataPolicy(new Map(), [])).toMatchObject({ approved: false });
  });

  it('reads the latest event for exactly this organization, provider and class', async () => {
    const { client, calls } = dataPolicyClient({ page_region_images: [{ id: 'e1', approved: true }] });
    await expect(resolveForgewingDataPolicy(client, { organizationId: ORG, provider: 'anthropic',
      contentClasses: ['page_region_images'] })).resolves.toEqual({ approved: true, eventIds: ['e1'] });
    expect(calls).toEqual([{ organization_id: ORG, provider: 'anthropic', content_class: 'page_region_images' }]);
  });

  it('fails closed on lookup errors, malformed rows and unknown classes', async () => {
    await expect(resolveForgewingDataPolicy(dataPolicyClient({}, { message: 'x' }).client,
      { organizationId: ORG, provider: 'anthropic', contentClasses: ['text_excerpts'] }))
      .resolves.toMatchObject({ approved: false, reason: 'lookup_failed' });
    await expect(resolveForgewingDataPolicy(dataPolicyClient({ text_excerpts: [{ id: 'e', approved: 'yes' }] }).client,
      { organizationId: ORG, provider: 'anthropic', contentClasses: ['text_excerpts'] }))
      .resolves.toMatchObject({ approved: false, reason: 'lookup_failed' });
    const { client, calls } = dataPolicyClient({});
    await expect(resolveForgewingDataPolicy(client,
      { organizationId: ORG, provider: 'anthropic', contentClasses: ['whole_documents' as AiProviderContentClass] }))
      .resolves.toMatchObject({ approved: false, reason: 'lookup_failed' });
    expect(calls).toEqual([]);
  });
});

describe('value reading eligibility (B4.1)', () => {
  const base = { masterEnabled: true, activation: 'controlled' as const, entitlement: entitled, dataPolicy: approved, dailyCap: 10 };

  it('requires every gate, in order', () => {
    expect(decideValueReadingEligibility(base)).toEqual({
      eligible: true, entitlementEventId: 'ent-1', dataPolicyEventIds: ['dp-1'], dailyCap: 10,
    });
    expect(decideValueReadingEligibility({ ...base, masterEnabled: false })).toMatchObject({ reason: 'kill_switch_off' });
    expect(decideValueReadingEligibility({ ...base, activation: 'disabled' })).toMatchObject({ reason: 'activation_disabled' });
    expect(decideValueReadingEligibility({ ...base, entitlement: { entitled: false, reason: 'no_entitlement' } }))
      .toMatchObject({ reason: 'no_entitlement' });
    expect(decideValueReadingEligibility({ ...base, entitlement: { entitled: false, reason: 'revoked' } }))
      .toMatchObject({ reason: 'entitlement_revoked' });
    expect(decideValueReadingEligibility({ ...base,
      dataPolicy: { approved: false, reason: 'not_approved', contentClass: 'page_region_images' } }))
      .toEqual({ eligible: false, reason: 'data_policy_not_approved', contentClass: 'page_region_images' });
    expect(decideValueReadingEligibility({ ...base,
      dataPolicy: { approved: false, reason: 'revoked', contentClass: 'text_excerpts' } }))
      .toMatchObject({ reason: 'data_policy_revoked' });
    expect(decideValueReadingEligibility({ ...base, dailyCap: 0 })).toMatchObject({ reason: 'budget_not_configured' });
    // A commercial entitlement never stands in for data-processing authorization.
    expect(decideValueReadingEligibility({ ...base, dataPolicy: null })).toMatchObject({ eligible: false });
  });

  it('is closed today whatever the environment asks, and looks nothing up', async () => {
    const resolveEntitlement = vi.fn(async () => entitled);
    const resolveDataPolicy = vi.fn(async () => approved);
    for (const env of [
      {},
      { FORGEWING_SHADOW_ENABLED: '1' },
      { FORGEWING_SHADOW_ENABLED: '1', FORGEWING_VALUE_READING_ENABLED: '1', FORGEWING_VALUE_READING_DAILY_CAP: '50' },
    ]) {
      const result = await resolveValueReadingEligibility({} as never,
        { organizationId: ORG, contentClasses: ['page_region_images'] }, { env, resolveEntitlement, resolveDataPolicy });
      expect(result.eligible).toBe(false);
      expect(['kill_switch_off', 'activation_disabled']).toContain(result.eligible ? '' : result.reason);
    }
    expect(resolveEntitlement).not.toHaveBeenCalled();
    expect(resolveDataPolicy).not.toHaveBeenCalled();
  });

  it('keeps the reading unqualified and disabled whatever the environment requests', () => {
    expect(VALUE_READING_POLICY).toEqual({ qualification: 'unqualified', qualificationCeiling: 'disabled', reviewRequired: true });
    expect(valueReadingActivation({ FORGEWING_SHADOW_ENABLED: '1', FORGEWING_VALUE_READING_ENABLED: '1' }))
      .toEqual({ masterEnabled: true, requested: 'enabled', activation: 'disabled' });
    // The sub-gate alone requests nothing.
    expect(valueReadingActivation({ FORGEWING_VALUE_READING_ENABLED: '1' })).toMatchObject({ requested: 'disabled' });
  });

  it('reads the daily cap fail-closed', () => {
    expect(readValueReadingDailyCap({})).toBe(0);
    expect(readValueReadingDailyCap({ FORGEWING_VALUE_READING_DAILY_CAP: '25' })).toBe(25);
    for (const raw of ['-1', '2.5', 'many', '501']) {
      expect(readValueReadingDailyCap({ FORGEWING_VALUE_READING_DAILY_CAP: raw })).toBe(0);
    }
  });
});

describe('durable call budget (B4.1)', () => {
  const rpcReturning = (data: unknown, error: unknown = null) => ({ rpc: vi.fn(async () => ({ data, error })) });

  it('spends a slot through the record function only', async () => {
    const client = rpcReturning([{ reserved: true, reservation_id: 'r-1', used_in_window: 3 }]);
    await expect(reserveForgewingProviderCall(client as never, {
      organizationId: ORG, requestDigestSha256: 'a'.repeat(64), reservedBy: 'user-1', dailyCap: 10,
    })).resolves.toEqual({ status: 'reserved', reservationId: 'r-1', usedInWindow: 3 });
    expect(client.rpc).toHaveBeenCalledWith('reserve_forgewing_provider_call', {
      p_organization_id: ORG, p_recovery_type: 'priced_value_reading', p_request_digest_sha256: 'a'.repeat(64),
      p_reserved_by: 'user-1', p_daily_cap: 10,
    });
  });

  it('reports an exhausted budget and fails closed on anything else', async () => {
    const params = { organizationId: ORG, requestDigestSha256: 'a'.repeat(64), reservedBy: null, dailyCap: 1 };
    await expect(reserveForgewingProviderCall(rpcReturning([{ reserved: false, reservation_id: null, used_in_window: 1 }]) as never, params))
      .resolves.toEqual({ status: 'budget_exhausted', usedInWindow: 1 });
    await expect(reserveForgewingProviderCall(rpcReturning(null, { message: 'x' }) as never, params)).resolves.toEqual({ status: 'failed' });
    await expect(reserveForgewingProviderCall(rpcReturning([{ reserved: true }]) as never, params)).resolves.toEqual({ status: 'failed' });
    await expect(reserveForgewingProviderCall({ rpc: () => { throw new Error('down'); } } as never, params))
      .resolves.toEqual({ status: 'failed' });
  });
});
