/**
 * REAL ARTIFACTS, LOCAL MUTATIONS ONLY. Source-level semantic closure of the
 * Phase B-prime review packet against the ACCEPTED Phase B preparation.
 *
 * Every mutation below rebuilds the packet canonical digest AND the packet file
 * SHA, and updates ONLY the mutation-test packet SHA pin, so packet byte
 * authentication succeeds. The rejection therefore cannot be
 * review_packet_sha_mismatch or review_packet_digest_mismatch: it must come from
 * semantic comparison against Phase B, which is the external authority.
 *
 * No Anthropic, no OpenAI, no network, no provider call.
 */
import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  authenticateForgewingV2PhaseCInputsForMutationTests,
  ForgewingV2PhaseCAuthenticationError,
  FORGEWING_V2_PHASE_C_ACCEPTED_PINS,
} from '@/lib/evaluation/forgewing/pricingProposalV2PhaseCAcceptedInputs';
import {
  deriveSourceFieldId,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';

const ROOT = 'C:/Dev/eightforge-os/scripts/evaluation/artifacts/';
const PKG = `${ROOT}local-v2-bprime-review/forgewing-pricing-v2-human-labels.completed.json`;
const PHB = `${ROOT}local-v2-phase-b/phase-b-f13c815.json`;
const PKT = `${ROOT}local-v2-bprime-review-20260827T1102Z/phase-b-prime-review-packet-fc7433a.json`;
const configured = [PKG, PHB, PKT].every((path) => existsSync(path));

type Rec = Record<string, unknown>;

/**
 * 1. copy accepted packet  2. mutate exactly one source-level value (via `mutate`)
 * 3. recompute packet canonical digest  4. recompute packet file SHA
 * 5. update ONLY the mutation-test packet SHA pin  6. authenticate
 */
function authenticateMutatedPacket(mutate: (packet: Rec) => Rec): string {
  const packet = JSON.parse(readFileSync(PKT, 'utf8')) as Rec;
  const unsigned = mutate(packet);
  delete unsigned.packetDigestSha256;
  const rebuilt: Rec = { ...unsigned, packetDigestSha256: hashCanonical(unsigned) };
  const bytes = Buffer.from(`${JSON.stringify(rebuilt, null, 2)}\n`, 'utf8');
  try {
    authenticateForgewingV2PhaseCInputsForMutationTests({
      humanLabelPackageBytes: readFileSync(PKG),
      phaseBArtifactBytes: readFileSync(PHB),
      reviewPacketBytes: bytes,
    }, { ...FORGEWING_V2_PHASE_C_ACCEPTED_PINS, reviewPacketSha256: sha256Hex(bytes) } as never);
  } catch (error) {
    if (error instanceof ForgewingV2PhaseCAuthenticationError) return error.failure;
    return `unexpected:${(error as Error).message}`;
  }
  return 'no_failure';
}

/** Mutate exactly one key inside the first packet source's `source` wrapper. */
const mutateIdentity = (key: string, value: unknown) => (packet: Rec): Rec => ({
  ...packet,
  sources: (packet.sources as Rec[]).map((source, index) => index !== 0 ? source : {
    ...source, source: { ...(source.source as Rec), [key]: value },
  }),
});

/** Any drift rejected on BYTES rather than semantics would not be closure. */
function expectSemanticPhaseBRejection(failure: string, expected: string): void {
  expect(failure).not.toBe('no_failure');
  expect(failure).not.toBe('review_packet_sha_mismatch');
  expect(failure).not.toBe('review_packet_digest_mismatch');
  expect(failure).toBe(expected);
}

describe.skipIf(!configured)('REAL: Phase C packet source-level Phase B closure', () => {
  it('authenticates the unmutated accepted packet through the same seam', () => {
    expect(authenticateMutatedPacket((packet) => ({ ...packet }))).toBe('no_failure');
  });

  it('rejects sourceSha256 drift', () => {
    expectSemanticPhaseBRejection(
      authenticateMutatedPacket(mutateIdentity('sourceSha256', 'f'.repeat(64))),
      'review_packet_source_sha_mismatch');
  });

  it('rejects sourceByteLength drift', () => {
    expectSemanticPhaseBRejection(
      authenticateMutatedPacket(mutateIdentity('sourceByteLength', 1063620)),
      'review_packet_source_byte_length_mismatch');
  });

  it('rejects preparationDigestSha256 drift', () => {
    expectSemanticPhaseBRejection(authenticateMutatedPacket((packet) => ({
      ...packet,
      sources: (packet.sources as Rec[]).map((source, index) => index !== 0 ? source : {
        ...source, preparationDigestSha256: 'a'.repeat(64),
      }),
    })), 'review_packet_preparation_digest_mismatch');
  });

  it('rejects sourceDocumentId drift', () => {
    expectSemanticPhaseBRejection(
      authenticateMutatedPacket(mutateIdentity('sourceDocumentId',
        'local-pricing-document-drift')),
      'review_packet_source_document_mismatch');
  });

  it('rejects sourceArtifactId drift', () => {
    expectSemanticPhaseBRejection(
      authenticateMutatedPacket(mutateIdentity('sourceArtifactId',
        '00000000-0000-5000-8000-000000000000')),
      'review_packet_source_artifact_mismatch');
  });

  it('rejects physicalPageCount drift', () => {
    expectSemanticPhaseBRejection(
      authenticateMutatedPacket(mutateIdentity('physicalPageCount', 47)),
      'review_packet_physical_page_count_mismatch');
  });

  it('rejects extractionSnapshotId drift', () => {
    expectSemanticPhaseBRejection(
      authenticateMutatedPacket(mutateIdentity('extractionSnapshotId',
        '11111111-1111-5111-8111-111111111111')),
      'review_packet_extraction_snapshot_mismatch');
  });

  it('rejects a source wrapper dropped from the packet', () => {
    expectSemanticPhaseBRejection(authenticateMutatedPacket((packet) => ({
      ...packet, sources: (packet.sources as Rec[]).slice(0, 1),
    })), 'review_packet_source_count_mismatch');
  });

  it('rejects a source whose identity is absent from Phase B entirely', () => {
    expectSemanticPhaseBRejection(authenticateMutatedPacket((packet) => ({
      ...packet,
      sources: (packet.sources as Rec[]).map((source, index) => index !== 0 ? source : {
        ...source, preparationDigestSha256: 'b'.repeat(64),
        source: { ...(source.source as Rec),
          sourceArtifactId: '22222222-2222-5222-8222-222222222222' },
      }),
    })), 'review_packet_source_absent_from_phase_b');
  });

  it('COORDINATED DRIFT: wrapper-only fields mutated together are still rejected', () => {
    // byteLength + pageCount + snapshot have no downstream packet references, so
    // this mutation leaves the packet fully internally self-consistent. Only the
    // external Phase B authority can reject it.
    expectSemanticPhaseBRejection(authenticateMutatedPacket((packet) => ({
      ...packet,
      sources: (packet.sources as Rec[]).map((source, index) => index !== 0 ? source : {
        ...source,
        source: { ...(source.source as Rec),
          sourceByteLength: 999999,
          physicalPageCount: 3,
          extractionSnapshotId: '33333333-3333-5333-8333-333333333333' },
      }),
    })), 'review_packet_source_byte_length_mismatch');
  });

  it('COORDINATED DRIFT: wrapper + rows + re-derived field ids are still rejected', () => {
    // The strongest coordinated form: the source wrapper, every enclosed row
    // context, and every enclosed sourceFieldId are rebuilt together so the packet
    // is internally consistent end to end, and the digest and SHA are recomputed.
    // Phase B remains the external authority, so it is still rejected.
    const failure = authenticateMutatedPacket((packet) => ({
      ...packet,
      sources: (packet.sources as Rec[]).map((source, index) => {
        if (index !== 0) return source;
        const driftedDocumentId = 'local-pricing-document-coordinated-drift';
        return {
          ...source,
          source: { ...(source.source as Rec), sourceDocumentId: driftedDocumentId },
          rows: (source.rows as Rec[]).map((row) => {
            const context: Rec = {
              ...(row.context as Rec), sourceDocumentId: driftedDocumentId,
            };
            return {
              ...row,
              context,
              fields: (row.fields as Rec[]).map((wrapper) => {
                const field = wrapper.field as Rec;
                return { ...wrapper, field: { ...field,
                  sourceFieldId: deriveSourceFieldId({
                    sourceDocumentId: context.sourceDocumentId as string,
                    sourceArtifactId: context.sourceArtifactId as string,
                    physicalPageNumber: context.physicalPageNumber as number,
                    rowObservationId: context.rowObservationId as string,
                    sourceFieldRole: field.sourceFieldRole as never,
                    sourceObservationIds: field.sourceObservationIds as string[],
                  }) } };
              }),
            };
          }),
        };
      }),
    }));
    expect(failure).not.toBe('no_failure');
    expect(failure).not.toBe('review_packet_sha_mismatch');
    expect(failure).not.toBe('review_packet_digest_mismatch');
    expect(failure).toBe('review_packet_source_document_mismatch');
  });

  it('rejects a row relocated under the wrong source wrapper', () => {
    expectSemanticPhaseBRejection(authenticateMutatedPacket((packet) => {
      const sources = packet.sources as Rec[];
      const moved = (sources[1].rows as Rec[])[0];
      return { ...packet, sources: [
        { ...sources[0], rows: [...(sources[0].rows as Rec[]), moved] },
        { ...sources[1], rows: (sources[1].rows as Rec[]).slice(1) },
      ] };
    }), 'review_packet_row_source_membership_mismatch');
  });
});
