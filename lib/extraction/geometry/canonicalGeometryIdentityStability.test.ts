import { describe, expect, it } from 'vitest';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import { buildSyntheticPdf, type SyntheticPage } from '@/lib/extraction/geometry/__fixtures__/syntheticPdf';
import { loadPdfLayout, type PdfLayout } from '@/lib/extraction/pdf/extractText';
import {
  buildPdfLayoutObservationsLayer,
  resolvePdfLayoutDiagnosticEvidence,
  resolvePdfLayoutObservationEvidence,
} from '@/lib/extraction/pdf/layoutObservationEvidence';
import { mergeOcrFallbackLayout, type OcrGeometryPage } from '@/lib/extraction/pdf/ocrGeometryLayout';
import { buildPagePricedScheduleReconstruction } from '@/lib/extraction/pdf/pagePricedScheduleReconstruction';
import { recoveryCandidateDigest } from '@/lib/extraction/recovery/recoveryCandidateV2';
import type { ForgewingPricingRateClusterRecoveryBundle } from '@/lib/forgewing/tasks/pricingRateClusterRecovery';
import {
  buildDurableRecoveryProposalV2,
  recoveryProposalDigest,
} from '@/lib/server/forgewingRecoveryProposalPersistence';

/**
 * E2 identity stability.
 *
 * Canonical geometry is additive. Every value below was recorded from the
 * pre-E2 code path (origin/main d5fb4ad, before any canonical geometry was
 * wired in) over real pdf.js-parsed bytes, and must stay byte-identical after
 * E2: observation IDs, page representation digests, source token geometry,
 * reconstruction output, recovery candidate IDs and digests, V2 proposal
 * IDs/digests, V1 proposal digests, and layout-observation exact-match closure.
 *
 * The rotated and cropped scenarios matter most: they are exactly where E2
 * changes geometry semantics, and exactly where identity must not move.
 */

const CONTEXT = {
  sourceDocumentId: '11111111-1111-4111-8111-111111111111',
  sourceArtifactId: '22222222-2222-4222-8222-222222222222',
} as const;
const ORG = '33333333-3333-4333-8333-333333333333';
/** The E2 sidecar key; it must be the only thing E2 adds to the observation layer. */
const E2_LAYER_SIDECAR_KEY = 'canonical_geometry_v1';

const RUNS: SyntheticPage['runs'] = [
  { text: 'Description', x: 50, y: 700 }, { text: 'Unit of Measure', x: 200, y: 700 },
  { text: 'Origin/ Destination', x: 300, y: 700 }, { text: 'Cost', x: 450, y: 700 },
  { text: 'Inert Debris Removal and', x: 50, y: 660 }, { text: 'Ton', x: 200, y: 660 },
  { text: 'A to B', x: 300, y: 660 }, { text: '$', x: 450, y: 660 }, { text: '12.00', x: 470, y: 660 },
  { text: 'Disposal', x: 50, y: 630 },
  { text: 'Vegetative Debris', x: 50, y: 600 }, { text: 'Ton', x: 200, y: 600 },
  { text: 'A to B', x: 300, y: 600 }, { text: '$', x: 450, y: 600 }, { text: '3.50', x: 470, y: 600 },
  { text: 'Gamma service', x: 50, y: 560 }, { text: 'Widget', x: 200, y: 560 },
  { text: 'Yard to Depot', x: 300, y: 560 }, { text: '$', x: 450, y: 560 }, { text: '8.75', x: 470, y: 560 },
  { text: '$', x: 530, y: 560 }, { text: '52.50', x: 548, y: 560 },
];

/** OCR over a 2x render of the unrotated page: one duplicate of native text, one OCR-only stamp. */
const OCR_PAGE: OcrGeometryPage = {
  page_number: 1,
  width: 1224,
  height: 1584,
  representation_key: 'e2-identity-fixture',
  words: [
    { text: 'Disposal', confidence: 91, parser_path: '0.0.0.0', bbox: { x0: 100, y0: 308, x1: 161, y1: 324 } },
    { text: 'APPROVED', confidence: 88, parser_path: '1.0.0.0', bbox: { x0: 900, y0: 40, x1: 1100, y1: 70 } },
  ],
};

