/** SYNTHETIC provider-free tests for the Phase B-prime replay preflight. */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import type { ForgewingPricingProposalV2Preparation } from
  '@/scripts/evaluation/prepareForgewingPricingProposalV2';
import { buildForgewingPricingProposalV2HumanReviewPacket,
  writeForgewingPricingProposalV2HumanReviewPacket } from
  '@/scripts/evaluation/prepareForgewingPricingProposalV2HumanReview';
import type { ForgewingPricingProposalV2PhaseBReport } from
  '@/scripts/evaluation/runForgewingPricingProposalV2PhaseB';

function preparation(params: { ordering?: boolean; member?: string } = {}): ForgewingPricingProposalV2Preparation {
  const member = params.member ?? 'obs-1';
  const base = {
    reportVersion: 'forgewing-pricing-proposal-v2-preparation-v1' as const,
    proposalVersion: 'forgewing-pricing-interpretation-proposal-v2' as const,
    authority: 'non_authoritative_preparation' as const,
    providerCalls: 0 as const,
    promotionEvidence: false as const,
    promotionAuthorized: false as const,
    source: { sourcePdfPath: 'synthetic.pdf', sourceSha256: 'a'.repeat(64),
      sourceByteLength: 10, physicalPageCount: 1, sourceDocumentId: 'document-1',
      sourceArtifactId: 'artifact-1', extractionSnapshotId: 'snapshot-1' },
    v1Compatibility: { candidateCount: 1, candidateDigestSha256: 'b'.repeat(64),
      orderingDeterministic: params.ordering ?? true },
    reconstruction: { parserVersion: 'priced_schedule_reconstruction_v1', totalRows: 1,
      diagnosticCount: 0, diagnosticObservationIds: [], diagnosticReasonCounts: {},
      crossPageInferencePerformed: false, diagnosticRowLinkagePerformed: false },
    rowAccounting: { completeSourceCellGroupRows: 1, eligibleRows: 1, ineligibleRows: 0,
      ineligibilityReasonCounts: {} },
    fields: { count: 1, roleDistribution: { rate: 1 },
      sourceFieldIds: ['field-1'], duplicateSourceFieldIds: [],
      exactMembershipClosureFailures: 0, diagnosticMemberFailures: 0,
      crossRowFailures: 0, crossPageFailures: 0 },
    acceptedDiagnosticOverlapIds: [],
    rows: [{ candidateId: 'candidate-1', rowObservationId: 'row-1', exactMembershipClosure: true,
      context: { sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1',
        physicalPageNumber: 1, rowObservationId: 'row-1' },
      fields: [{ authoredRawTextDisplayOnly: '$ 1', field: { sourceFieldId: 'field-1',
        sourceFieldRole: 'rate' as const, authoredRawText: '$ 1', sourceObservationIds: [member],
        physicalPageNumber: 1 }, primitiveEvidence: [{ observationId: member, rawText: '$ 1',
          sourceDocumentId: 'document-1', sourceArtifactId: 'artifact-1', physicalPageNumber: 1,
          sourceLayer: 'pdf_native_text', artifactLocalIndex: 0 }] }] }],
  };
  return { ...base, preparationDigestSha256: hashCanonical(base) } as unknown as
    ForgewingPricingProposalV2Preparation;
}

function acceptedArtifact(preparations: readonly ForgewingPricingProposalV2Preparation[]) {
  const base = {
    reportVersion: 'forgewing-pricing-proposal-v2-phase-b-v1' as const,
    authority: 'non_authoritative_preparation' as const,
    providerCalls: 0 as const,
    promotionEvidence: false as const,
    promotionAuthorized: false as const,
    implementation: { commit: 'accepted-commit', worktreeDirty: false },
    proposalVersion: 'forgewing-pricing-interpretation-proposal-v2' as const,
    sources: preparations.map((item) => ({ preparation: item, deterministicReplay: true as const,
      replayDigestSha256: hashCanonical(item), v1CandidateDigestStable: true as const })),
    combinedSourceFieldCount: preparations.length,
    combinedDuplicateSourceFieldIds: [],
    limitations: ['synthetic_test_only'],
  };
  const report = { ...base, reportDigestSha256: hashCanonical(base) } satisfies
    ForgewingPricingProposalV2PhaseBReport;
  const bytes = Buffer.from(`${canonicalJson(report)}\n`);
  return { report, bytes, sha256: sha256Hex(bytes) };
}

