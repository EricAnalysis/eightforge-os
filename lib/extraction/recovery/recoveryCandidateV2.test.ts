import { describe, expect, it } from 'vitest';

import {
  buildRecoveryCandidateV2,
  RecoveryCandidateV2Schema,
  recoveryCandidateId,
} from '@/lib/extraction/recovery/recoveryCandidateV2';

const base = {
  recoveryType: 'pricing_rate_multi_observation_cluster' as const,
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
  physicalPageNumber: 7,
  pageRepresentationDigest: 'a'.repeat(64),
  targetRowIdentity: 'page_priced_schedule:p7:r2',
  orderedObservationIds: ['obs:dollar', 'obs:number'],
  rawTexts: ['$', '8.75'],
  composedRawText: '$ 8.75',
  evidence: [
    { observationId: 'obs:dollar', sourceLayer: 'pdf_native_text' as const,
      rawText: '$', boundingBox: { xMin: 1, xMax: 2, yMin: 3, yMax: 4 } },
    { observationId: 'obs:number', sourceLayer: 'pdf_native_text' as const,
      rawText: '8.75', boundingBox: { xMin: 2, xMax: 3, yMin: 3, yMax: 4 } },
  ],
};

describe('Recovery V2 candidate identity and closure', () => {
  it('derives a stable semantic id from ordered source identity', () => {
    const first = buildRecoveryCandidateV2(base)!;
    const second = buildRecoveryCandidateV2({ ...base, evidence: [...base.evidence] })!;
    expect(first.candidateId).toBe(second.candidateId);
    expect(first.candidateId).toBe(recoveryCandidateId(base));
  });

  it('makes observation order identity-significant', () => {
    expect(recoveryCandidateId(base)).not.toBe(recoveryCandidateId({
      ...base, orderedObservationIds: [...base.orderedObservationIds].reverse(),
    }));
  });

  it('rejects duplicate observation ids', () => {
    expect(buildRecoveryCandidateV2({
      ...base,
      orderedObservationIds: ['obs:dollar', 'obs:dollar'],
      rawTexts: ['$', '$'],
      evidence: [base.evidence[0]!, base.evidence[0]!],
      composedRawText: '$ $',
    })).toBeNull();
  });

  it('rejects a missing candidate member and a forged candidate id', () => {
    expect(buildRecoveryCandidateV2({ ...base, evidence: [base.evidence[0]!] })).toBeNull();
    const valid = buildRecoveryCandidateV2(base)!;
    expect(RecoveryCandidateV2Schema.safeParse({
      ...valid, candidateId: `recovery-candidate-v2-${'f'.repeat(64)}`,
    }).success).toBe(false);
  });
});