type Scenario = Readonly<{ name: string; page: SyntheticPage; ocr: boolean }>;

const SCENARIOS: readonly Scenario[] = [
  { name: 'rotate0_mixed_ocr', page: { mediaBox: [0, 0, 612, 792], runs: RUNS }, ocr: true },
  {
    name: 'rotate90_cropped',
    page: { mediaBox: [0, 0, 612, 792], cropBox: [20, 30, 600, 780], rotate: 90, runs: RUNS },
    ocr: false,
  },
  { name: 'rotate270', page: { mediaBox: [0, 0, 612, 792], rotate: 270, runs: RUNS }, ocr: false },
];

async function run(scenario: Scenario) {
  const native = await loadPdfLayout(buildSyntheticPdf([scenario.page]), { observationIdentity: CONTEXT });
  const layout: PdfLayout = scenario.ocr
    ? mergeOcrFallbackLayout({
        nativeLayout: native,
        ocrPages: [OCR_PAGE],
        ocrTextPageNumbers: [1],
        observationIdentity: CONTEXT,
        representation: 'reconciled_pdf_points',
      }).layout
    : native;
  const page = layout.pages[0]!;
  const digest = page.effective_representation_digest!;
  const reconstruction = buildPagePricedScheduleReconstruction({
    layout,
    recoveryCandidateBuildContext: { ...CONTEXT, pageRepresentationDigestByPage: { 1: digest } },
  });
  const candidates = reconstruction.recovery_candidates ?? [];
  const tokens = page.lines.flatMap((line) => line.tokens);
  const proposalsV2 = (['pricing_rate_multi_observation_cluster', 'priced_schedule_continuation_attribution'] as const)
    .map((recoveryType) => {
      const group = candidates.filter((candidate) => candidate.recoveryType === recoveryType);
      const proposal = buildDurableRecoveryProposalV2({
        organizationId: ORG,
        extractionSnapshotId: 'snapshot-e2',
        candidates: group,
        selectedCandidateId: group[0]!.candidateId,
        certainty: 0.8,
        reasonCategory: 'explicit_currency_marker',
        providerModel: 'fixture-model',
        promptTemplateId: 'fixture-template',
        promptTemplateVersion: '1',
      })!;
      return { recoveryType, proposalId: proposal.proposalId, digest: proposal.proposalDigestSha256 };
    });
  const observationsLayer = buildPdfLayoutObservationsLayer({ layout, reconstruction, context: CONTEXT });
  const bindingContext = { ...CONTEXT, totalPhysicalPages: layout.page_count };
  const resolved = resolvePdfLayoutObservationEvidence({
    reconstruction, persistedLayer: JSON.parse(JSON.stringify(observationsLayer)), context: bindingContext,
  });
  const diagnostics = resolvePdfLayoutDiagnosticEvidence({
    reconstruction,
    persistedLayer: JSON.parse(JSON.stringify(observationsLayer)),
    context: bindingContext,
    reason: 'ambiguous_rate_clusters',
  });
  const v1Evidence = diagnostics[0]!.observations.map((observation) => ({
    observationId: observation.id,
    sourceDocumentId: observation.source_document_id,
    sourceArtifactId: observation.source_artifact_id,
    physicalPageNumber: observation.physical_page_number,
    artifactLocalIndex: observation.physical_page_number - 1,
    sourceLayer: observation.source_method === 'pdfjs' ? 'pdf_native_text' as const : 'ocr' as const,
    rawText: observation.raw_text,
    boundingBox: {
      xMin: observation.location.bounding_box!.x_min, xMax: observation.location.bounding_box!.x_max,
      yMin: observation.location.bounding_box!.y_min, yMax: observation.location.bounding_box!.y_max,
    },
  }));
  const v1Digest = recoveryProposalDigest({
    schemaVersion: 'forgewing-pricing-rate-cluster-recovery-v1',
    authority: 'non_authoritative',
    run: { runId: 'run', organizationId: ORG, extractionSnapshotId: 'snapshot-e2', inputSnapshotHash: 'b'.repeat(64) },
    taskId: 'task',
    taskType: 'pricing_rate_cluster_recovery',
    proposals: [{
      proposalId: 'proposal', taskId: 'task', taskType: 'pricing_rate_cluster_recovery',
      status: 'recovered_candidate', authority: 'non_authoritative', proposedField: 'rate',
      proposedValue: '8.75', normalizedValue: '8.75', ...CONTEXT, extractionSnapshotId: 'snapshot-e2',
      physicalPageNumber: 1, selectedObservationIds: [v1Evidence[0]!.observationId],
      alternativeObservationIds: v1Evidence.slice(1).map((entry) => entry.observationId),
      evidence: v1Evidence, certainty: 0.8, reasonCategory: 'explicit_currency_marker', requiresHumanReview: true,
    }],
    abstentions: [],
  } as unknown as ForgewingPricingRateClusterRecoveryBundle);
  const { [E2_LAYER_SIDECAR_KEY]: _sidecar, ...layerWithoutSidecar } = observationsLayer as Record<string, unknown>;
  return {
    pageRepresentationDigest: digest,
    observationIdsHash: hashCanonical(tokens.map((token) => token.observation_id ?? null)),
    sourceTokenGeometryHash: hashCanonical(tokens.map((token) => ({
      text: token.text, x: token.x, y: token.y, width: token.width, height: token.height,
      source: token.source ?? null, ocr_source_geometry: token.ocr_source_geometry ?? null,
    }))),
    reconstructionHash: hashCanonical({ ...reconstruction, recovery_candidates: undefined }),
    candidateIds: candidates.map((candidate) => candidate.candidateId),
    candidateDigests: candidates.map((candidate) => recoveryCandidateDigest(candidate)),
    proposalsV2,
    v1ProposalDigest: v1Digest,
    observationsHash: hashCanonical(observationsLayer.observations),
    observationLayerHashWithoutE2Sidecar: hashCanonical(layerWithoutSidecar),
    closureStatus: observationsLayer.closure.status,
    resolvedObservationCount: resolved?.length ?? null,
    diagnosticEvidenceCount: diagnostics.length,
  };
}

