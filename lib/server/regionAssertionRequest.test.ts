import { describe, expect, it } from 'vitest';

import { parseRegionAssertionRequest } from '@/lib/server/regionAssertionRequest';

const PROPOSAL_ID = `forgewing-proposal-value-reading-${'c'.repeat(64)}`;
const BODY = {
  factKey: 'contract_rate_row',
  value: { description: 'Hauling', unit_type: 'TON', rate_amount: 8.75 },
  reason: 'OCR damaged',
  anchorKey: 'p2:a',
  idempotencyKey: 'k-1',
  physicalPageNumber: 2,
  pageRepresentationDigest: 'a'.repeat(64),
  sourceRegion: { coordinate_space: 'source', boxes: [{ x_min: 0, x_max: 1, y_min: 0, y_max: 1 }] },
  sourceObservationIds: ['o1'],
};

describe('region assertion request: cited value-reading proposals (B4.2)', () => {
  it('carries no proposal by default, exactly as before', () => {
    const parsed = parseRegionAssertionRequest(BODY);
    expect(parsed.ok && parsed.request.forgewingProposalId).toBe(null);
  });

  it('carries a well-formed value-reading proposal id for the database to verify', () => {
    const parsed = parseRegionAssertionRequest({ ...BODY, forgewingProposalId: PROPOSAL_ID });
    expect(parsed.ok && parsed.request.forgewingProposalId).toBe(PROPOSAL_ID);
  });

  it('refuses anything that is not a value-reading proposal id', () => {
    for (const forgewingProposalId of [`forgewing-proposal-recovery-v2-${'c'.repeat(64)}`, 'x', 7, {}]) {
      expect(parseRegionAssertionRequest({ ...BODY, forgewingProposalId })).toMatchObject({ ok: false, status: 400 });
    }
  });

  it('refuses a suggestion on a withdrawal or on anything but a reviewed rate row', () => {
    expect(parseRegionAssertionRequest({
      ...BODY, status: 'withdrawn', supersedesAssertionId: 'a-1', forgewingProposalId: PROPOSAL_ID,
    })).toMatchObject({ ok: false, status: 400 });
    expect(parseRegionAssertionRequest({
      ...BODY, factKey: 'other_fact', value: 'x', forgewingProposalId: PROPOSAL_ID,
    })).toMatchObject({ ok: false, status: 400 });
  });

  it('never accepts a review origin from the request', () => {
    const parsed = parseRegionAssertionRequest({ ...BODY, reviewOrigin: 'ai_proposed_operator_approved' });
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed)).not.toMatch(/ai_proposed_operator/);
  });
});
