import { getClaudeModel } from '@/lib/server/ai/claudeClient';
import { readRecoveryOperationalConfig }
  from '@/lib/extraction/recovery/recoveryOperationalPolicy';

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

export type ForgewingRuntimeConfig = Readonly<{
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxCalls: number;
  maxOutputTokens: number;
}>;

export type ForgewingRepositoryPlanRuntimeConfig = Readonly<{
  enabled: boolean;
  model: string;
  timeoutMs: number;
  maxOutputTokens: number;
}>;

export function isForgewingShadowEnabled(): boolean {
  return readRecoveryOperationalConfig(process.env, {
    emitWarnings: true, context: 'master_gate',
  }).masterEnabled;
}

/** Region classification is separately default-off beneath the Forgewing master gate. */
export function isForgewingRegionClassificationEnabled(): boolean {
  return readRecoveryOperationalConfig(process.env, {
    emitWarnings: true, context: 'region_classification_gate',
  }).regionClassificationEnabled;
}

/** Table continuation is separately default-off beneath the Forgewing master gate. */
export function isForgewingTableContinuationEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_TABLE_CONTINUATION_ENABLED === '1';
}

/** Semantic column mapping is separately default-off beneath the Forgewing master gate. */
export function isForgewingColumnMappingEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_COLUMN_MAPPING_ENABLED === '1';
}

/** Observation arbitration is separately default-off beneath the Forgewing master gate. */
export function isForgewingObservationArbitrationEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_OBSERVATION_ARBITRATION_ENABLED === '1';
}

/** Pricing interpretation is separately default-off beneath the Forgewing master gate. */
export function isForgewingPricingInterpretationEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_PRICING_INTERPRETATION_ENABLED === '1';
}

/** Ambiguous rate-cluster recovery is separately default-off beneath the shadow gate. */
export function isForgewingPricingRateClusterRecoveryEnabled(): boolean {
  return readRecoveryOperationalConfig(process.env, {
    emitWarnings: true, context: 'pricing_v1_gate',
  })
    .activationByType.pricing_rate_single_observation !== 'disabled';
}

export function isForgewingRecoveryCandidateV2Enabled(): boolean {
  return readRecoveryOperationalConfig(process.env, {
    emitWarnings: true, context: 'recovery_v2_gate',
  })
    .activationByType.priced_schedule_continuation_attribution !== 'disabled';
}

/** Workflow assessment is separately default-off beneath the shadow gate. */
export function isForgewingWorkflowAssessmentEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_WORKFLOW_ASSESSMENT_ENABLED === '1';
}

/** Repository-plan reasoning is separately default-off beneath the master gate. */
export function isForgewingRepositoryPlanGuidanceEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED === '1';
}

/** B2-specific bounds do not widen the conservative limits used by shadow extraction tasks. */
export function getForgewingRepositoryPlanRuntimeConfig(): ForgewingRepositoryPlanRuntimeConfig {
  return {
    enabled: isForgewingRepositoryPlanGuidanceEnabled(),
    model: process.env.FORGEWING_MODEL?.trim() || getClaudeModel(),
    timeoutMs: boundedInteger(process.env.FORGEWING_REPOSITORY_PLAN_TIMEOUT_MS, 60_000, 1_000, 120_000),
    maxOutputTokens: boundedInteger(process.env.FORGEWING_REPOSITORY_PLAN_MAX_OUTPUT_TOKENS, 8_000, 1_024, 16_000),
  };
}

export function getForgewingRuntimeConfig(): ForgewingRuntimeConfig {
  const operational = readRecoveryOperationalConfig(process.env, {
    emitWarnings: true, context: 'runtime_config',
  });
  return {
    enabled: operational.masterEnabled,
    model: process.env.FORGEWING_MODEL?.trim() || getClaudeModel(),
    timeoutMs: operational.timeoutMs,
    maxCalls: operational.maxCalls,
    maxOutputTokens: operational.maxOutputTokens,
  };
}
