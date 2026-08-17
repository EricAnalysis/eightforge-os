import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getForgewingRuntimeConfig,
  isForgewingColumnMappingEnabled,
  isForgewingObservationArbitrationEnabled,
  isForgewingTableContinuationEnabled,
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
    vi.stubEnv('FORGEWING_MODEL', ' claude-forgewing ');
    vi.stubEnv('FORGEWING_TIMEOUT_MS', '999999');
    vi.stubEnv('FORGEWING_MAX_CALLS', '-1');
    vi.stubEnv('FORGEWING_MAX_OUTPUT_TOKENS', 'NaN');
    expect(getForgewingRuntimeConfig()).toMatchObject({
      enabled: true,
      model: 'claude-forgewing',
      timeoutMs: 3_000,
      maxCalls: 1,
      maxOutputTokens: 800,
    });
  });

  it('falls back to the shared Anthropic model override', () => {
    vi.stubEnv('FORGEWING_MODEL', '');
    vi.stubEnv('ANTHROPIC_MODEL', 'claude-shared-test');
    expect(getForgewingRuntimeConfig().model).toBe('claude-shared-test');
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
});
