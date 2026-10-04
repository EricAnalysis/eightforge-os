import type { SupabaseClient } from '@supabase/supabase-js';

import { readRecoveryOperationalConfig } from '@/lib/extraction/recovery/recoveryOperationalPolicy';

/**
 * Per-organization Forgewing entitlement: EightForge Core vs Core + Forgewing.
 *
 * Both tiers share one canonical truth model. This decision withholds only
 * Forgewing (AI) work: shadow tasks, recovery generation and provider calls.
 * Deterministic extraction, canonical truth, the Validator and operator review
 * never consult it. Applying a recovery a human already confirmed is reviewed
 * truth, so it never depends on this decision either.
 *
 * Fail-closed. Forgewing runs only when the deployment kill switch
 * (FORGEWING_SHADOW_ENABLED) is on AND the organization's latest entitlement
 * event enables it. The kill switch is read first, so a deployment with
 * Forgewing off never queries the database here and behaves exactly as before.
 * Any lookup failure resolves to "not entitled".
 */

export const FORGEWING_ENTITLEMENT_EVENTS_TABLE = 'organization_forgewing_entitlement_events';

export type OrganizationForgewingEntitlementDecision =
  | Readonly<{ entitled: true; reason: 'entitled'; eventId: string }>
  | Readonly<{
      entitled: false;
      reason: 'kill_switch_off' | 'no_entitlement' | 'revoked' | 'lookup_failed';
    }>;

export type OrganizationForgewingEntitlementEvent = Readonly<{
  id: string;
  enabled: boolean;
}>;

export type OrganizationForgewingEntitlementResolver = (
  admin: SupabaseClient,
  organizationId: string,
) => Promise<OrganizationForgewingEntitlementDecision>;

/** Pure decision over the kill switch and the organization's latest event. */
export function decideForgewingEntitlement(
  killSwitchOn: boolean,
  latestEvent: OrganizationForgewingEntitlementEvent | null,
): OrganizationForgewingEntitlementDecision {
  if (!killSwitchOn) return { entitled: false, reason: 'kill_switch_off' };
  if (!latestEvent) return { entitled: false, reason: 'no_entitlement' };
  if (!latestEvent.enabled) return { entitled: false, reason: 'revoked' };
  return { entitled: true, reason: 'entitled', eventId: latestEvent.id };
}

export function isForgewingKillSwitchOn(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return readRecoveryOperationalConfig(env, { context: 'organization_entitlement' }).masterEnabled;
}

export const resolveForgewingEntitlement: OrganizationForgewingEntitlementResolver = async (
  admin,
  organizationId,
) => {
  if (!isForgewingKillSwitchOn()) return decideForgewingEntitlement(false, null);
  if (typeof organizationId !== 'string' || organizationId.trim().length === 0) {
    return { entitled: false, reason: 'lookup_failed' };
  }
  try {
    const { data, error } = await admin
      .from(FORGEWING_ENTITLEMENT_EVENTS_TABLE)
      .select('id, enabled')
      .eq('organization_id', organizationId)
      .order('recorded_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(1);
    if (error || !Array.isArray(data)) return { entitled: false, reason: 'lookup_failed' };
    const latest = data[0] as Partial<OrganizationForgewingEntitlementEvent> | undefined;
    if (latest && (typeof latest.id !== 'string' || typeof latest.enabled !== 'boolean')) {
      return { entitled: false, reason: 'lookup_failed' };
    }
    return decideForgewingEntitlement(true, (latest as OrganizationForgewingEntitlementEvent | undefined) ?? null);
  } catch {
    return { entitled: false, reason: 'lookup_failed' };
  }
};
