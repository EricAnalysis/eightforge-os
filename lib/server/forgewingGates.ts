import type { SupabaseClient } from '@supabase/supabase-js';

import {
  minimumRecoveryActivation,
  readRecoveryOperationalConfig,
  type RecoveryActivation,
  type RecoveryQualification,
} from '@/lib/extraction/recovery/recoveryOperationalPolicy';
import {
  resolveForgewingEntitlement,
  type OrganizationForgewingEntitlementResolver,
} from '@/lib/server/forgewingEntitlement';

/**
 * Forgewing B4.1 gates for a value reading: every decision that must say yes
 * before a provider call may be made for an organization. Gates only: this
 * module never calls a provider and never writes a proposal.
 *
 * All fail closed, in this order:
 *  1. the deployment kill switch (FORGEWING_SHADOW_ENABLED);
 *  2. the value-reading policy below (unqualified and disabled until the B4.6
 *     benchmark qualifies it);
 *  3. the organization's commercial entitlement (Core vs Core + Forgewing);
 *  4. the organization's data-processing authorization for every content
 *     class the request would send (default deny: no event, no approval);
 *  5. a positive daily call cap.
 * The durable budget itself is spent at call time by `reserveForgewingProviderCall`.
 *
 * Commercial entitlement and data-processing authorization are separate
 * decisions with separate ledgers, and neither touches canonical truth.
 */

/**
 * Qualification of the value reading. Separate from the deterministic
 * recovery policy: a reading never re-enters extraction; it is a proposal an
 * operator may use through the B3 assertion path. Raising the ceiling is a
 * deliberate, benchmarked decision (B4.6), never an environment setting.
 */
export const VALUE_READING_POLICY: Readonly<{
  qualification: RecoveryQualification;
  qualificationCeiling: RecoveryActivation;
  reviewRequired: true;
}> = Object.freeze({
  qualification: 'unqualified',
  qualificationCeiling: 'disabled',
  reviewRequired: true,
});

/**
 * Every Forgewing workflow that may send content to a provider, each with its
 * own policy, activation switch, daily cap and budget ledger, behind the same
 * gates in the same order (Forgewing generalization, phase 3). One gate
 * module for all AI surfaces: a surface that skips it does not exist.
 */
export const FORGEWING_WORKFLOWS = ['priced_value_reading', 'project_ask', 'case_investigation'] as const;
export type GatedWorkflow = typeof FORGEWING_WORKFLOWS[number];

export type GatedWorkflowPolicy = Readonly<{
  qualification: RecoveryQualification;
  qualificationCeiling: RecoveryActivation;
  /** Environment switch requesting activation beneath the master gate. */
  activationEnv: string;
  /** Environment daily cap (calls per organization per trailing 24 hours). */
  dailyCapEnv: string;
  /** Whether what the provider returns is a proposal a person must review. */
  reviewRequired: boolean;
}>;

export const FORGEWING_WORKFLOW_POLICIES: Readonly<Record<GatedWorkflow, GatedWorkflowPolicy>> = Object.freeze({
  priced_value_reading: Object.freeze({
    ...VALUE_READING_POLICY,
    activationEnv: 'FORGEWING_VALUE_READING_ENABLED',
    dailyCapEnv: 'FORGEWING_VALUE_READING_DAILY_CAP',
  }),
  // Ask answers an operator's question from project truth. It proposes no
  // value and writes nothing, so it needs no value-reading qualification; it
  // still sends customer content, so it passes every data and budget gate.
  project_ask: Object.freeze({
    qualification: 'production_qualified',
    qualificationCeiling: 'enabled',
    activationEnv: 'FORGEWING_PROJECT_ASK_ENABLED',
    dailyCapEnv: 'FORGEWING_PROJECT_ASK_DAILY_CAP',
    reviewRequired: false,
  }),
  // Provider-backed case investigation is wired but unqualified: deterministic
  // investigation runs for every case without a provider; a model's reading of
  // a case waits for a benchmark the way value reading did (B4.6).
  case_investigation: Object.freeze({
    qualification: 'unqualified',
    qualificationCeiling: 'disabled',
    activationEnv: 'FORGEWING_CASE_INVESTIGATION_ENABLED',
    dailyCapEnv: 'FORGEWING_CASE_INVESTIGATION_DAILY_CAP',
    reviewRequired: true,
  }),
});

