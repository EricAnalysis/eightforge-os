import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  completeA3WorkspaceAttestation,
  generateA3WorkspaceManifest,
  getA3WorkspaceAttestationState,
  prepareA3WorkspaceAttestation,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace.server';
import {
  createBlankA3WorkspaceDraft,
  setA3WorkspaceDecision,
  toggleA3WorkspaceObservation,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace';
import {
  forgewingLabelLinkageReviewPacketDigest,
  parseForgewingLabelLinkageReviewPacket,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageReview';

const ORIGINAL_PACKET = JSON.parse(readFileSync(join(
  process.cwd(), 'scripts', 'evaluation', 'artifacts', 'tdot-a3-linkage-review-packet.json',
), 'utf8')) as Record<string, unknown>;

const ENV_KEYS = [
  'A3_REVIEW_SOURCE_PDF', 'A3_REVIEW_LABEL_PACKAGE', 'A3_REVIEW_PACKET_PATH',
  'A3_REVIEW_TEMPLATE_PATH', 'A3_REVIEW_OUTPUT_DIRECTORY',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
let temporaryDirectory: string | null = null;

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = null;
});

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function setupSession() {
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'eightforge-a3-attestation-'));
  const outputDirectory = join(temporaryDirectory, 'output');
  const sourceBytes = Buffer.from('synthetic source bytes for attestation boundary tests', 'utf8');
  const originalLabels = (ORIGINAL_PACKET.labels as Array<Record<string, unknown>>);
  const sourceSha256 = sha256Hex(sourceBytes);
  const observations = originalLabels.map((rawLabel) => {
    const label = rawLabel as {
      label_observation_id: string;
      role: string;
      legacy_labelled_value: string;
      legacy_row_identity: string;
      physical_page: number;
      legacy_source_evidence: {
        bbox: { x_min: number; y_min: number; x_max: number; y_max: number };
        page_width_points: number;
        page_height_points: number;
      };
    };
    return {
      field_identifier: label.label_observation_id,
      source_pdf_sha256: sourceSha256,
      source_page: label.physical_page,
      bbox_x0: label.legacy_source_evidence.bbox.x_min,
      bbox_y0: label.legacy_source_evidence.bbox.y_min,
      bbox_x1: label.legacy_source_evidence.bbox.x_max,
      bbox_y1: label.legacy_source_evidence.bbox.y_max,
      page_width_points: label.legacy_source_evidence.page_width_points,
      page_height_points: label.legacy_source_evidence.page_height_points,
      exact_raw_text: label.legacy_labelled_value,
      raw_text_sha256: sha256Hex(label.legacy_labelled_value),
      interpreted_field_or_role: label.role,
      row_identity: label.legacy_row_identity,
    };
  });
  const ledger = {
    ledger_version: 'synthetic-attestation-boundary-v1',
    status: 'machine_generated',
    source_pdf: {
      sha256: sourceSha256,
      byte_length: sourceBytes.byteLength,
      pages: Math.max(...observations.map((observation) => observation.source_page)),
    },
    observations,
  };
  const ledgerBytes = jsonBytes(ledger);
  const packetBase = structuredClone(ORIGINAL_PACKET) as typeof ORIGINAL_PACKET & {
    label_package: { ledger_version: string; ledger_sha256: string; ledger_byte_length: number };
    source: { source_pdf_sha256: string; source_byte_length: number; source_pages: number };
    labels: Array<{
      legacy_raw_text_sha256: string;
      legacy_source_evidence: { source_pdf_sha256: string };
    }>;
  };
  delete (packetBase as Record<string, unknown>).packet_digest_sha256;
  packetBase.label_package = {
    ledger_version: ledger.ledger_version,
    ledger_sha256: sha256Hex(ledgerBytes),
    ledger_byte_length: ledgerBytes.byteLength,
  };
  packetBase.source.source_pdf_sha256 = sourceSha256;
  packetBase.source.source_byte_length = sourceBytes.byteLength;
  packetBase.source.source_pages = ledger.source_pdf.pages;
  packetBase.labels.forEach((label, index) => {
    label.legacy_raw_text_sha256 = observations[index]!.raw_text_sha256;
    label.legacy_source_evidence.source_pdf_sha256 = sourceSha256;
  });
  const packet = parseForgewingLabelLinkageReviewPacket({
    ...packetBase,
    packet_digest_sha256: forgewingLabelLinkageReviewPacketDigest(packetBase as never),
  });
  const sourcePath = join(temporaryDirectory, 'source.pdf');
  const ledgerPath = join(temporaryDirectory, 'ledger.json');
  const packetPath = join(temporaryDirectory, 'packet.json');
  const templatePath = join(temporaryDirectory, 'template.json');
  writeFileSync(sourcePath, sourceBytes);
  writeFileSync(ledgerPath, ledgerBytes);
  writeFileSync(packetPath, jsonBytes(packet));
  writeFileSync(templatePath, jsonBytes({
    review_packet_digest_sha256: packet.packet_digest_sha256,
  }));
  process.env.A3_REVIEW_SOURCE_PDF = sourcePath;
  process.env.A3_REVIEW_LABEL_PACKAGE = ledgerPath;
  process.env.A3_REVIEW_PACKET_PATH = packetPath;
  process.env.A3_REVIEW_TEMPLATE_PATH = templatePath;
  process.env.A3_REVIEW_OUTPUT_DIRECTORY = outputDirectory;

  let draft = createBlankA3WorkspaceDraft(packet);
  for (const label of packet.labels) {
    const selected = label.role === 'cost'
      ? label.modern_pdf_layout_token_observations.filter((observation) =>
          observation.raw_text === '$'
          || label.legacy_labelled_value.split(/\s+/).includes(observation.raw_text))
      : label.modern_pdf_layout_token_observations.filter((observation) =>
          observation.raw_text === label.legacy_labelled_value);
    for (const observation of selected) {
      draft = toggleA3WorkspaceObservation({
        draft,
        labelObservationId: label.label_observation_id,
        observationId: observation.observation_id,
      });
    }
    draft = setA3WorkspaceDecision({
      draft, labelObservationId: label.label_observation_id, decision: 'linked',
    }).draft;
  }
  expect(generateA3WorkspaceManifest(draft).ok).toBe(true);
  expect(prepareA3WorkspaceAttestation().ok).toBe(true);
  return {
    outputDirectory,
    sourcePath,
    ledgerPath,
    manifestPath: join(outputDirectory, 'forgewing-label-linkage.reviewed.json'),
    completedPath: join(outputDirectory, 'tdot-phase0-human-attestation.completed.json'),
  };
}

