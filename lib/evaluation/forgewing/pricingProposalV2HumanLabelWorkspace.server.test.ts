import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';

import { GET as sourceGet } from
  '@/app/api/evaluation/forgewing/v2-field-labels/source/route';
import { PUT as finalizePut } from
  '@/app/api/evaluation/forgewing/v2-field-labels/finalize/route';
import { POST as validatePost } from
  '@/app/api/evaluation/forgewing/v2-field-labels/validate/route';
import { isV2HumanLabelWorkspaceEnabled } from
  '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace.server';

describe('V2 B-prime local workspace access', () => {
  it('requires non-production, explicit enablement, and loopback host', () => {
    expect(isV2HumanLabelWorkspaceEnabled({ nodeEnv: 'development', featureFlag: '1',
      host: '127.0.0.1:3000' })).toBe(true);
    expect(isV2HumanLabelWorkspaceEnabled({ nodeEnv: 'development', featureFlag: '1',
      host: '[::1]:3000' })).toBe(true);
    expect(isV2HumanLabelWorkspaceEnabled({ nodeEnv: 'production', featureFlag: '1',
      host: 'localhost:3000' })).toBe(false);
    expect(isV2HumanLabelWorkspaceEnabled({ nodeEnv: 'development', featureFlag: '0',
      host: 'localhost:3000' })).toBe(false);
    expect(isV2HumanLabelWorkspaceEnabled({ nodeEnv: 'development', featureFlag: '1',
      host: 'example.com' })).toBe(false);
  });

  it('returns 404 from every API when disabled/non-loopback', async () => {
    const previous = process.env.ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE;
    process.env.ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE = '1';
    try {
      const sourceRequest = new NextRequest(
        'http://example.com/api/evaluation/forgewing/v2-field-labels/source',
        { headers: { host: 'example.com' } });
      const validateRequest = new NextRequest(
        'http://example.com/api/evaluation/forgewing/v2-field-labels/validate',
        { method: 'POST', body: '{}', headers: { host: 'example.com' } });
      const finalizeRequest = new NextRequest(
        'http://example.com/api/evaluation/forgewing/v2-field-labels/finalize',
        { method: 'PUT', body: '{}', headers: { host: 'example.com' } });
      await expect(sourceGet(sourceRequest as never)).resolves.toMatchObject({ status: 404 });
      await expect(validatePost(validateRequest as never)).resolves.toMatchObject({ status: 404 });
      await expect(finalizePut(finalizeRequest as never)).resolves.toMatchObject({ status: 404 });
    } finally {
      if (previous == null) delete process.env.ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE;
      else process.env.ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE = previous;
    }
  });
});