/** Requested by the workflow's switch beneath the master gate; capped by its policy ceiling. */
export function forgewingWorkflowActivation(
  workflow: GatedWorkflow,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<{ masterEnabled: boolean; requested: RecoveryActivation; activation: RecoveryActivation }> {
  const policy = FORGEWING_WORKFLOW_POLICIES[workflow];
  const masterEnabled = readRecoveryOperationalConfig(env, { context: workflow }).masterEnabled;
  const requested: RecoveryActivation = masterEnabled && env[policy.activationEnv] === '1' ? 'enabled' : 'disabled';
  return { masterEnabled, requested, activation: minimumRecoveryActivation(policy.qualificationCeiling, requested) };
}

/** Requested by FORGEWING_VALUE_READING_ENABLED=1 beneath the master gate; capped by the policy ceiling. */
export function valueReadingActivation(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<{ masterEnabled: boolean; requested: RecoveryActivation; activation: RecoveryActivation }> {
  return forgewingWorkflowActivation('priced_value_reading', env);
}

export const FORGEWING_DATA_POLICY_EVENTS_TABLE = 'organization_forgewing_data_policy_events';
export const RESERVE_FORGEWING_PROVIDER_CALL_RPC = 'reserve_forgewing_provider_call';

export const FORGEWING_PROVIDERS = ['anthropic'] as const;
export type AiProviderName = typeof FORGEWING_PROVIDERS[number];

/** What a request would send to the provider. Each class is authorized separately. */
export const FORGEWING_CONTENT_CLASSES = ['text_excerpts', 'page_region_images'] as const;
export type AiProviderContentClass = typeof FORGEWING_CONTENT_CLASSES[number];

export type AiDataPolicyEvent = Readonly<{ id: string; approved: boolean }>;

export type AiDataPolicyDecision =
  | Readonly<{ approved: true; eventIds: readonly string[] }>
  | Readonly<{
      approved: false;
      reason: 'not_approved' | 'revoked' | 'lookup_failed';
      contentClass: AiProviderContentClass | null;
    }>;

/** Pure: every requested class must have a latest event that approves it. */
export function decideForgewingDataPolicy(
  latestByClass: ReadonlyMap<AiProviderContentClass, AiDataPolicyEvent | null>,
  contentClasses: readonly AiProviderContentClass[],
): AiDataPolicyDecision {
  if (contentClasses.length === 0) return { approved: false, reason: 'not_approved', contentClass: null };
  const eventIds: string[] = [];
  for (const contentClass of contentClasses) {
    const latest = latestByClass.get(contentClass) ?? null;
    if (!latest) return { approved: false, reason: 'not_approved', contentClass };
    if (!latest.approved) return { approved: false, reason: 'revoked', contentClass };
    eventIds.push(latest.id);
  }
  return { approved: true, eventIds };
}

export async function resolveForgewingDataPolicy(
  admin: SupabaseClient,
  params: Readonly<{
    organizationId: string;
    provider: AiProviderName;
    contentClasses: readonly AiProviderContentClass[];
  }>,
): Promise<AiDataPolicyDecision> {
  const classes = [...new Set(params.contentClasses)];
  if (typeof params.organizationId !== 'string' || params.organizationId.trim().length === 0
    || !FORGEWING_PROVIDERS.includes(params.provider)
    || classes.some((entry) => !FORGEWING_CONTENT_CLASSES.includes(entry))) {
    return { approved: false, reason: 'lookup_failed', contentClass: null };
  }
  const latestByClass = new Map<AiProviderContentClass, AiDataPolicyEvent | null>();
  try {
    for (const contentClass of classes) {
      const { data, error } = await admin
        .from(FORGEWING_DATA_POLICY_EVENTS_TABLE)
        .select('id, approved')
        .eq('organization_id', params.organizationId)
        .eq('provider', params.provider)
        .eq('content_class', contentClass)
        .order('recorded_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(1);
      if (error || !Array.isArray(data)) return { approved: false, reason: 'lookup_failed', contentClass };
      const latest = data[0] as Partial<AiDataPolicyEvent> | undefined;
      if (latest && (typeof latest.id !== 'string' || typeof latest.approved !== 'boolean')) {
        return { approved: false, reason: 'lookup_failed', contentClass };
      }
      latestByClass.set(contentClass, (latest as AiDataPolicyEvent | undefined) ?? null);
    }
  } catch {
    return { approved: false, reason: 'lookup_failed', contentClass: null };
  }
  return decideForgewingDataPolicy(latestByClass, classes);
}

const DEFAULT_VALUE_READING_DAILY_CAP = 0;
const MAXIMUM_VALUE_READING_DAILY_CAP = 500;

/** A workflow's calls per organization per trailing 24 hours. Default 0: no calls unless configured. */
export function readForgewingWorkflowDailyCap(
  workflow: GatedWorkflow,
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env[FORGEWING_WORKFLOW_POLICIES[workflow].dailyCapEnv];
  if (raw == null || raw.trim() === '') return DEFAULT_VALUE_READING_DAILY_CAP;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= MAXIMUM_VALUE_READING_DAILY_CAP
    ? parsed : DEFAULT_VALUE_READING_DAILY_CAP;
}

/** Calls per organization per trailing 24 hours. Default 0: no calls unless configured. */
export function readValueReadingDailyCap(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  return readForgewingWorkflowDailyCap('priced_value_reading', env);
}

export type ValueReadingEligibility =
  | Readonly<{
      eligible: true;
      entitlementEventId: string;
      dataPolicyEventIds: readonly string[];
      dailyCap: number;
    }>
  | Readonly<{
      eligible: false;
      reason:
        | 'kill_switch_off'
        | 'activation_disabled'
        | 'no_entitlement'
        | 'entitlement_revoked'
        | 'data_policy_not_approved'
        | 'data_policy_revoked'
        | 'budget_not_configured'
        | 'lookup_failed';
      contentClass?: AiProviderContentClass | null;
    }>;

/**
 * Pure decision over every gate, in order. Exported so the full gate matrix is
 * testable even while the policy keeps the reading disabled.
 */
export function decideValueReadingEligibility(params: Readonly<{
  masterEnabled: boolean;
  activation: 'disabled' | 'controlled' | 'enabled';
  entitlement: Awaited<ReturnType<OrganizationForgewingEntitlementResolver>> | null;
  dataPolicy: AiDataPolicyDecision | null;
  dailyCap: number;
}>): ValueReadingEligibility {
  if (!params.masterEnabled) return { eligible: false, reason: 'kill_switch_off' };
  if (params.activation === 'disabled') return { eligible: false, reason: 'activation_disabled' };
  const entitlement = params.entitlement;
  if (!entitlement) return { eligible: false, reason: 'lookup_failed' };
  if (!entitlement.entitled) {
    return {
      eligible: false,
      reason: entitlement.reason === 'revoked' ? 'entitlement_revoked'
        : entitlement.reason === 'no_entitlement' ? 'no_entitlement'
        : entitlement.reason === 'kill_switch_off' ? 'kill_switch_off' : 'lookup_failed',
    };
  }
  const dataPolicy = params.dataPolicy;
  if (!dataPolicy) return { eligible: false, reason: 'lookup_failed' };
  if (!dataPolicy.approved) {
    return {
      eligible: false,
      reason: dataPolicy.reason === 'revoked' ? 'data_policy_revoked'
        : dataPolicy.reason === 'not_approved' ? 'data_policy_not_approved' : 'lookup_failed',
      contentClass: dataPolicy.contentClass,
    };
  }
  if (!Number.isSafeInteger(params.dailyCap) || params.dailyCap <= 0) {
    return { eligible: false, reason: 'budget_not_configured' };
  }
  return {
    eligible: true,
    entitlementEventId: entitlement.eventId,
    dataPolicyEventIds: dataPolicy.eventIds,
    dailyCap: params.dailyCap,
  };
}

/**
 * Whether a value reading may be requested for this organization, sending
 * exactly these content classes. Reads only, and only as far as needed: a
 * closed earlier gate means no later lookup. A yes still needs a reservation
 * from the durable budget at call time.
 */
export async function resolveValueReadingEligibility(
  admin: SupabaseClient,
  params: Readonly<{
    organizationId: string;
    contentClasses: readonly AiProviderContentClass[];
    provider?: AiProviderName;
  }>,
  dependencies: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    resolveEntitlement?: OrganizationForgewingEntitlementResolver;
    resolveDataPolicy?: typeof resolveForgewingDataPolicy;
  }> = {},
): Promise<ValueReadingEligibility> {
  return resolveForgewingWorkflowEligibility(admin, { ...params, workflow: 'priced_value_reading' }, dependencies);
}

/**
 * Whether a workflow may send exactly these content classes to a provider for
 * this organization: kill switch, workflow policy, entitlement, data policy,
 * daily cap, in that order, reading only as far as needed. A yes still needs
 * a reservation from the workflow's durable budget at call time.
 */
export async function resolveForgewingWorkflowEligibility(
  admin: SupabaseClient,
  params: Readonly<{
    organizationId: string;
    workflow: GatedWorkflow;
    contentClasses: readonly AiProviderContentClass[];
    provider?: AiProviderName;
  }>,
  dependencies: Readonly<{
    env?: Readonly<Record<string, string | undefined>>;
    resolveEntitlement?: OrganizationForgewingEntitlementResolver;
    resolveDataPolicy?: typeof resolveForgewingDataPolicy;
  }> = {},
): Promise<ValueReadingEligibility> {
  const env = dependencies.env ?? process.env;
  const gate = forgewingWorkflowActivation(params.workflow, env);
  const base = { masterEnabled: gate.masterEnabled, activation: gate.activation,
    dailyCap: readForgewingWorkflowDailyCap(params.workflow, env) };
  const early = decideValueReadingEligibility({ ...base, entitlement: null, dataPolicy: null });
  if (!early.eligible && (early.reason === 'kill_switch_off' || early.reason === 'activation_disabled')) return early;
  const entitlement = await (dependencies.resolveEntitlement ?? resolveForgewingEntitlement)(admin, params.organizationId);
  if (!entitlement.entitled) return decideValueReadingEligibility({ ...base, entitlement, dataPolicy: null });
  const dataPolicy = await (dependencies.resolveDataPolicy ?? resolveForgewingDataPolicy)(admin, {
    organizationId: params.organizationId,
    provider: params.provider ?? 'anthropic',
    contentClasses: params.contentClasses,
  });
  return decideValueReadingEligibility({ ...base, entitlement, dataPolicy });
}

export type ProviderCallReservation =
  | Readonly<{ status: 'reserved'; reservationId: string; usedInWindow: number }>
  | Readonly<{ status: 'budget_exhausted'; usedInWindow: number }>
  | Readonly<{ status: 'failed' }>;

/** Spends one slot of the organization's durable daily budget. Call immediately before a provider call. */
export async function reserveForgewingProviderCall(
  admin: SupabaseClient,
  params: Readonly<{
    organizationId: string;
    requestDigestSha256: string;
    reservedBy: string | null;
    dailyCap: number;
    /** Each workflow spends its own budget. */
    workflow?: GatedWorkflow;
  }>,
): Promise<ProviderCallReservation> {
  try {
    const { data, error } = await admin.rpc(RESERVE_FORGEWING_PROVIDER_CALL_RPC, {
      p_organization_id: params.organizationId,
      p_recovery_type: params.workflow ?? 'priced_value_reading',
      p_request_digest_sha256: params.requestDigestSha256,
      p_reserved_by: params.reservedBy,
      p_daily_cap: params.dailyCap,
    });
    const row = Array.isArray(data) ? data[0] as { reserved?: unknown; reservation_id?: unknown; used_in_window?: unknown } : null;
    if (error || !row || typeof row.reserved !== 'boolean' || typeof row.used_in_window !== 'number') {
      return { status: 'failed' };
    }
    if (!row.reserved) return { status: 'budget_exhausted', usedInWindow: row.used_in_window };
    return typeof row.reservation_id === 'string'
      ? { status: 'reserved', reservationId: row.reservation_id, usedInWindow: row.used_in_window }
      : { status: 'failed' };
  } catch {
    return { status: 'failed' };
  }
}
