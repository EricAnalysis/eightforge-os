import { hashCanonical } from '@/lib/extraction/domain/hash';

export const RECOVERY_OPERATIONAL_POLICY_VERSION = 'phase-16-v1' as const;

export const RECOVERY_QUALIFICATION_STATES = [
  'unqualified',
  'synthetic_qualified',
  'corpus_qualified',
  'production_qualified',
] as const;
export type RecoveryQualification = typeof RECOVERY_QUALIFICATION_STATES[number];

export const RECOVERY_ACTIVATION_STATES = ['disabled', 'controlled', 'enabled'] as const;
export type RecoveryActivation = typeof RECOVERY_ACTIVATION_STATES[number];

export const RECOVERY_OPERATIONAL_TYPES = [
  'priced_schedule_continuation_attribution',
  'pricing_rate_multi_observation_cluster',
  'pricing_rate_single_observation',
] as const;
export type RecoveryOperationalType = typeof RECOVERY_OPERATIONAL_TYPES[number];

export type RecoveryOperationalPolicyEntry = Readonly<{
  qualification: RecoveryQualification;
  qualificationCeiling: RecoveryActivation;
  reviewRequired: true;
  deprecatedForNewScheduling: boolean;
  /** null shares the remaining document-wide call budget; zero disables provider slots. */
  perTypeCallCap: number | null;
}>;

export const RECOVERY_OPERATIONAL_POLICY: Readonly<
  Record<RecoveryOperationalType, RecoveryOperationalPolicyEntry>
> = Object.freeze({
  priced_schedule_continuation_attribution: Object.freeze({
    qualification: 'corpus_qualified',
    qualificationCeiling: 'controlled',
    reviewRequired: true,
    deprecatedForNewScheduling: false,
    perTypeCallCap: null,
  }),
  pricing_rate_multi_observation_cluster: Object.freeze({
    qualification: 'synthetic_qualified',
    qualificationCeiling: 'disabled',
    reviewRequired: true,
    deprecatedForNewScheduling: false,
    perTypeCallCap: 0,
  }),
  pricing_rate_single_observation: Object.freeze({
    qualification: 'synthetic_qualified',
    qualificationCeiling: 'disabled',
    reviewRequired: true,
    deprecatedForNewScheduling: true,
    perTypeCallCap: 0,
  }),
});

export const RECOVERY_OPERATIONAL_POLICY_DIGEST = hashCanonical({
  version: RECOVERY_OPERATIONAL_POLICY_VERSION,
  policy: RECOVERY_OPERATIONAL_POLICY,
});

export const RECOVERY_CONFIG_WARNING_REASONS = [
  'malformed_boolean',
  'out_of_range_integer',
  'sub_gate_without_master',
  'cluster_gate_without_v2',
  'unqualified_activation_requested',
] as const;
export type RecoveryConfigWarningReason = typeof RECOVERY_CONFIG_WARNING_REASONS[number];

type RecoveryConfigSetting =
  | 'master_gate'
  | 'region_classification_gate'
  | 'recovery_v2_gate'
  | 'pricing_cluster_v2_gate'
  | 'pricing_v1_gate'
  | 'maximum_calls'
  | 'timeout'
  | 'maximum_output_tokens';

export type RecoveryConfigWarning = Readonly<{
  reason: RecoveryConfigWarningReason;
  setting: RecoveryConfigSetting;
  recoveryType?: RecoveryOperationalType;
}>;

export type RecoveryOperationalConfig = Readonly<{
  masterEnabled: boolean;
  regionClassificationEnabled: boolean;
  maxCalls: number;
  timeoutMs: number;
  maxOutputTokens: number;
  activationByType: Readonly<Record<RecoveryOperationalType, RecoveryActivation>>;
  requestedActivationByType: Readonly<Record<RecoveryOperationalType, RecoveryActivation>>;
  warnings: readonly RecoveryConfigWarning[];
}>;

const EMITTED_WARNING_SIGNATURES = new Set<string>();

const DEFAULT_MAX_CALLS = 1;
const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

function strictBoolean(
  raw: string | undefined,
  setting: RecoveryConfigSetting,
  warnings: RecoveryConfigWarning[],
): boolean {
  if (raw == null || raw === '' || raw === '0') return false;
  if (raw === '1') return true;
  warnings.push({ reason: 'malformed_boolean', setting });
  return false;
}

function boundedInteger(
  raw: string | undefined,
  setting: RecoveryConfigSetting,
  fallback: number,
  minimum: number,
  maximum: number,
  warnings: RecoveryConfigWarning[],
): number {
  if (raw == null || raw === '') return fallback;
  const parsed = Number(raw);
  if (Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum) return parsed;
  warnings.push({ reason: 'out_of_range_integer', setting });
  return fallback;
}

const ACTIVATION_RANK: Readonly<Record<RecoveryActivation, number>> = Object.freeze({
  disabled: 0,
  controlled: 1,
  enabled: 2,
});

export function minimumRecoveryActivation(
  left: RecoveryActivation,
  right: RecoveryActivation,
): RecoveryActivation {
  return ACTIVATION_RANK[left] <= ACTIVATION_RANK[right] ? left : right;
}