function build(accepted: ReturnType<typeof acceptedArtifact>, replay = [preparation(), preparation()]) {
  return buildForgewingPricingProposalV2HumanReviewPacket({
    acceptedArtifactBytes: accepted.bytes,
    replayPreparations: replay,
    expectedArtifactSha256: accepted.sha256,
    expectedReportDigestSha256: accepted.report.reportDigestSha256,
    expectedImplementationCommit: 'accepted-commit',
  });
}

describe('SYNTHETIC: Forgewing V2 Phase B-prime replay preflight', () => {
  it('accepts exact deterministic source, row, field, role, and member replay', () => {
    const sources = [preparation(), preparation()];
    const packet = build(acceptedArtifact(sources), sources);
    expect(packet).toMatchObject({
      packetVersion: 'forgewing-pricing-v2-human-review-packet-v1',
      authority: 'evaluation_ground_truth_only', providerCalls: 0,
      promotionAuthorized: false, promotionEvidence: false,
      scope: { sourceCount: 2, rowCount: 2, fieldCount: 2, memberObservationCount: 2 },
      reviewStatus: 'not_started',
    });
    expect(packet.packetDigestSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('fails closed on artifact bytes and the independently recomputed report digest', () => {
    const sources = [preparation(), preparation()];
    const accepted = acceptedArtifact(sources);
    expect(() => buildForgewingPricingProposalV2HumanReviewPacket({
      acceptedArtifactBytes: accepted.bytes, replayPreparations: sources,
      expectedArtifactSha256: '0'.repeat(64),
      expectedReportDigestSha256: accepted.report.reportDigestSha256,
      expectedImplementationCommit: 'accepted-commit',
    })).toThrow('V2_BPRIME_ARTIFACT_SHA256_MISMATCH');

    const tampered = { ...accepted.report, reportDigestSha256: '0'.repeat(64) };
    const tamperedBytes = Buffer.from(`${canonicalJson(tampered)}\n`);
    expect(() => buildForgewingPricingProposalV2HumanReviewPacket({
      acceptedArtifactBytes: tamperedBytes, replayPreparations: sources,
      expectedArtifactSha256: sha256Hex(tamperedBytes),
      expectedReportDigestSha256: '0'.repeat(64), expectedImplementationCommit: 'accepted-commit',
    })).toThrow('V2_BPRIME_REPORT_DIGEST_MISMATCH');
  });

  it('kills nondeterministic ordering and exact member replay drift', () => {
    const unstable = [preparation({ ordering: false }), preparation({ ordering: false })];
    expect(() => build(acceptedArtifact(unstable), unstable))
      .toThrow('V2_BPRIME_ORDERING_NONDETERMINISTIC');

    const acceptedSources = [preparation(), preparation()];
    expect(() => build(acceptedArtifact(acceptedSources),
      [preparation({ member: 'foreign-observation' }), preparation()]))
      .toThrow('V2_BPRIME_SOURCE_REPLAY_DRIFT');
  });

  it('writes with wx, verifies readback, and refuses overwrite', () => {
    const sources = [preparation(), preparation()];
    const packet = build(acceptedArtifact(sources), sources);
    const output = join(mkdtempSync(join(tmpdir(), 'forgewing-v2-bprime-')), 'review.json');
    const written = writeForgewingPricingProposalV2HumanReviewPacket({ outputPath: output, packet });
    expect(written.sha256).toBe(sha256Hex(Buffer.from(readFileSync(output))));
    expect(() => writeForgewingPricingProposalV2HumanReviewPacket({ outputPath: output, packet }))
      .toThrow();
  });
});
