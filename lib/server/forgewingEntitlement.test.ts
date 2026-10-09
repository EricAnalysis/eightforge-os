import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FORGEWING_ENTITLEMENT_EVENTS_TABLE,
  decideForgewingEntitlement,
  isForgewingKillSwitchOn,
  resolveForgewingEntitlement,
} from '@/lib/server/forgewingEntitlement';

type QueryResult = { data: unknown; error: { message?: string } | null };

function fakeAdmin(result: QueryResult | (() => never)) {
  const calls: { table?: string; columns?: string; eq?: [string, string]; orders: string[]; limit?: number } = {
    orders: [],
  };
  const builder = {
    select(columns: string) { calls.columns = columns; return builder; },
    eq(column: string, value: string) { calls.eq = [column, value]; return builder; },
    order(column: string) { calls.orders.push(column); return builder; },
    limit(count: number) {
      calls.limit = count;
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };
  const from = vi.fn((table: string) => { calls.table = table; return builder; });
  return { admin: { from } as never, from, calls };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('decideForgewingEntitlement', () => {
  it('is never entitled while the deployment kill switch is off, whatever the organization holds', () => {
    expect(decideForgewingEntitlement(false, { id: 'e1', enabled: true }))
      .toEqual({ entitled: false, reason: 'kill_switch_off' });
  });

  it('treats an organization with no event as not entitled', () => {
    expect(decideForgewingEntitlement(true, null)).toEqual({ entitled: false, reason: 'no_entitlement' });
  });

  it('honours a revocation as the latest event', () => {
    expect(decideForgewingEntitlement(true, { id: 'e2', enabled: false }))
      .toEqual({ entitled: false, reason: 'revoked' });
  });

  it('entitles only on kill switch AND an enabling latest event, citing that event', () => {
    expect(decideForgewingEntitlement(true, { id: 'e3', enabled: true }))
      .toEqual({ entitled: true, reason: 'entitled', eventId: 'e3' });
  });
});

describe('isForgewingKillSwitchOn', () => {
  it('reads the strict master gate', () => {
    expect(isForgewingKillSwitchOn({ FORGEWING_SHADOW_ENABLED: '1' })).toBe(true);
    for (const value of [undefined, '', '0', 'true', 'yes', 'on']) {
      expect(isForgewingKillSwitchOn({ FORGEWING_SHADOW_ENABLED: value })).toBe(false);
    }
  });
});

describe('resolveForgewingEntitlement', () => {
  it('never queries the database while the kill switch is off', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    const { admin, from } = fakeAdmin({ data: [{ id: 'e1', enabled: true }], error: null });
    await expect(resolveForgewingEntitlement(admin, 'org-1'))
      .resolves.toEqual({ entitled: false, reason: 'kill_switch_off' });
    expect(from).not.toHaveBeenCalled();
  });

  it('reads only the latest event for the organization', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const { admin, calls } = fakeAdmin({ data: [{ id: 'e9', enabled: true }], error: null });
    await expect(resolveForgewingEntitlement(admin, 'org-1'))
      .resolves.toEqual({ entitled: true, reason: 'entitled', eventId: 'e9' });
    expect(calls).toEqual({
      table: FORGEWING_ENTITLEMENT_EVENTS_TABLE,
      columns: 'id, enabled',
      eq: ['organization_id', 'org-1'],
      orders: ['recorded_at', 'id'],
      limit: 1,
    });
  });

  it('is not entitled when no event exists or the latest event revokes', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    await expect(resolveForgewingEntitlement(fakeAdmin({ data: [], error: null }).admin, 'org-1'))
      .resolves.toEqual({ entitled: false, reason: 'no_entitlement' });
    await expect(resolveForgewingEntitlement(
      fakeAdmin({ data: [{ id: 'e2', enabled: false }], error: null }).admin, 'org-1',
    )).resolves.toEqual({ entitled: false, reason: 'revoked' });
  });

  it('fails closed on a query error, a malformed row, a throw, or a missing organization', async () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    const lookupFailed = { entitled: false, reason: 'lookup_failed' };
    await expect(resolveForgewingEntitlement(
      fakeAdmin({ data: null, error: { message: 'boom' } }).admin, 'org-1',
    )).resolves.toEqual(lookupFailed);
    await expect(resolveForgewingEntitlement(
      fakeAdmin({ data: [{ id: 'e1', enabled: 'true' }], error: null }).admin, 'org-1',
    )).resolves.toEqual(lookupFailed);
    await expect(resolveForgewingEntitlement(
      fakeAdmin(() => { throw new Error('network'); }).admin, 'org-1',
    )).resolves.toEqual(lookupFailed);
    const { admin, from } = fakeAdmin({ data: [{ id: 'e1', enabled: true }], error: null });
    await expect(resolveForgewingEntitlement(admin, '  ')).resolves.toEqual(lookupFailed);
    expect(from).not.toHaveBeenCalled();
  });
});
