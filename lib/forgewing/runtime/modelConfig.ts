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

/**
 * The models every Forgewing request contract (structured output, hardcoded
 * `temperature: 0`, zero retries) has been qualified on. Claude 5 rejects
 * sampling parameters, so an unlisted model would fail every call; worse, a
 * qualification result is bound to the model it measured. Widening this list
 * is a qualification decision recorded in code, never an environment setting.
 */
export const FORGEWING_QUALIFIED_MODELS: readonly string[] = Object.freeze(['claude-sonnet-4-6']);

export type ForgewingModelResolution = Readonly<{
  model: string;
  /** Where the model came from: the dedicated pin or the shared server default. */
  source: 'forgewing_model' | 'shared_model';
  qualified: boolean;
}>;

export function isForgewingModelQualified(model: string): boolean {
  return FORGEWING_QUALIFIED_MODELS.includes(model.trim());
}

/**
 * FORGEWING_MODEL, else the shared server model, then checked against the
 * qualified list. A shared-model migration (for example to a Claude 5 model)
 * therefore disables Forgewing explicitly instead of silently breaking it.
 */
export function resolveForgewingModel(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ForgewingModelResolution {
  const pinned = env.FORGEWING_MODEL?.trim();
  const model = pinned || getClaudeModel();
  return { model, source: pinned ? 'forgewing_model' : 'shared_model', qualified: isForgewingModelQualified(model) };
}

const warnedUnqualifiedModels = new Set<string>();

/** Resolves the model; warns once per context when an otherwise-open gate is closed by it. */
function qualifiedModelOrWarn(context: string, gateOpen = true): ForgewingModelResolution {
  const resolution = resolveForgewingModel();
  if (gateOpen && !resolution.qualified && !warnedUnqualifiedModels.has(`${context}:${resolution.model}`)) {
    warnedUnqualifiedModels.add(`${context}:${resolution.model}`);
    console.warn('[forgewingModelConfig] model_unqualified: Forgewing stays disabled', {
      context, model: resolution.model, source: resolution.source, qualified: FORGEWING_QUALIFIED_MODELS,
    });
  }
  return resolution;
}

export type ForgewingRuntimeDisabledReason = 'gate_off' | 'model_unqualified';

export type ForgewingRuntimeConfig = Readonly<{
  enabled: boolean;
  /** Why `enabled` is false; null when enabled. */
  disabledReason?: ForgewingRuntimeDisabledReason | null;
  model: string;
  timeoutMs: number;
  maxCalls: number;
  maxOutputTokens: number;
}>;

export type ForgewingRepositoryPlanRuntimeConfig = Readonly<{
  enabled: boolean;
  disabledReason?: ForgewingRuntimeDisabledReason | null;
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
    && process.env.FORGEWING_WORKFLOW_ASSESSMENT_ENABLED === '1'
    && qualifiedModelOrWarn('workflow_assessment').qualified;
}

export type WorkflowAssessmentGenerationMode = 'single_call' | 'decomposed';

/**
 * How an enabled Workflow Assessment is generated (DECOMPOSITION-PLAN.md, P4).
 * Only the exact value `decomposed` selects the two-stage pipeline; anything
 * else, including unset, keeps the single-call path. It never enables an
 * assessment by itself: isForgewingWorkflowAssessmentEnabled() still gates both.
 * Not to be set in production until the P5 live qualification passes.
 */
export function getForgewingWorkflowAssessmentGenerationMode(): WorkflowAssessmentGenerationMode {
  return process.env.FORGEWING_WORKFLOW_ASSESSMENT_GENERATION === 'decomposed' ? 'decomposed' : 'single_call';
}

/** Repository-plan reasoning is separately default-off beneath the master gate. */
export function isForgewingRepositoryPlanGuidanceEnabled(): boolean {
  return isForgewingShadowEnabled()
    && process.env.FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED === '1'
    && qualifiedModelOrWarn('repository_plan').qualified;
}

/** B2-specific bounds do not widen the conservative limits used by shadow extraction tasks. */
export function getForgewingRepositoryPlanRuntimeConfig(): ForgewingRepositoryPlanRuntimeConfig {
  const resolution = resolveForgewingModel();
  const enabled = isForgewingRepositoryPlanGuidanceEnabled();
  return {
    enabled,
    disabledReason: enabled ? null : resolution.qualified ? 'gate_off' : 'model_unqualified',
    model: resolution.model,
    timeoutMs: boundedInteger(process.env.FORGEWING_REPOSITORY_PLAN_TIMEOUT_MS, 60_000, 1_000, 120_000),
    maxOutputTokens: boundedInteger(process.env.FORGEWING_REPOSITORY_PLAN_MAX_OUTPUT_TOKENS, 8_000, 1_024, 16_000),
  };
}

/**
 * Workflow Assessment bounds (S3). An assessment reads seven answers and up to
 * five bounded attachment excerpts and returns every workflow step, so the
 * conservative shadow-extraction limits (3 s, 800 tokens) would truncate or
 * time out. One call per attempt.
 *
 * D2 (2026-11-06): a live claude-sonnet-4-6 call on the synthetic pilot intake
 * (10,668 input tokens) reached the old 4,000-token cap after 76.9 s, about
 * 52 tokens/s, so the old 15 s / 4,000-token contract could not complete an
 * assessment. A second live call at a 16,000-token cap was accepted and reached
 * 11 of 12 sections in 277.9 s (about 58 tokens/s) before truncating. At a
 * 20,000 cap the same intake completed in 17,333 tokens and 314.4 s.
 *
 * D4 (2026-11-06): with the v4 field contract the same intake completed in
 * 19,988 tokens and 344.0 s (about 58 tokens/s), 12 tokens under the 20,000 cap,
 * so assessment size varies by more than 2,600 tokens between runs. The output
 * ceiling is now 26,000 tokens, 30% above the largest observed run (about 520 s
 * at a pessimistic 50 tokens/s). The timeout ceiling is 600 s, which leaves 60 s
 * of the 660 s route budget for claim and finalization. The scheduled sweep
 * still makes one attempt per run.
 */
export const WORKFLOW_ASSESSMENT_DEFAULT_TIMEOUT_MS = 600_000;
export const WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS = 600_000;
export const WORKFLOW_ASSESSMENT_DEFAULT_MAX_OUTPUT_TOKENS = 26_000;
export const WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS = 26_000;

export function getForgewingWorkflowAssessmentRuntimeConfig(): ForgewingRuntimeConfig {
  const resolution = resolveForgewingModel();
  const enabled = isForgewingWorkflowAssessmentEnabled();
  return {
    enabled,
    disabledReason: enabled ? null : resolution.qualified ? 'gate_off' : 'model_unqualified',
    model: resolution.model,
    timeoutMs: boundedInteger(process.env.FORGEWING_WORKFLOW_ASSESSMENT_TIMEOUT_MS,
      WORKFLOW_ASSESSMENT_DEFAULT_TIMEOUT_MS, 1_000, WORKFLOW_ASSESSMENT_MAX_TIMEOUT_MS),
    maxCalls: 1,
    maxOutputTokens: boundedInteger(process.env.FORGEWING_WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS,
      WORKFLOW_ASSESSMENT_DEFAULT_MAX_OUTPUT_TOKENS, 800, WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS),
  };
}

export function getForgewingRuntimeConfig(): ForgewingRuntimeConfig {
  const operational = readRecoveryOperationalConfig(process.env, {
    emitWarnings: true, context: 'runtime_config',
  });
  const resolution = qualifiedModelOrWarn('runtime_config', operational.masterEnabled);
  // Fail closed: an unqualified model disables every task that reads this
  // config, before any request is built.
  const enabled = operational.masterEnabled && resolution.qualified;
  return {
    enabled,
    disabledReason: enabled ? null : !operational.masterEnabled ? 'gate_off' : 'model_unqualified',
    model: resolution.model,
    timeoutMs: operational.timeoutMs,
    maxCalls: operational.maxCalls,
    maxOutputTokens: operational.maxOutputTokens,
  };
}
