import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  FORGEWING_QUALIFIED_MODELS,
  getForgewingRuntimeConfig,
  getForgewingRepositoryPlanRuntimeConfig,
  getForgewingWorkflowAssessmentRuntimeConfig,
  isForgewingColumnMappingEnabled,
  isForgewingObservationArbitrationEnabled,
  isForgewingPricingInterpretationEnabled,
  isForgewingPricingRateClusterRecoveryEnabled,
  isForgewingModelQualified,
  isForgewingRepositoryPlanGuidanceEnabled,
  isForgewingTableContinuationEnabled,
  isForgewingWorkflowAssessmentEnabled,
  resolveForgewingModel,
} from '@/lib/forgewing/runtime/modelConfig';

describe('Forgewing runtime configuration', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is default-off with conservative defaults', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', '');
    expect(getForgewingRuntimeConfig()).toMatchObject({
      enabled: false,
      model: 'claude-sonnet-4-6',
      timeoutMs: 3_000,
      maxCalls: 1,
      maxOutputTokens: 800,
    });
  });

  it('uses the Forgewing model override and rejects unsafe numeric configuration', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_MODEL', ' claude-sonnet-4-6 ');
    vi.stubEnv('FORGEWING_TIMEOUT_MS', '999999');
    vi.stubEnv('FORGEWING_MAX_CALLS', '-1');
    vi.stubEnv('FORGEWING_MAX_OUTPUT_TOKENS', 'NaN');
    expect(getForgewingRuntimeConfig()).toMatchObject({
      enabled: true,
      disabledReason: null,
      model: 'claude-sonnet-4-6',
      timeoutMs: 3_000,
      maxCalls: 1,
      maxOutputTokens: 800,
    });
  });

  it('fails closed with model_unqualified on any model outside the qualified list', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_ENABLED', '1');
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED', '1');
    for (const model of ['claude-forgewing', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-sonnet-4-6-x']) {
      vi.stubEnv('FORGEWING_MODEL', model);
      expect(getForgewingRuntimeConfig()).toMatchObject({ enabled: false, disabledReason: 'model_unqualified', model });
      expect(getForgewingRepositoryPlanRuntimeConfig())
        .toMatchObject({ enabled: false, disabledReason: 'model_unqualified', model });
      expect(isForgewingWorkflowAssessmentEnabled()).toBe(false);
      expect(isForgewingRepositoryPlanGuidanceEnabled()).toBe(false);
    }
    expect(warn).toHaveBeenCalledWith(
      '[forgewingModelConfig] model_unqualified: Forgewing stays disabled',
      expect.objectContaining({ model: 'claude-sonnet-5-5' }),
    );
    warn.mockRestore();
  });

  it('never silently inherits an unqualified shared model when FORGEWING_MODEL is unset', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-sonnet-5-5');
    expect(resolveForgewingModel()).toEqual({ model: 'claude-sonnet-5-5', source: 'shared_model', qualified: false });
    expect(getForgewingRuntimeConfig()).toMatchObject({ enabled: false, disabledReason: 'model_unqualified' });

    vi.stubEnv('ANTHROPIC_MODEL', '');
    expect(resolveForgewingModel()).toEqual({ model: 'claude-sonnet-4-6', source: 'shared_model', qualified: true });
    expect(getForgewingRuntimeConfig()).toMatchObject({ enabled: true, disabledReason: null });
  });

  it('qualification is code, not configuration: the list is frozen and names only the measured model', () => {
    expect(FORGEWING_QUALIFIED_MODELS).toEqual(['claude-sonnet-4-6']);
    expect(Object.isFrozen(FORGEWING_QUALIFIED_MODELS)).toBe(true);
    expect(isForgewingModelQualified(' claude-sonnet-4-6 ')).toBe(true);
  });

  it('gives Workflow Assessment its own bounded runtime, never the shadow-extraction limits (S3)', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_ENABLED', '1');
    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-4-6');
    expect(getForgewingWorkflowAssessmentRuntimeConfig()).toMatchObject({
      enabled: true, disabledReason: null, model: 'claude-sonnet-4-6',
      timeoutMs: 15_000, maxCalls: 1, maxOutputTokens: 4_000,
    });
    // A three-attempt sweep must fit its 60-second route budget.
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_TIMEOUT_MS', '60000');
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_MAX_OUTPUT_TOKENS', '64000');
    expect(getForgewingWorkflowAssessmentRuntimeConfig()).toMatchObject({ timeoutMs: 15_000, maxOutputTokens: 4_000 });
    vi.stubEnv('FORGEWING_WORKFLOW_ASSESSMENT_TIMEOUT_MS', '18000');
    expect(getForgewingWorkflowAssessmentRuntimeConfig().timeoutMs).toBe(18_000);

    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-5-5');
    expect(getForgewingWorkflowAssessmentRuntimeConfig())
      .toMatchObject({ enabled: false, disabledReason: 'model_unqualified' });
  });

  it('reports the master gate, not the model, when Forgewing is simply off', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-5-5');
    expect(getForgewingRuntimeConfig()).toMatchObject({ enabled: false, disabledReason: 'gate_off' });
  });

  it('falls back to the shared Anthropic model override', () => {
    vi.stubEnv('FORGEWING_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-shared-test');
    expect(getForgewingRuntimeConfig().model).toBe('claude-shared-test');
  });

  it('keeps qualified Forgewing and Plan V2 on their dedicated model during a shared-model migration', () => {
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-sonnet-5-5');
    vi.stubEnv('FORGEWING_MODEL', 'claude-sonnet-4-6');
    expect(getForgewingRuntimeConfig().model).toBe('claude-sonnet-4-6');
    expect(getForgewingRepositoryPlanRuntimeConfig().model).toBe('claude-sonnet-4-6');
  });

  it('keeps table continuation default-off behind both the master and task gates', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_TABLE_CONTINUATION_ENABLED', '1');
    expect(isForgewingTableContinuationEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_TABLE_CONTINUATION_ENABLED', '');
    expect(isForgewingTableContinuationEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_TABLE_CONTINUATION_ENABLED', '1');
    expect(isForgewingTableContinuationEnabled()).toBe(true);
  });

  it('keeps column mapping default-off behind both the master and task gates', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_COLUMN_MAPPING_ENABLED', '1');
    expect(isForgewingColumnMappingEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_COLUMN_MAPPING_ENABLED', '');
    expect(isForgewingColumnMappingEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_COLUMN_MAPPING_ENABLED', '1');
    expect(isForgewingColumnMappingEnabled()).toBe(true);
  });

  it('keeps observation arbitration default-off behind both the master and task gates', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_OBSERVATION_ARBITRATION_ENABLED', '1');
    expect(isForgewingObservationArbitrationEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_OBSERVATION_ARBITRATION_ENABLED', '');
    expect(isForgewingObservationArbitrationEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_OBSERVATION_ARBITRATION_ENABLED', '1');
    expect(isForgewingObservationArbitrationEnabled()).toBe(true);
  });

  it('keeps pricing interpretation default-off behind both the master and task gates', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_PRICING_INTERPRETATION_ENABLED', '1');
    expect(isForgewingPricingInterpretationEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_PRICING_INTERPRETATION_ENABLED', '');
    expect(isForgewingPricingInterpretationEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_PRICING_INTERPRETATION_ENABLED', '1');
    expect(isForgewingPricingInterpretationEnabled()).toBe(true);
  });

  it('keeps pricing rate-cluster recovery default-off behind both gates', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED', '1');
    expect(isForgewingPricingRateClusterRecoveryEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED', '');
    expect(isForgewingPricingRateClusterRecoveryEnabled()).toBe(false);

    vi.stubEnv('FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED', '1');
    expect(isForgewingPricingRateClusterRecoveryEnabled()).toBe(false);
  });

  it('uses dedicated bounded repository-plan settings behind both gates', () => {
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '');
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED', '1');
    expect(isForgewingRepositoryPlanGuidanceEnabled()).toBe(false);
    vi.stubEnv('FORGEWING_SHADOW_ENABLED', '1');
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED', '');
    expect(getForgewingRepositoryPlanRuntimeConfig()).toMatchObject({ enabled: false,
      timeoutMs: 60_000, maxOutputTokens: 8_000 });
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_GUIDANCE_ENABLED', '1');
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_TIMEOUT_MS', '120000');
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_MAX_OUTPUT_TOKENS', '16000');
    expect(getForgewingRepositoryPlanRuntimeConfig()).toMatchObject({ enabled: true,
      timeoutMs: 120_000, maxOutputTokens: 16_000 });
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_TIMEOUT_MS', '120001');
    vi.stubEnv('FORGEWING_REPOSITORY_PLAN_MAX_OUTPUT_TOKENS', '16001');
    expect(getForgewingRepositoryPlanRuntimeConfig()).toMatchObject({
      timeoutMs: 60_000, maxOutputTokens: 8_000 });
  });
});
