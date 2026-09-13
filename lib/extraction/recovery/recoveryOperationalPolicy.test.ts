import { describe, expect, it, vi } from 'vitest';

import {
  RECOVERY_OPERATIONAL_POLICY,
  RECOVERY_OPERATIONAL_POLICY_DIGEST,
  RECOVERY_OPERATIONAL_POLICY_VERSION,
  admittedRecoveryV2GenerationTypes,
  describeRecoveryOperationalState,
  readRecoveryOperationalConfig,
} from '@/lib/extraction/recovery/recoveryOperationalPolicy';
import { hashCanonical } from '@/lib/extraction/domain/hash';

describe('recovery operational policy', () => {
  it('seals the current qualification matrix and activation ceilings', () => {
    expect(RECOVERY_OPERATIONAL_POLICY).toEqual({
      priced_schedule_continuation_attribution: {
        qualification: 'corpus_qualified',
        qualificationCeiling: 'controlled',
        reviewRequired: true,
        deprecatedForNewScheduling: false,
        perTypeCallCap: null,
      },
      pricing_rate_multi_observation_cluster: {
        qualification: 'synthetic_qualified',
        qualificationCeiling: 'disabled',
        reviewRequired: true,
        deprecatedForNewScheduling: false,
        perTypeCallCap: 0,
      },
      pricing_rate_single_observation: {
        qualification: 'synthetic_qualified',
        qualificationCeiling: 'disabled',
        reviewRequired: true,
        deprecatedForNewScheduling: true,
        perTypeCallCap: 0,
      },
    });
  });

  it('allows requested continuation only at controlled activation', () => {
    const config = readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: '1',
      FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1',
    });
    expect(config.activationByType.priced_schedule_continuation_attribution)
      .toBe('controlled');
  });

  it('does not let environment requests activate synthetic-only recovery', () => {
    const config = readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: '1',
      FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1',
      FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED: '1',
      FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED: '1',
    });
    expect(config.activationByType.pricing_rate_multi_observation_cluster).toBe('disabled');
    expect(config.activationByType.pricing_rate_single_observation).toBe('disabled');
    expect(config.warnings.filter((warning) =>
      warning.reason === 'unqualified_activation_requested')).toHaveLength(2);
  });

  it('resolves the full gate × qualification truth table without ever reaching enabled', () => {
    const gates = [
      'FORGEWING_SHADOW_ENABLED',
      'FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED',
      'FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED',
      'FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED',
    ] as const;
    for (let mask = 0; mask < 2 ** gates.length; mask += 1) {
      const env = Object.fromEntries(gates.map((gate, index) =>
        [gate, mask & (1 << index) ? '1' : undefined]));
      const master = Boolean(mask & 1);
      const v2 = Boolean(mask & 2);
      const config = readRecoveryOperationalConfig(env);
      expect(config.activationByType).toEqual({
        priced_schedule_continuation_attribution: master && v2 ? 'controlled' : 'disabled',
        pricing_rate_multi_observation_cluster: 'disabled',
        pricing_rate_single_observation: 'disabled',
      });
      expect(admittedRecoveryV2GenerationTypes(config)).toEqual(
        master && v2 ? ['priced_schedule_continuation_attribution'] : [],
      );
    }
  });

  it('requires the region classification sub-gate beneath the master', () => {
    expect(readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: '1',
    }).regionClassificationEnabled).toBe(false);
    expect(readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: '1',
      FORGEWING_REGION_CLASSIFICATION_ENABLED: '1',
    }).regionClassificationEnabled).toBe(true);
  });

  it('fails malformed booleans and conflicting gates closed with structured warnings', () => {
    const config = readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: 'yes',
      FORGEWING_EXTRACTION_RECOVERY_V2_ENABLED: '1',
      FORGEWING_RECOVERY_V2_PRICING_CLUSTER_ENABLED: '1',
    });
    expect(config.masterEnabled).toBe(false);
    expect(config.activationByType.priced_schedule_continuation_attribution).toBe('disabled');
    expect(config.warnings.map((warning) => warning.reason)).toEqual(expect.arrayContaining([
      'malformed_boolean',
      'sub_gate_without_master',
    ]));
  });

  it('emits only structured, sanitized warning metadata when requested', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: 'yes',
      FORGEWING_REGION_CLASSIFICATION_ENABLED: 'true',
    }, { emitWarnings: true, context: 'test_boundary' });
    expect(warn).toHaveBeenCalledWith(
      '[forgewingOperationalPolicy] configuration warning',
      expect.objectContaining({
        context: 'test_boundary',
        warnings: expect.arrayContaining([
          expect.objectContaining({ reason: 'malformed_boolean', setting: 'master_gate' }),
          expect.objectContaining({
            reason: 'malformed_boolean', setting: 'region_classification_gate',
          }),
        ]),
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('FORGEWING_');
    // Gate readers run per task per document; the same misconfiguration must
    // not become a warning per call.
    readRecoveryOperationalConfig({
      FORGEWING_SHADOW_ENABLED: 'yes',
      FORGEWING_REGION_CLASSIFICATION_ENABLED: 'true',
    }, { emitWarnings: true, context: 'test_boundary' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('fails invalid integer values to the existing conservative defaults', () => {
    const config = readRecoveryOperationalConfig({
      FORGEWING_MAX_CALLS: '13',
      FORGEWING_TIMEOUT_MS: 'NaN',
      FORGEWING_MAX_OUTPUT_TOKENS: '127',
    });
    expect(config).toMatchObject({ maxCalls: 1, timeoutMs: 3_000, maxOutputTokens: 800 });
    expect(config.warnings.filter((warning) => warning.reason === 'out_of_range_integer'))
      .toHaveLength(3);
  });

  it('has a deterministic versioned canonical digest and log description', () => {
    expect(RECOVERY_OPERATIONAL_POLICY_DIGEST).toMatch(/^[a-f0-9]{64}$/);
    expect(RECOVERY_OPERATIONAL_POLICY_DIGEST).toBe(hashCanonical({
      version: RECOVERY_OPERATIONAL_POLICY_VERSION,
      policy: RECOVERY_OPERATIONAL_POLICY,
    }));
    expect(describeRecoveryOperationalState({})).toMatchObject({
      policyVersion: RECOVERY_OPERATIONAL_POLICY_VERSION,
      policyDigest: RECOVERY_OPERATIONAL_POLICY_DIGEST,
    });
  });
});