/** Recorded from origin/main d5fb4ad before E2 wiring. Do not regenerate to make a failure pass. */
const PRE_E2_BASELINE: Record<string, unknown> = {
  rotate0_mixed_ocr: {
    pageRepresentationDigest: '873a3403fcc527066cf371b4fe108bc73830c553572ab68cfc6229c84975fe9b',
    observationIdsHash: '81297277b71b20e7d44ab7f1cc46f0293355561c01392bd1cf0a6174beb51cf0',
    sourceTokenGeometryHash: '7140dae19f05e5d919ed21ae0382554ad83c72183cc01feb1c3585ea79e0eafc',
    reconstructionHash: '8f8e16c1cd54a869fcba6c728cb855c8b4f22ac67259cb473a094d083b8e0479',
    candidateIds: [
      'recovery-candidate-v2-8e755a648fb1036dfdfbed2a5df0c31d22604e05d88d7c6393373c72e5c046f5',
      'recovery-candidate-v2-990fbdaf44ef75c4916686823b71bd7fcceaa0be565d8fc4468b1051524d7349',
      'recovery-candidate-v2-af125fd5968e8c40fd55a020170ae383336fb00d61d828e9606cb8bf022b6c16',
      'recovery-candidate-v2-f2e2733bd312054a01d6f0ccf65b8d0e7c4731a680c75e9bd199d13247fb178a'
    ],
    candidateDigests: [
      '4337aa1a802f353da9837b454c050eb084717c7630cf519f177f270ffbe03bee',
      '1ce990ceb3ff5a01182978f248d3ca6c6e2b4fd83ff87a5451b1c1ebbd5aae10',
      '9ae8e64eae8e8fac44bdb5a4e5bfb3978f3cf1afccdd4b2d23a7ac6284a7b371',
      '768a136b13bcfdacd64bcd67d4a783b35c02693d56a813c5ee2d38b628bae636'
    ],
    proposalsV2: [
      {
        recoveryType: 'pricing_rate_multi_observation_cluster',
        proposalId: 'forgewing-proposal-recovery-v2-e8b3dc9eb8287760343a80ad203b0e53b3391ef4222e6f2c2b867f40626910b2',
        digest: 'e8b3dc9eb8287760343a80ad203b0e53b3391ef4222e6f2c2b867f40626910b2'
      },
      {
        recoveryType: 'priced_schedule_continuation_attribution',
        proposalId: 'forgewing-proposal-recovery-v2-9c56f5033ad3df04113ba36612fc4a64638f9ba4bf8add436f891c44da064c24',
        digest: '9c56f5033ad3df04113ba36612fc4a64638f9ba4bf8add436f891c44da064c24'
      }
    ],
    v1ProposalDigest: 'c6be947d3db0937e9473c48e2ade952d7732f227bb497ab58c7a476a4d7531bb',
    observationsHash: '3388f9759365ed8ff9a5f943c06327caa01b12ed327c76c46847725f3b163048',
    observationLayerHashWithoutE2Sidecar: '4f181ef547879e418fd26f44a60af35469902aa05aeb9a97c855007af9464453',
    closureStatus: 'complete',
    resolvedObservationCount: 10,
    diagnosticEvidenceCount: 1
  },
  rotate90_cropped: {
    pageRepresentationDigest: '943f4f1d70d1f35f135a4006bf57401f26971ba2cb1d63392ea58bd12c929450',
    observationIdsHash: '91f0908fb5157440247e94c07f6e4387b4afb3dfc707061369100e8cfaf27137',
    sourceTokenGeometryHash: '21a25d3cc82b641126740515877848a1f947ee5031d1d7394bee9093d78329ce',
    reconstructionHash: '8f8e16c1cd54a869fcba6c728cb855c8b4f22ac67259cb473a094d083b8e0479',
    candidateIds: [
      'recovery-candidate-v2-0f730a3728cab0579d4999ff4426b1db09221b6a5e14239541e3917edc9e5f1e',
      'recovery-candidate-v2-2cf51aff27a2fa3b50aa4b8b2433014af6fb033970e0fb07789eb63e05ffbe29',
      'recovery-candidate-v2-2f3a87106a5569d1b356a00ed9d8dbb0b9b73d8b1f8787c16e407338ea4395aa',
      'recovery-candidate-v2-b3b42b4fc1ab8b38c9202dbcbc526237f0543a39c8d7e11eadd77bf57691e037'
    ],
    candidateDigests: [
      '118f24004e24349c9c71233f6d16557406da302c3350d33f345a7449bb4f42ba',
      'a90033d4e15e5ec1d4e21797dcd03e45c27b2c448c63c5737008c9ed34a372fa',
      '3b6be8a21804ae34c08d80df7a169f3beb179d3ea0201c5f469b7679f83feecb',
      '7e06ae486b3753726b83edf7b9e48dc64c99978f582bf40ed669139075810ac2'
    ],
    proposalsV2: [
      {
        recoveryType: 'pricing_rate_multi_observation_cluster',
        proposalId: 'forgewing-proposal-recovery-v2-066ee1a310b96b95157f8506a51f7aa411fdb063e77dbf99f8f01a4e418f695e',
        digest: '066ee1a310b96b95157f8506a51f7aa411fdb063e77dbf99f8f01a4e418f695e'
      },
      {
        recoveryType: 'priced_schedule_continuation_attribution',
        proposalId: 'forgewing-proposal-recovery-v2-174c3b1c899dd9330342926dcea0923f38a12df24cf373688636987f13af60e4',
        digest: '174c3b1c899dd9330342926dcea0923f38a12df24cf373688636987f13af60e4'
      }
    ],
    v1ProposalDigest: 'c6be947d3db0937e9473c48e2ade952d7732f227bb497ab58c7a476a4d7531bb',
    observationsHash: '3388f9759365ed8ff9a5f943c06327caa01b12ed327c76c46847725f3b163048',
    observationLayerHashWithoutE2Sidecar: 'b41100286918bd96a494619884198f6ab9e265259d201e05ab41a086845b4156',
    closureStatus: 'complete',
    resolvedObservationCount: 10,
    diagnosticEvidenceCount: 1
  },
  rotate270: {
    pageRepresentationDigest: '943f4f1d70d1f35f135a4006bf57401f26971ba2cb1d63392ea58bd12c929450',
    observationIdsHash: '91f0908fb5157440247e94c07f6e4387b4afb3dfc707061369100e8cfaf27137',
    sourceTokenGeometryHash: '21a25d3cc82b641126740515877848a1f947ee5031d1d7394bee9093d78329ce',
    reconstructionHash: '8f8e16c1cd54a869fcba6c728cb855c8b4f22ac67259cb473a094d083b8e0479',
    candidateIds: [
      'recovery-candidate-v2-0f730a3728cab0579d4999ff4426b1db09221b6a5e14239541e3917edc9e5f1e',
      'recovery-candidate-v2-2cf51aff27a2fa3b50aa4b8b2433014af6fb033970e0fb07789eb63e05ffbe29',
      'recovery-candidate-v2-2f3a87106a5569d1b356a00ed9d8dbb0b9b73d8b1f8787c16e407338ea4395aa',
      'recovery-candidate-v2-b3b42b4fc1ab8b38c9202dbcbc526237f0543a39c8d7e11eadd77bf57691e037'
    ],
    candidateDigests: [
      '118f24004e24349c9c71233f6d16557406da302c3350d33f345a7449bb4f42ba',
      'a90033d4e15e5ec1d4e21797dcd03e45c27b2c448c63c5737008c9ed34a372fa',
      '3b6be8a21804ae34c08d80df7a169f3beb179d3ea0201c5f469b7679f83feecb',
      '7e06ae486b3753726b83edf7b9e48dc64c99978f582bf40ed669139075810ac2'
    ],
    proposalsV2: [
      {
        recoveryType: 'pricing_rate_multi_observation_cluster',
        proposalId: 'forgewing-proposal-recovery-v2-066ee1a310b96b95157f8506a51f7aa411fdb063e77dbf99f8f01a4e418f695e',
        digest: '066ee1a310b96b95157f8506a51f7aa411fdb063e77dbf99f8f01a4e418f695e'
      },
      {
        recoveryType: 'priced_schedule_continuation_attribution',
        proposalId: 'forgewing-proposal-recovery-v2-174c3b1c899dd9330342926dcea0923f38a12df24cf373688636987f13af60e4',
        digest: '174c3b1c899dd9330342926dcea0923f38a12df24cf373688636987f13af60e4'
      }
    ],
    v1ProposalDigest: 'c6be947d3db0937e9473c48e2ade952d7732f227bb497ab58c7a476a4d7531bb',
    observationsHash: '3388f9759365ed8ff9a5f943c06327caa01b12ed327c76c46847725f3b163048',
    observationLayerHashWithoutE2Sidecar: 'b41100286918bd96a494619884198f6ab9e265259d201e05ab41a086845b4156',
    closureStatus: 'complete',
    resolvedObservationCount: 10,
    diagnosticEvidenceCount: 1
  }
};

describe('E2 canonical geometry leaves evidence identity byte-identical', () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name}: every ID, digest and exact-match check equals the pre-E2 baseline`, async () => {
      const actual = await run(scenario);
      if (process.env.E2_PRINT_IDENTITY_BASELINE === '1') {
        console.log(`E2BASELINE ${JSON.stringify({ [scenario.name]: actual })}`);
      }
      expect(actual.candidateIds.length).toBeGreaterThanOrEqual(4);
      expect(actual.closureStatus).toBe('complete');
      expect(actual).toEqual(PRE_E2_BASELINE[scenario.name]);
    }, 60_000);
  }
});
