/** Provider-free Phase B-prime replay preflight and immutable review-packet writer. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { canonicalJson, hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { prepareForgewingPricingProposalV2,
  type ForgewingPricingProposalV2Preparation } from
  '@/scripts/evaluation/prepareForgewingPricingProposalV2';
import type { ForgewingPricingProposalV2PhaseBReport } from
  '@/scripts/evaluation/runForgewingPricingProposalV2PhaseB';
import type { ForgewingPricingCorpusEntry } from '@/scripts/evaluation/runForgewingPricingCorpus';

export const PHASE_B_ACCEPTED_ARTIFACT_SHA256 =
  '641b52f5ed55152b22c6338d283eecf0ad41671f066e2bdab0835b37733c798a';
export const PHASE_B_ACCEPTED_REPORT_DIGEST_SHA256 =
  '4b2c48410b5656457ae5d9f806e6f216bd52c8d3d4aab80753170a6bf198f936';
export const PHASE_B_ACCEPTED_IMPLEMENTATION_COMMIT =
  'f13c815b2bdb386353f008f8d56c5622407d8aec';
export const V2_HUMAN_REVIEW_PACKET_VERSION =
  'forgewing-pricing-v2-human-review-packet-v1' as const;

const DEFAULT_ACCEPTED_ARTIFACT = join(process.cwd(), 'scripts', 'evaluation', 'artifacts',
  'local-v2-phase-b', 'phase-b-f13c815.json');

type PhaseBReport = ForgewingPricingProposalV2PhaseBReport;

function fail(code: string): never { throw new Error(code); }

function parseAcceptedReport(bytes: Buffer): PhaseBReport {
  let value: unknown;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { fail('V2_BPRIME_ARTIFACT_JSON_INVALID'); }
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    fail('V2_BPRIME_ARTIFACT_CONTRACT_INVALID');
  }
  const report = value as Partial<PhaseBReport>;
  if (!Array.isArray(report.sources) || typeof report.reportDigestSha256 !== 'string'
    || report.implementation == null || typeof report.implementation.commit !== 'string') {
    fail('V2_BPRIME_ARTIFACT_CONTRACT_INVALID');
  }
  return report as PhaseBReport;
}

function verifyPreparationDigest(preparation: ForgewingPricingProposalV2Preparation): void {
  const { preparationDigestSha256, ...unsigned } = preparation;
  if (hashCanonical(unsigned) !== preparationDigestSha256) {
    fail('V2_BPRIME_PREPARATION_DIGEST_INVALID');
  }
}

function exactReplayIdentity(preparation: ForgewingPricingProposalV2Preparation): unknown {
  return {
    source: {
      sourceSha256: preparation.source.sourceSha256,
      sourceByteLength: preparation.source.sourceByteLength,
      sourceDocumentId: preparation.source.sourceDocumentId,
      sourceArtifactId: preparation.source.sourceArtifactId,
      extractionSnapshotId: preparation.source.extractionSnapshotId,
      physicalPageCount: preparation.source.physicalPageCount,
    },
    preparationDigestSha256: preparation.preparationDigestSha256,
    candidateDigestSha256: preparation.v1Compatibility.candidateDigestSha256,
    rows: preparation.rows.map((row) => ({
      candidateId: row.candidateId,
      rowObservationId: row.rowObservationId,
      context: row.context,
      fields: row.fields.map(({ field }) => ({
        sourceFieldId: field.sourceFieldId,
        sourceFieldRole: field.sourceFieldRole,
        sourceObservationIds: [...field.sourceObservationIds].sort((left, right) =>
          left.localeCompare(right, 'en-US')),
        physicalPageNumber: field.physicalPageNumber,
      })).sort((left, right) => left.sourceFieldId.localeCompare(right.sourceFieldId, 'en-US')),
    })).sort((left, right) => left.rowObservationId.localeCompare(right.rowObservationId, 'en-US')),
  };
}

export function buildForgewingPricingProposalV2HumanReviewPacket(params: {
  acceptedArtifactBytes: Buffer;
  replayPreparations: readonly ForgewingPricingProposalV2Preparation[];
  expectedArtifactSha256?: string;
  expectedReportDigestSha256?: string;
  expectedImplementationCommit?: string;
  labelWorkflowImplementationCommit?: string;
}): Readonly<Record<string, unknown>> {
  const artifactSha256 = sha256Hex(params.acceptedArtifactBytes);
  if (artifactSha256 !== (params.expectedArtifactSha256 ?? PHASE_B_ACCEPTED_ARTIFACT_SHA256)) {
    fail('V2_BPRIME_ARTIFACT_SHA256_MISMATCH');
  }
  const accepted = parseAcceptedReport(params.acceptedArtifactBytes);
  const { reportDigestSha256, ...unsignedReport } = accepted;
  if (hashCanonical(unsignedReport) !== reportDigestSha256
    || reportDigestSha256 !== (params.expectedReportDigestSha256
      ?? PHASE_B_ACCEPTED_REPORT_DIGEST_SHA256)) {
    fail('V2_BPRIME_REPORT_DIGEST_MISMATCH');
  }
  if (accepted.implementation.commit !== (params.expectedImplementationCommit
    ?? PHASE_B_ACCEPTED_IMPLEMENTATION_COMMIT)) {
    fail('V2_BPRIME_ACCEPTED_IMPLEMENTATION_MISMATCH');
  }
  if (accepted.providerCalls !== 0 || accepted.promotionAuthorized !== false
    || accepted.promotionEvidence !== false || accepted.sources.length !== 2
    || params.replayPreparations.length !== accepted.sources.length) {
    fail('V2_BPRIME_ACCEPTED_SCOPE_INVALID');
  }

  for (let index = 0; index < accepted.sources.length; index += 1) {
    const expected = accepted.sources[index]!.preparation;
    const replay = params.replayPreparations[index]!;
    verifyPreparationDigest(expected);
    verifyPreparationDigest(replay);
    if (expected.v1Compatibility.orderingDeterministic !== true
      || replay.v1Compatibility.orderingDeterministic !== true) {
      fail('V2_BPRIME_ORDERING_NONDETERMINISTIC');
    }
    if (canonicalJson(exactReplayIdentity(expected)) !== canonicalJson(exactReplayIdentity(replay))) {
      fail('V2_BPRIME_SOURCE_REPLAY_DRIFT');
    }
  }

  const rows = params.replayPreparations.flatMap((source) => source.rows);
  const fields = rows.flatMap((row) => row.fields);
  const memberObservationIds = fields.flatMap(({ field }) => field.sourceObservationIds);
  const packetBase = {
    packetVersion: V2_HUMAN_REVIEW_PACKET_VERSION,
    proposalVersion: accepted.proposalVersion,
    authority: 'evaluation_ground_truth_only' as const,
    providerCalls: 0 as const,
    promotionAuthorized: false as const,
    promotionEvidence: false as const,
    preparationArtifact: { sha256: artifactSha256, reportDigestSha256,
      implementationCommit: accepted.implementation.commit },
    labelWorkflowImplementationCommit: params.labelWorkflowImplementationCommit
      ?? PHASE_B_ACCEPTED_IMPLEMENTATION_COMMIT,
    scope: { sourceCount: params.replayPreparations.length, rowCount: rows.length,
      fieldCount: fields.length, memberObservationCount: memberObservationIds.length },
    sources: params.replayPreparations.map((source) => ({
      source: { sourceSha256: source.source.sourceSha256,
        sourceByteLength: source.source.sourceByteLength,
        sourceDocumentId: source.source.sourceDocumentId,
        sourceArtifactId: source.source.sourceArtifactId,
        extractionSnapshotId: source.source.extractionSnapshotId,
        physicalPageCount: source.source.physicalPageCount },
      preparationDigestSha256: source.preparationDigestSha256,
      orderingDeterministic: source.v1Compatibility.orderingDeterministic,
      rows: source.rows,
    })),
    reviewStatus: 'not_started' as const,
  };
  return { ...packetBase, packetDigestSha256: hashCanonical(packetBase) };
}

export async function prepareForgewingPricingProposalV2HumanReview(params: {
  acceptedArtifactPath: string;
  outputPath: string;
  entries: readonly ForgewingPricingCorpusEntry[];
  labelWorkflowImplementationCommit?: string;
}): Promise<Readonly<{ path: string; sha256: string; packet: Readonly<Record<string, unknown>> }>> {
  const acceptedArtifactPath = resolve(params.acceptedArtifactPath);
  const bytes = readFileSync(acceptedArtifactPath);
  const replayPreparations: ForgewingPricingProposalV2Preparation[] = [];
  for (const entry of params.entries) replayPreparations.push(await prepareForgewingPricingProposalV2(entry));
  const packet = buildForgewingPricingProposalV2HumanReviewPacket({
    acceptedArtifactBytes: bytes, replayPreparations,
    labelWorkflowImplementationCommit: params.labelWorkflowImplementationCommit,
  });
  const written = writeForgewingPricingProposalV2HumanReviewPacket({
    outputPath: params.outputPath, packet,
  });
  return { ...written, packet };
}

export function writeForgewingPricingProposalV2HumanReviewPacket(params: {
  outputPath: string;
  packet: Readonly<Record<string, unknown>>;
}): Readonly<{ path: string; sha256: string }> {
  const outputPath = resolve(params.outputPath);
  const outputBytes = `${canonicalJson(params.packet)}\n`;
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, outputBytes, { encoding: 'utf8', flag: 'wx' });
  if (readFileSync(outputPath, 'utf8') !== outputBytes) {
    fail('V2_BPRIME_REVIEW_PACKET_PERSISTENCE_VERIFICATION_FAILED');
  }
  return { path: outputPath, sha256: sha256Hex(Buffer.from(outputBytes)) };
}

function exactEntriesFromEnvironment(): readonly ForgewingPricingCorpusEntry[] {
  const tdot = process.env.TDOT_PHASE1_SOURCE_PDF?.trim();
  const dn = process.env.DN_PRICED_SCHEDULE_SOURCE_PDF?.trim();
  if (!tdot || !dn) fail('V2_BPRIME_SOURCE_ENV_REQUIRED');
  return [
    { sourcePdfPath: tdot, corpusKind: 'real_unlabelled_smoke', documentType: 'contract',
      expectedSourceSha256: '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a',
      authoritativeRatePageRanges: [{ start: 46, end: 46 }] },
    { sourcePdfPath: dn, corpusKind: 'real_unlabelled_smoke', documentType: 'contract',
      expectedSourceSha256: '69247bff02744276b75f2cb0d4c00610e8614bd5822d2d10ae2ad35564c3b272',
      authoritativeRatePageRanges: [{ start: 106, end: 106 }] },
  ];
}

export async function main(): Promise<void> {
  const { values } = parseArgs({ strict: true, options: {
    artifact: { type: 'string' }, output: { type: 'string' },
  } });
  if (!values.output) fail('V2_BPRIME_OUTPUT_REQUIRED');
  const labelWorkflowImplementationCommit = process.env.V2_BPRIME_IMPLEMENTATION_COMMIT?.trim();
  if (!labelWorkflowImplementationCommit?.match(/^[a-f0-9]{40}$/)) {
    fail('V2_BPRIME_IMPLEMENTATION_COMMIT_REQUIRED');
  }
  const result = await prepareForgewingPricingProposalV2HumanReview({
    acceptedArtifactPath: values.artifact ?? DEFAULT_ACCEPTED_ARTIFACT,
    outputPath: values.output,
    entries: exactEntriesFromEnvironment(),
    labelWorkflowImplementationCommit,
  });
  process.stdout.write(`${result.path}\n${result.sha256}\n`);
}

if (process.env.FORGEWING_V2_BPRIME_PREPARE_CLI === '1') {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