describe('A3 human attestation completion boundary', () => {
  it('generates reviewed_at server-side, validates the re-read artifact, and resumes unchanged', () => {
    const paths = setupSession();
    const completed = completeA3WorkspaceAttestation(
      { reviewer: 'Human.Reviewer', confirmed: true },
      { now: () => new Date('2026-08-24T16:20:30.000Z') },
    );
    expect(completed).toMatchObject({
      ok: true,
      reviewer: 'Human.Reviewer',
      reviewedAt: '2026-08-24T16:20:30.000Z',
      scopeKind: 'SCORING_SUBSET',
      scopeLabelCount: 6,
      authority: 'evaluation_ground_truth_only',
      promotionAuthorized: false,
    });
    const bytesBeforeReload = readFileSync(paths.completedPath);
    expect(getA3WorkspaceAttestationState()).toMatchObject({
      ok: true,
      status: {
        state: 'completed',
        reviewer: 'Human.Reviewer',
        reviewedAt: '2026-08-24T16:20:30.000Z',
        authority: 'evaluation_ground_truth_only',
        promotionAuthorized: false,
      },
    });
    expect(readFileSync(paths.completedPath)).toEqual(bytesBeforeReload);
  });

  it('rejects a linkage manifest whose exact bytes changed after preparation', () => {
    const paths = setupSession();
    const manifest = JSON.parse(readFileSync(paths.manifestPath, 'utf8'));
    writeFileSync(paths.manifestPath, Buffer.from(JSON.stringify(manifest), 'utf8'));
    expect(completeA3WorkspaceAttestation({ reviewer: 'reviewer', confirmed: true }))
      .toEqual({ ok: false, code: 'LINKAGE_MANIFEST_CHANGED' });
  });

  it('rejects label-package byte changes after preparation', () => {
    const paths = setupSession();
    writeFileSync(paths.ledgerPath, Buffer.concat([readFileSync(paths.ledgerPath), Buffer.from(' ')]));
    expect(completeA3WorkspaceAttestation({ reviewer: 'reviewer', confirmed: true }))
      .toEqual({ ok: false, code: 'LABEL_PACKAGE_CHANGED' });
  });

  it('rejects source byte changes after preparation', () => {
    const paths = setupSession();
    writeFileSync(paths.sourcePath, Buffer.concat([readFileSync(paths.sourcePath), Buffer.from(' ')]));
    expect(completeA3WorkspaceAttestation({ reviewer: 'reviewer', confirmed: true }))
      .toEqual({ ok: false, code: 'SOURCE_IDENTITY_CHANGED' });
  });

  it('rejects a tampered completed digest on resume', () => {
    const paths = setupSession();
    expect(completeA3WorkspaceAttestation({ reviewer: 'reviewer', confirmed: true }).ok).toBe(true);
    const completed = JSON.parse(readFileSync(paths.completedPath, 'utf8')) as {
      attestation_digest_sha256: string;
    };
    completed.attestation_digest_sha256 = hashCanonical({ tampered: true });
    writeFileSync(paths.completedPath, jsonBytes(completed));
    expect(getA3WorkspaceAttestationState())
      .toEqual({ ok: false, code: 'ATTESTATION_DIGEST_INVALID' });
  });

  it('does not silently fall back to prepared state for an invalid completed artifact', () => {
    const paths = setupSession();
    writeFileSync(paths.completedPath, Buffer.from('{invalid json', 'utf8'));
    expect(getA3WorkspaceAttestationState())
      .toEqual({ ok: false, code: 'ATTESTATION_VALIDATION_FAILED' });
  });
});
