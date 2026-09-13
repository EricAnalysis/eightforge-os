import { describe, expect, it, vi } from 'vitest';

import {
  runForgewingPricingRateClusterRecovery,
  type ForgewingPricingRateClusterRecoveryInput,
} from '@/lib/forgewing/tasks/pricingRateClusterRecovery';

describe('Forgewing pricing recovery V1 qualification ceiling', () => {
  it('cannot be activated by a direct caller or environment flags', async () => {
    const provider = vi.fn();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const input = {
      organizationId: 'organization-1',
      sourceDocumentId: 'document-1',
      sourceArtifactId: 'artifact-1',
      extractionSnapshotId: 'snapshot-1',
      physicalPageNumber: 1,
      recoveryTaskType: 'pricing_rate_cluster_recovery',
      eligibilityReason: 'ambiguous_relationship',
      diagnosticReason: 'ambiguous_rate_clusters',
      observations: [],
    } as unknown as ForgewingPricingRateClusterRecoveryInput;
    const result = await runForgewingPricingRateClusterRecovery(input, {
      config: { enabled: true, model: 'test', timeoutMs: 1_000, maxCalls: 1,
        maxOutputTokens: 800 },
      taskEnabled: true,
      env: {
        FORGEWING_SHADOW_ENABLED: '1',
        FORGEWING_PRICING_RATE_CLUSTER_RECOVERY_ENABLED: '1',
      },
      provider,
    });
    expect(result).toMatchObject({
      status: 'eligible_not_executed',
      reason: 'recovery_disabled',
    });
    expect(provider).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[forgewingOperationalPolicy] configuration warning',
      expect.objectContaining({
        context: 'pricing_v1_runner',
        warnings: expect.arrayContaining([
          expect.objectContaining({ reason: 'unqualified_activation_requested' }),
        ]),
      }),
    );
    warn.mockRestore();
  });
});
