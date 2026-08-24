import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  complete: vi.fn(),
  state: vi.fn(),
  prepare: vi.fn(),
}));

vi.mock('@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server', () => ({
  A3_WORKSPACE_ERROR_COPY: {
    REVIEWER_REQUIRED: 'REVIEWER REQUIRED',
    ATTESTATION_VALIDATION_FAILED: 'ATTESTATION VALIDATION FAILED',
  },
  isA3WorkspaceEnabled: mocks.enabled,
  completeA3WorkspaceAttestation: mocks.complete,
  getA3WorkspaceAttestationState: mocks.state,
  prepareA3WorkspaceAttestation: mocks.prepare,
}));

import { GET, PUT } from '@/app/api/evaluation/forgewing/a3-linkage/attestation/route';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enabled.mockReturnValue(true);
});

describe('A3 human attestation API boundary', () => {
  it('independently enforces the local-only workspace gate', async () => {
    mocks.enabled.mockReturnValue(false);
    const response = await PUT(new NextRequest(
      'http://example.com/api/evaluation/forgewing/a3-linkage/attestation',
      { method: 'PUT', body: JSON.stringify({ reviewer: 'reviewer', confirmed: true }) },
    ));
    expect(response.status).toBe(404);
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it('passes only the parsed browser body to server-side completion and returns no-store', async () => {
    mocks.complete.mockReturnValue({
      ok: true,
      status: 'human_attestation_complete',
      reviewer: 'reviewer',
      reviewedAt: '2026-08-24T16:20:30.000Z',
    });
    const input = { reviewer: 'reviewer', confirmed: true };
    const response = await PUT(new NextRequest(
      'http://localhost/api/evaluation/forgewing/a3-linkage/attestation',
      { method: 'PUT', body: JSON.stringify(input) },
    ));
    expect(mocks.complete).toHaveBeenCalledWith(input);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('returns human-readable completion failures without a stack trace', async () => {
    mocks.complete.mockReturnValue({ ok: false, code: 'REVIEWER_REQUIRED' });
    const response = await PUT(new NextRequest(
      'http://localhost/api/evaluation/forgewing/a3-linkage/attestation',
      { method: 'PUT', body: JSON.stringify({ reviewer: '', confirmed: true }) },
    ));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      code: 'REVIEWER_REQUIRED', error: 'REVIEWER REQUIRED',
    });
  });

  it('loads resume state through the same independently gated boundary', async () => {
    mocks.state.mockReturnValue({
      ok: true,
      status: { state: 'completed', reviewer: 'reviewer', promotionAuthorized: false },
    });
    const response = await GET(new NextRequest(
      'http://localhost/api/evaluation/forgewing/a3-linkage/attestation',
    ));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      state: 'completed', reviewer: 'reviewer', promotionAuthorized: false,
    });
  });
});
