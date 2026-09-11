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
  it('preserves the historical no-context candidate id byte-for-byte', () => {
    expect(recoveryCandidateId(base)).toBe(
      'recovery-candidate-v2-233fd5357c8421260fc5757b800d62a935786f8f78161cbaf871cb33d70424a5',
    );
    expect(buildRecoveryCandidateV2(base)).not.toHaveProperty('targetContextEvidence');
  });

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

  it('binds enriched continuation identity to ordered target observations', () => {
    const enriched = buildRecoveryCandidateV2({
      ...base,
      recoveryType: 'priced_schedule_continuation_attribution',
      targetContextEvidence: {
        targetRowIdentity: base.targetRowIdentity,
        orderedObservationIds: ['obs:target-description', 'obs:target-rate'],
        rawTexts: ['Removal', '$12.00'],
        composedRawText: 'Removal $12.00',
        evidence: [
          { observationId: 'obs:target-description', sourceLayer: 'pdf_native_text',
            rawText: 'Removal', boundingBox: { xMin: 10, xMax: 20, yMin: 30, yMax: 40 } },
          { observationId: 'obs:target-rate', sourceLayer: 'pdf_native_text',
            rawText: '$12.00', boundingBox: { xMin: 50, xMax: 60, yMin: 30, yMax: 40 } },
        ],
      },
    });
    expect(enriched).not.toBeNull();
    expect(enriched!.candidateId).not.toBe(recoveryCandidateId(base));
    expect(enriched!.candidateId).toBe(recoveryCandidateId(enriched!));
  });

  it('rejects partial, misaligned, overlapping, or wrong-row target context', () => {
    const targetContextEvidence = {
      targetRowIdentity: base.targetRowIdentity,
      orderedObservationIds: ['obs:target-a', 'obs:target-b'],
      rawTexts: ['Target', 'Row'],
      composedRawText: 'Target Row',
      evidence: [
        { observationId: 'obs:target-a', sourceLayer: 'pdf_native_text' as const,
          rawText: 'Target', boundingBox: { xMin: 10, xMax: 20, yMin: 30, yMax: 40 } },
        { observationId: 'obs:target-b', sourceLayer: 'pdf_native_text' as const,
          rawText: 'Row', boundingBox: { xMin: 20, xMax: 30, yMin: 30, yMax: 40 } },
      ],
    };
    expect(buildRecoveryCandidateV2({
      ...base, targetContextEvidence: { ...targetContextEvidence, rawTexts: ['Target'] },
    })).toBeNull();
    expect(buildRecoveryCandidateV2({
      ...base,
      targetContextEvidence: {
        ...targetContextEvidence,
        evidence: [...targetContextEvidence.evidence].reverse(),
      },
    })).toBeNull();
    expect(buildRecoveryCandidateV2({
      ...base,
      targetContextEvidence: {
        ...targetContextEvidence,
        orderedObservationIds: ['obs:dollar', 'obs:target-b'],
        evidence: [base.evidence[0]!, targetContextEvidence.evidence[1]!],
        rawTexts: ['$', 'Row'],
      },
    })).toBeNull();
    expect(buildRecoveryCandidateV2({
      ...base,
      targetContextEvidence: { ...targetContextEvidence, targetRowIdentity: 'other-row' },
    })).toBeNull();
    expect(buildRecoveryCandidateV2({ ...base, targetContextEvidence })).toBeNull();
  });
});
