import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { parseLabelledPricingA3Ledger } from '@/lib/evaluation/forgewing/labelledPricingA3';
import { buildPreparedForgewingLabelAttestationTemplate } from
  '@/lib/evaluation/forgewing/labelledPricingAttestation';
import { parseForgewingLabelLinkageManifest } from
  '@/lib/evaluation/forgewing/labelledPricingLinkage';
import {
  buildForgewingLabelLinkageReviewInputTemplate,
  buildForgewingLabelLinkageReviewPacket,
  generateForgewingLabelLinkageManifestFromReview,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageReview';
import { prepareForgewingPricingCorpus } from '@/scripts/evaluation/runForgewingPricingCorpus';

const TDOT_SOURCE_SHA256 =
  '7e60675c7c1f6d41f58fd3d9e372f8abb2dd800896d1af266e2312250895e58a';
const TDOT_SOURCE_BYTE_LENGTH = 1_063_619;
const TDOT_SOURCE_PAGES = 46;
const TDOT_REVIEW_ROW_BINDINGS = Object.freeze([
  {
    candidateRowId: 'page_priced_schedule:p46:r24',
    legacyRowIdentity: 'source:p46:geometric-row:025',
  },
  {
    candidateRowId: 'page_priced_schedule:p46:r31',
    legacyRowIdentity: 'source:p46:geometric-row:032',
  },
] as const);

function writeJson(outputPath: string, value: unknown): string {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  return resolved;
}

export async function generateTdotForgewingLabelLinkageReviewArtifacts(params: {
  sourcePdfPath: string;
  ledgerPath: string;
  packetOutputPath: string;
  reviewInputOutputPath: string;
}): Promise<Readonly<{ packetPath: string; reviewInputPath: string }>> {
  const ledgerBytes = readFileSync(resolve(params.ledgerPath));
  const ledger = parseLabelledPricingA3Ledger(JSON.parse(ledgerBytes.toString('utf8')));
  if (ledger.source_pdf.sha256 !== TDOT_SOURCE_SHA256
    || ledger.source_pdf.byte_length !== TDOT_SOURCE_BYTE_LENGTH
    || ledger.source_pdf.pages !== TDOT_SOURCE_PAGES) {
    throw new Error('SOURCE_MISMATCH');
  }
  const preparation = await prepareForgewingPricingCorpus({
    sourcePdfPath: params.sourcePdfPath,
    optionalLabelPackagePath: params.ledgerPath,
    corpusKind: 'real_labelled_corpus',
    expectedSourceSha256: TDOT_SOURCE_SHA256,
    documentType: 'contract',
    authoritativeRatePageRanges: [{ start: 46, end: 46 }],
  });
  if (preparation.source.sourceSha256 !== TDOT_SOURCE_SHA256
    || preparation.source.sourceByteLength !== TDOT_SOURCE_BYTE_LENGTH) {
    throw new Error('SOURCE_MISMATCH');
  }
  const packet = buildForgewingLabelLinkageReviewPacket({
    ledgerBytes,
    source: {
      sourcePdfSha256: preparation.source.sourceSha256,
      sourceByteLength: preparation.source.sourceByteLength,
      sourcePages: TDOT_SOURCE_PAGES,
      sourceDocumentId: preparation.source.sourceDocumentId,
      sourceArtifactId: preparation.source.sourceArtifactId,
      extractionSnapshotId: preparation.source.extractionSnapshotId,
    },
    candidates: preparation.candidates,
    pricingLayoutObservations: preparation.pricingLayoutObservations,
    rowBindings: TDOT_REVIEW_ROW_BINDINGS,
  });
  const reviewInput = buildForgewingLabelLinkageReviewInputTemplate(packet);
  return {
    packetPath: writeJson(params.packetOutputPath, packet),
    reviewInputPath: writeJson(params.reviewInputOutputPath, reviewInput),
  };
}

export function generateForgewingLabelLinkageManifestArtifact(params: {
  packetPath: string;
  reviewInputPath: string;
  outputPath: string;
}): string {
  const packet = JSON.parse(readFileSync(resolve(params.packetPath), 'utf8')) as unknown;
  const reviewInput = JSON.parse(readFileSync(resolve(params.reviewInputPath), 'utf8')) as unknown;
  const result = generateForgewingLabelLinkageManifestFromReview({ packet, reviewInput });
  if (result.status !== 'manifest_ready' || !result.manifest) {
    throw new Error(`forgewing_label_linkage_${result.status}:${result.failureReasons.join(',')}`);
  }
  return writeJson(params.outputPath, result.manifest);
}

export function generatePreparedForgewingLabelAttestationArtifact(params: {
  ledgerPath: string;
  linkageManifestPath: string;
  outputPath: string;
}): string {
  const ledgerBytes = readFileSync(resolve(params.ledgerPath));
  const linkageManifestBytes = readFileSync(resolve(params.linkageManifestPath));
  const manifest = parseForgewingLabelLinkageManifest(
    JSON.parse(linkageManifestBytes.toString('utf8')),
  );
  const template = buildPreparedForgewingLabelAttestationTemplate({
    ledgerBytes,
    linkageManifestBytes,
    labelObservationIds: manifest.records.map((record) => record.label_observation_id),
  });
  return writeJson(params.outputPath, template);
}

export async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2), strict: true,
    options: {
      mode: { type: 'string' }, source: { type: 'string' }, ledger: { type: 'string' },
      packet: { type: 'string' }, review: { type: 'string' }, output: { type: 'string' },
      'packet-output': { type: 'string' }, 'review-output': { type: 'string' },
      linkage: { type: 'string' },
    },
  });
  if (values.mode === 'prepare-review') {
    if (!values.source || !values.ledger || !values['packet-output'] || !values['review-output']) {
      throw new Error('forgewing_label_review_missing_required_argument');
    }
    const paths = await generateTdotForgewingLabelLinkageReviewArtifacts({
      sourcePdfPath: values.source,
      ledgerPath: values.ledger,
      packetOutputPath: values['packet-output'],
      reviewInputOutputPath: values['review-output'],
    });
    process.stdout.write(`${paths.packetPath}\n${paths.reviewInputPath}\n`);
    return;
  }
  if (values.mode === 'manifest') {
    if (!values.packet || !values.review || !values.output) {
      throw new Error('forgewing_label_review_missing_required_argument');
    }
    process.stdout.write(`${generateForgewingLabelLinkageManifestArtifact({
      packetPath: values.packet, reviewInputPath: values.review, outputPath: values.output,
    })}\n`);
    return;
  }
  if (values.mode === 'prepare-attestation') {
    if (!values.ledger || !values.linkage || !values.output) {
      throw new Error('forgewing_label_review_missing_required_argument');
    }
    process.stdout.write(`${generatePreparedForgewingLabelAttestationArtifact({
      ledgerPath: values.ledger,
      linkageManifestPath: values.linkage,
      outputPath: values.output,
    })}\n`);
    return;
  }
  throw new Error('forgewing_label_review_invalid_mode');
}

if (process.env.FORGEWING_LABEL_LINKAGE_REVIEW_CLI === '1'
  || process.argv.some((value) => value.replaceAll('\\', '/')
    .endsWith('generateForgewingLabelLinkageReview.ts'))) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
