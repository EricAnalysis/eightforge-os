import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { loadPdfLayout } from '@/lib/extraction/pdf/extractText';
import { buildPdfLayoutObservationsLayer } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { recoveryCandidateDigest } from '@/lib/extraction/recovery/recoveryCandidateV2';
import { buildDurableRecoveryProposalV2 } from '@/lib/server/forgewingRecoveryProposalPersistence';

/**
 * E2 identity stability on the real DN source (priced page 106).
 *
 * Opt-in and provider-free: skipped unless DN_PRICED_SCHEDULE_SOURCE_PDF is
 * configured. A skipped run proves nothing. Every value was recorded on
 * origin/main d5fb4ad before canonical geometry was wired in.
 */

const sourcePdfPath = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim();
const EXPECTED_SHA256 = '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272';
const PRICED_PAGE = 106;
const OBSERVATION_CONTEXT = {
  sourceDocumentId: 'dn-corpus-document',
  sourceArtifactId: '60000000-0000-4000-8000-000000000106',
} as const;
const CANDIDATE_DOCUMENT_ID = '50000000-0000-4000-8000-000000000106';
const E2_LAYER_SIDECAR_KEY = 'canonical_geometry_v1';

/** Recorded from origin/main d5fb4ad before E2 wiring. Do not regenerate to make a failure pass. */
const PRE_E2_DN_BASELINE: Record<string, unknown> = {
  pageRepresentationDigest: 'b8185ee3dd14b7fbc6c837cb9c834d037d0a1cd60f447b3c128a1d674269195d',
  candidateCount: 26,
  candidateIds: [
    'recovery-candidate-v2-18077a87cd122a35e4f6c40a665cdce34bb104920f91d8dc2f16179c0949b5a6',
    'recovery-candidate-v2-21ea810a06395d8f57984564ee42b122c55012d0341c2281e6f302211a3efdad',
    'recovery-candidate-v2-2a0cb0595c60e4129effe192739ddb382ef7e887820a862d8084e1b92359ff3d',
    'recovery-candidate-v2-374bf8dcf9556f8dd197d58b14e501e0457641f4c1290041fbd0023767c9ed76',
    'recovery-candidate-v2-3993666018a9855ffd66c2712d17fc465cd79805e1a6d0b70f15a4d769e0b529',
    'recovery-candidate-v2-3e4b88f6846262b87af52db6b8143d84fe9f68f0c6da65a01c3612ae8cb6f7ff',
    'recovery-candidate-v2-47f86f29725a29cdf18c0d0fe0880441ff1129bb90e053ec3527b989aa85366c',
    'recovery-candidate-v2-556d98bf0fb839e0437b2361bca6a655776671549dd481663af9b6fe2b484d23',
    'recovery-candidate-v2-59635289e83fc2802d5cabd2ca277dd0b9331485ebea8fa3d0d4ae1e5d04df79',
    'recovery-candidate-v2-5e1b3c02519c346865c16865695fc73fe3b9ef17f1c8b5e3f08851cbbe714a41',
    'recovery-candidate-v2-65a77d3d60b5f9fd0bb44769fc1311c06b0ff73cc44d74acba2d23644e590f64',
    'recovery-candidate-v2-6d77c7ee6c563685fd8f82880d79a92a266a1a51397812a09909baf063ff8675',
    'recovery-candidate-v2-6eae1e91a35dded41757c2ae4163f5114d3223beae39ae15b590ca2649249f3e',
    'recovery-candidate-v2-787e153d3127aec8ce8ec4b5591f793efea5bfbb159c448d1778c5ec649df8e3',
    'recovery-candidate-v2-7bced5219c8f79df3da8d6d2cd0a112f45c451f02af96237a212cfa47caac271',
    'recovery-candidate-v2-8372fce30003c7e75eb21d8cbcbf6d7f3c93c8c271648dda0454fe4430b1b515',
    'recovery-candidate-v2-861c7c6d9f042cb825e78f20d1ec5b56f6bd8727f7d6fbbd8083d33be71b15e3',
    'recovery-candidate-v2-9a59ceb85e09636c80c902644841098b9f9c5a5d699da89b348cc83616a4311f',
    'recovery-candidate-v2-9d8f9e181552adc6ff27b04a0e177114bb56ec39031af77d0e7832c5646a83b4',
    'recovery-candidate-v2-a91d1635cd55020c111095db6ff2b164410b7c46d63691494a23205c884fbd90',
    'recovery-candidate-v2-acbc4c086d8aa1c2ef4763589c877d1060c8d6157967cd181fae4091ee61b4da',
    'recovery-candidate-v2-afb088ee071742bdd130509d19063ad1e6e2fe36141adf7ad9f08536b3d68a0e',
    'recovery-candidate-v2-c33254021125180b8fcb723bd0779b68ec26e8ef46bde1b9ede5e83b7a95002e',
    'recovery-candidate-v2-cdde092aacc4906fc1b0f95a63a512ce9b17d921ac186fb905dea6caddf6b523',
    'recovery-candidate-v2-df749231db715eca49ed4d7e72ce8dd37d112a891a57bd58badd077f8029975c',
    'recovery-candidate-v2-ece1e0ab3fb4d31e9492453b1b270612791e3e245e362a987da064f714ce29c3'
  ],
  candidateDigestsHash: 'ba1118f01418e1889c54e9b668533e92bfd116b94c46ad36a8dc62e9b6ccdf6b',
  proposalId: 'forgewing-proposal-recovery-v2-9568a192eaf26b85ce557b473d5a327699b7ce020bd36bc8ebbc6850a0ee7d59',
  proposalDigest: '9568a192eaf26b85ce557b473d5a327699b7ce020bd36bc8ebbc6850a0ee7d59',
  observationIdsHash: '4c216efceb7936a87128a23b825c801fe95558d39d2b1e6de19c6124bb2f546f',
  sourceTokenGeometryHash: '2014f6353019223989d513058330dd9eddff5d3c22154a33249b36c9fbb8a284',
  reconstructionHash: 'e64b66031d678215a6a3581c6f12b27355fc447834f529654a8697a159614ca3',
  observationLayerHashWithoutE2Sidecar: '056bafba8290b8dafdccf55135ab7094ff316857f97ed0b9fb04837fe8099bfe',
  closureStatus: 'complete'
};

