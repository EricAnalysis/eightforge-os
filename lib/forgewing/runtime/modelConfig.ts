import { getClaudeModel } from '@/lib/server/ai/claudeClient';

const DEFAULT_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_CALLS = 1;
const DEFAULT_MAX_OUTPUT_TOKENS = 800;

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

export function isForgewingShadowEnabled(): boolean {
  return process.env.FORGEWING_SHADOW_ENABLED === '1';
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
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED === '1';
}

export function getForgewingRuntimeConfig(): ForgewingRuntimeConfig {
  return {
    enabled: isForgewingShadowEnabled(),
    model: process.env.FORGEWING_MODEL?.trim() || getClaudeModel(),
    timeoutMs: boundedInteger(process.env.FORGEWING_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 100, 8_000),
    maxCalls: boundedInteger(process.env.FORGEWING_MAX_CALLS, DEFAULT_MAX_CALLS, 1, 4),
    maxOutputTokens: boundedInteger(
      process.env.FORGEWING_MAX_OUTPUT_TOKENS,
      DEFAULT_MAX_OUTPUT_TOKENS,
      128,
      2_000,
    ),
  };
}