export function readRecoveryOperationalConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
  options: Readonly<{ emitWarnings?: boolean; context?: string }> = {},
): RecoveryOperationalConfig {
  const warnings: RecoveryConfigWarning[] = [];
  const master = strictBoolean(env.FORGEWING_SHADOW_ENABLED, 'master_gate', warnings);
  const region = strictBoolean(
    env.FORGEWING_REGION_CLASSIFICATION_ENABLED,
    'region_classification_gate',
    warnings,
  );
  const v2 = strictBoolean(
    env.FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED,
    'recovery_v2_gate',
    warnings,
  );
  const clusterV2 = strictBoolean(
    env.FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED,
    'pricing_cluster_v2_gate',
    warnings,
  );
  const v1 = strictBoolean(
    env.FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED,
    'pricing_v1_gate',
    warnings,
  );

  if (!master && (region || v2 || clusterV2 || v1)) {
    warnings.push({ reason: 'sub_gate_without_master', setting: 'master_gate' });
  }
  if (clusterV2 && !v2) {
    warnings.push({ reason: 'cluster_gate_without_v2', setting: 'pricing_cluster_v2_gate' });
  }

  const requestedActivationByType = Object.freeze({
    priced_schedule_continuation_attribution:
      master && v2 ? 'enabled' as const : 'disabled' as const,
    pricing_rate_multi_observation_cluster:
      master && v2 && clusterV2 ? 'enabled' as const : 'disabled' as const,
    pricing_rate_single_observation:
      master && v1 ? 'enabled' as const : 'disabled' as const,
  });
  const activationByType = Object.freeze(Object.fromEntries(
    RECOVERY_OPERATIONAL_TYPES.map((recoveryType) => {
      const requested = requestedActivationByType[recoveryType];
      const effective = minimumRecoveryActivation(
        RECOVERY_OPERATIONAL_POLICY[recoveryType].qualificationCeiling,
        requested,
      );
      if (requested !== 'disabled' && effective === 'disabled') {
        warnings.push({
          reason: 'unqualified_activation_requested',
          setting: recoveryType === 'pricing_rate_single_observation'
            ? 'pricing_v1_gate' : 'pricing_cluster_v2_gate',
          recoveryType,
        });
      }
      return [recoveryType, effective];
    }),
  ) as Record<RecoveryOperationalType, RecoveryActivation>);

  const config = Object.freeze({
    masterEnabled: master,
    regionClassificationEnabled: master && region,
    maxCalls: boundedInteger(
      env.FORGEWING_MAX_CALLS,
      'maximum_calls',
      DEFAULT_MAX_CALLS,
      1,
      4,
      warnings,
    ),
    timeoutMs: boundedInteger(
      env.FORGEWING_TIMEOUT_MS,
      'timeout',
      DEFAULT_TIMEOUT_MS,
      100,
      8_000,
      warnings,
    ),
    maxOutputTokens: boundedInteger(
      env.FORGEWING_MAX_OUTPUT_TOKENS,
      'maximum_output_tokens',
      DEFAULT_MAX_OUTPUT_TOKENS,
      128,
      2_000,
      warnings,
    ),
    activationByType,
    requestedActivationByType,
    warnings: Object.freeze(warnings),
  });
  // Gate readers run once per task per document. A misconfigured deployment is
  // one fact, not one per call, so each distinct warning set is logged once
  // per process and context rather than on every read.
  const signature = options.emitWarnings && config.warnings.length > 0
    ? JSON.stringify([options.context ?? 'unspecified', config.warnings])
    : null;
  if (signature && !EMITTED_WARNING_SIGNATURES.has(signature)) {
    EMITTED_WARNING_SIGNATURES.add(signature);
    console.warn('[forgewingOperationalPolicy] configuration warning', {
      policyVersion: RECOVERY_OPERATIONAL_POLICY_VERSION,
      policyDigest: RECOVERY_OPERATIONAL_POLICY_DIGEST,
      context: options.context ?? 'unspecified',
      warnings: config.warnings,
    });
  }
  return config;
}

/**
 * V2 recovery types admitted to deterministic candidate generation. Derived
 * from effective activation, never from raw gates, so a qualification change
 * in this module is the only way a new type starts generating candidates.
 */
export function admittedRecoveryV2GenerationTypes(
  config: RecoveryOperationalConfig,
): readonly Exclude<RecoveryOperationalType, 'pricing_rate_single_observation'>[] {
  return Object.freeze((['priced_schedule_continuation_attribution',
    'pricing_rate_multi_observation_cluster'] as const)
    .filter((recoveryType) => config.activationByType[recoveryType] !== 'disabled'));
}

export function recoveryOperationalState(
  recoveryType: RecoveryOperationalType,
  env: Readonly<Record<string, string | undefined>> = process.env,
): RecoveryOperationalPolicyEntry & Readonly<{ activation: RecoveryActivation }> {
  return Object.freeze({
    ...RECOVERY_OPERATIONAL_POLICY[recoveryType],
    activation: readRecoveryOperationalConfig(env).activationByType[recoveryType],
  });
}

export function describeRecoveryOperationalState(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<{
  policyVersion: string;
  policyDigest: string;
  activationByType: RecoveryOperationalConfig['activationByType'];
  warnings: readonly RecoveryConfigWarning[];
}> {
  const config = readRecoveryOperationalConfig(env);
  return Object.freeze({
    policyVersion: RECOVERY_OPERATIONAL_POLICY_VERSION,
    policyDigest: RECOVERY_OPERATIONAL_POLICY_DIGEST,
    activationByType: config.activationByType,
    warnings: config.warnings,
  });
}