describe.skipIf(!sourcePdfPath)('E2 identity stability on DN p106', () => {
  it('keeps DN p106 IDs, digests and exact-match closure byte-identical', async () => {
    const bytes = await readFile(path.resolve(sourcePdfPath!));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(EXPECTED_SHA256);
    const layout = await loadPdfLayout(new Uint8Array(bytes).buffer as ArrayBuffer, {
      observationIdentity: OBSERVATION_CONTEXT,
    });
    const page = layout.pages.find((entry) => entry.page_number === PRICED_PAGE)!;
    const pageDigest = page.effective_representation_digest!;
    const reconstruction = buildPagePricedScheduleReconstruction({
      layout,
      recoveryCandidateBuildContext: {
        sourceDocumentId: CANDIDATE_DOCUMENT_ID,
        sourceArtifactId: OBSERVATION_CONTEXT.sourceArtifactId,
        pageRepresentationDigestByPage: { [PRICED_PAGE]: pageDigest },
      },
    });
    const candidates = reconstruction.recovery_candidates ?? [];
    const tokens = page.lines.flatMap((line) => line.tokens);
    const proposal = buildDurableRecoveryProposalV2({
      organizationId: '70000000-0000-4000-8000-000000000106',
      extractionSnapshotId: 'dn-e2-snapshot',
      candidates: candidates.slice(0, 2),
      selectedCandidateId: candidates[0]!.candidateId,
      certainty: 0.7,
      reasonCategory: 'continuation_geometry',
      providerModel: 'fixture-model',
      promptTemplateId: 'fixture-template',
      promptTemplateVersion: '1',
    })!;
    const observationsLayer = buildPdfLayoutObservationsLayer({
      layout, reconstruction, context: OBSERVATION_CONTEXT,
    });
    const { [E2_LAYER_SIDECAR_KEY]: _sidecar, ...layerWithoutSidecar } =
      observationsLayer as Record<string, unknown>;
    const actual = {
      pageRepresentationDigest: pageDigest,
      candidateCount: candidates.length,
      candidateIds: candidates.map((candidate) => candidate.candidateId),
      candidateDigestsHash: hashCanonical(candidates.map((candidate) => recoveryCandidateDigest(candidate))),
      proposalId: proposal.proposalId,
      proposalDigest: proposal.proposalDigestSha256,
      observationIdsHash: hashCanonical(tokens.map((token) => token.observation_id ?? null)),
      sourceTokenGeometryHash: hashCanonical(tokens.map((token) => ({
        text: token.text, x: token.x, y: token.y, width: token.width, height: token.height,
      }))),
      reconstructionHash: hashCanonical({ ...reconstruction, recovery_candidates: undefined }),
      observationLayerHashWithoutE2Sidecar: hashCanonical(layerWithoutSidecar),
      closureStatus: observationsLayer.closure.status,
    };
    if (process.env.E2_PRINT_IDENTITY_BASELINE === '1') {
      console.log(`E2BASELINE ${JSON.stringify(actual)}`);
    }
    expect(actual.candidateCount).toBe(26);
    expect(actual).toEqual(PRE_E2_DN_BASELINE);
  }, 240_000);
});
