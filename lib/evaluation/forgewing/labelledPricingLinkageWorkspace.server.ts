import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import { buildPreparedForgewingLabelAttestationTemplate } from
  '@/lib/evaluation/forgewing/labelledPricingAttestation';
import { parseForgewingLabelLinkageManifest } from
  '@/lib/evaluation/forgewing/labelledPricingLinkage';
import {
  forgewingLabelLinkageReviewPacketDigest,
  generateForgewingLabelLinkageManifestFromReview,
  parseForgewingLabelLinkageReviewPacket,
  type ForgewingLabelLinkageReviewPacket,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageReview';
import {
  a3WorkspaceDomainReviewInput,
  buildA3WorkspaceFreezeIdentity,
  restoreA3WorkspaceDraft,
  type A3WorkspaceDraft,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageWorkspace';

export type A3WorkspaceFailureCode =
  | 'CONFIGURATION_REQUIRED'
  | 'SOURCE_MISMATCH'
  | 'CANDIDATE_SET_CHANGED'
  | 'EXTRACTION_SNAPSHOT_CHANGED'
  | 'LABEL_PACKAGE_CHANGED'
  | 'REVIEW_SESSION_INVALID'
  | 'INVALID_EVIDENCE_SELECTION'
  | 'INCOMPLETE_REVIEW'
  | 'ARTIFACT_WRITE_FAILED';

export type A3WorkspaceSession = Readonly<{
  packet: ForgewingLabelLinkageReviewPacket;
  freezeIdentity: ReturnType<typeof buildA3WorkspaceFreezeIdentity>;
  sourceUrl: '/api/evaluation/forgewing/a3-linkage/source';
}>;

type LoadResult = Readonly<
  { ok: true; session: A3WorkspaceSession; sourceBytes: Buffer; ledgerBytes: Buffer }
  | { ok: false; code: A3WorkspaceFailureCode }
>;

const DEFAULT_PACKET_PATH = join(
  process.cwd(), 'scripts', 'evaluation', 'artifacts', 'tdot-a3-linkage-review-packet.json',
);
const DEFAULT_TEMPLATE_PATH = join(
  process.cwd(), 'scripts', 'evaluation', 'artifacts',
  'tdot-a3-linkage-review-input.template.json',
);

export const A3_WORKSPACE_ERROR_COPY: Readonly<Record<A3WorkspaceFailureCode, string>> = {
  CONFIGURATION_REQUIRED: 'Evaluation source configuration is missing — review disabled.',
  SOURCE_MISMATCH: 'SOURCE MISMATCH — REVIEW DISABLED',
  CANDIDATE_SET_CHANGED: 'CANDIDATE SET CHANGED — REVIEW DISABLED',
  EXTRACTION_SNAPSHOT_CHANGED: 'EXTRACTION SNAPSHOT CHANGED — REVIEW SESSION INVALID',
  LABEL_PACKAGE_CHANGED: 'LABEL PACKAGE CHANGED — REVIEW DISABLED',
  REVIEW_SESSION_INVALID: 'REVIEW SESSION INVALID',
  INVALID_EVIDENCE_SELECTION: 'INVALID EVIDENCE SELECTION',
  INCOMPLETE_REVIEW: 'INCOMPLETE REVIEW',
  ARTIFACT_WRITE_FAILED: 'The local evaluation artifact could not be written.',
};

export function isA3WorkspaceEnabled(params: {
  nodeEnv?: string;
  featureFlag?: string;
  host?: string | null;
} = {}): boolean {
  const nodeEnv = params.nodeEnv ?? process.env.NODE_ENV;
  const featureFlag = params.featureFlag ?? process.env.ENABLE_A3_REVIEW_WORKSPACE;
  const rawHost = (params.host ?? 'localhost').toLowerCase();
  const host = rawHost.startsWith('[')
    ? rawHost.slice(1, rawHost.indexOf(']'))
    : rawHost.split(':')[0]!;
  return nodeEnv !== 'production'
    && featureFlag === '1'
    && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

function configuredFile(envName: string, fallback?: string): string | null {
  const supplied = process.env[envName]?.trim();
  const value = supplied || fallback;
  if (!value || !isAbsolute(value) || !existsSync(value) || !statSync(value).isFile()) return null;
  return resolve(value);
}

function parsePacket(bytes: Buffer): ForgewingLabelLinkageReviewPacket | null {
  try {
    const packet = parseForgewingLabelLinkageReviewPacket(JSON.parse(bytes.toString('utf8')));
    const { packet_digest_sha256: digest, ...unsigned } = packet;
    return forgewingLabelLinkageReviewPacketDigest(unsigned) === digest ? packet : null;
  } catch {
    return null;
  }
}

export function loadA3WorkspaceSession(): LoadResult {
  const sourcePath = configuredFile('A3_REVIEW_SOURCE_PDF');
  const ledgerPath = configuredFile('A3_REVIEW_LABEL_PACKAGE');
  const packetPath = configuredFile('A3_REVIEW_PACKET_PATH', DEFAULT_PACKET_PATH);
  const templatePath = configuredFile('A3_REVIEW_TEMPLATE_PATH', DEFAULT_TEMPLATE_PATH);
  if (!sourcePath || !ledgerPath || !packetPath || !templatePath) {
    return { ok: false, code: 'CONFIGURATION_REQUIRED' };
  }
  let packetBytes: Buffer;
  let sourceBytes: Buffer;
  let ledgerBytes: Buffer;
  let template: unknown;
  try {
    packetBytes = readFileSync(packetPath);
    sourceBytes = readFileSync(sourcePath);
    ledgerBytes = readFileSync(ledgerPath);
    template = JSON.parse(readFileSync(templatePath, 'utf8')) as unknown;
  } catch {
    return { ok: false, code: 'CONFIGURATION_REQUIRED' };
  }
  const packet = parsePacket(packetBytes);
  if (!packet) return { ok: false, code: 'REVIEW_SESSION_INVALID' };
  const templateDigest = template && typeof template === 'object'
    && 'review_packet_digest_sha256' in template
    ? (template as { review_packet_digest_sha256?: unknown }).review_packet_digest_sha256 : null;
  if (templateDigest !== packet.packet_digest_sha256) {
    return { ok: false, code: 'CANDIDATE_SET_CHANGED' };
  }
  if (sha256Hex(sourceBytes) !== packet.source.source_pdf_sha256
    || sourceBytes.byteLength !== packet.source.source_byte_length) {
    return { ok: false, code: 'SOURCE_MISMATCH' };
  }
  if (sha256Hex(ledgerBytes) !== packet.label_package.ledger_sha256
    || ledgerBytes.byteLength !== packet.label_package.ledger_byte_length) {
    return { ok: false, code: 'LABEL_PACKAGE_CHANGED' };
  }
  return {
    ok: true,
    session: {
      packet,
      freezeIdentity: buildA3WorkspaceFreezeIdentity(packet),
      sourceUrl: '/api/evaluation/forgewing/a3-linkage/source',
    },
    sourceBytes,
    ledgerBytes,
  };
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function artifactDirectory(): string {
  const configured = process.env.A3_REVIEW_OUTPUT_DIRECTORY?.trim();
  if (configured && isAbsolute(configured)) return resolve(configured);
  return join(process.cwd(), 'scripts', 'evaluation', 'artifacts', 'local-a3-review');
}

function writeArtifact(filename: string, bytes: Buffer): string {
  const directory = artifactDirectory();
  mkdirSync(directory, { recursive: true });
  const target = join(directory, filename);
  const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);
  writeFileSync(temporary, bytes);
  renameSync(temporary, target);
  return target;
}

export function evaluateA3WorkspaceDraft(draft: A3WorkspaceDraft) {
  const loaded = loadA3WorkspaceSession();
  if (!loaded.ok) return { ok: false as const, code: loaded.code };
  const expected = loaded.session.freezeIdentity;
  if (!draft || typeof draft !== 'object' || !draft.freezeIdentity) {
    return { ok: false as const, code: 'REVIEW_SESSION_INVALID' as const };
  }
  if (Object.keys(expected).some((key) =>
    expected[key as keyof typeof expected] !== draft.freezeIdentity[key as keyof typeof expected])) {
    return { ok: false as const, code: 'REVIEW_SESSION_INVALID' as const };
  }
  const restored = restoreA3WorkspaceDraft({ saved: draft, packet: loaded.session.packet });
  if (restored.status !== 'restored') {
    return { ok: false as const, code: 'INVALID_EVIDENCE_SELECTION' as const };
  }
  const result = generateForgewingLabelLinkageManifestFromReview({
    packet: loaded.session.packet,
    reviewInput: a3WorkspaceDomainReviewInput(restored.draft),
  });
  if (result.status === 'manifest_ready' && result.manifest) {
    return { ok: true as const, status: 'manifest_ready' as const, manifest: result.manifest };
  }
  return {
    ok: true as const,
    status: result.status,
    failureReasons: result.failureReasons,
    manifest: null,
  };
}

export function generateA3WorkspaceManifest(draft: A3WorkspaceDraft) {
  const evaluated = evaluateA3WorkspaceDraft(draft);
  if (!evaluated.ok) return evaluated;
  if (evaluated.status !== 'manifest_ready' || !evaluated.manifest) {
    return {
      ok: false as const,
      code: evaluated.status === 'review_incomplete'
        ? 'INCOMPLETE_REVIEW' as const : 'INVALID_EVIDENCE_SELECTION' as const,
    };
  }
  const bytes = serializeJson(evaluated.manifest);
  try {
    const path = writeArtifact('forgewing-label-linkage.reviewed.json', bytes);
    return {
      ok: true as const,
      status: 'manifest_generated' as const,
      artifactPath: path,
      artifactSha256: sha256Hex(bytes),
      manifestDigestSha256: evaluated.manifest.manifest_digest_sha256,
    };
  } catch {
    return { ok: false as const, code: 'ARTIFACT_WRITE_FAILED' as const };
  }
}

export function prepareA3WorkspaceAttestation() {
  const loaded = loadA3WorkspaceSession();
  if (!loaded.ok) return loaded;
  const manifestPath = join(artifactDirectory(), 'forgewing-label-linkage.reviewed.json');
  if (!existsSync(manifestPath) || !statSync(manifestPath).isFile()) {
    return { ok: false as const, code: 'INCOMPLETE_REVIEW' as const };
  }
  try {
    const linkageManifestBytes = readFileSync(manifestPath);
    const manifest = parseForgewingLabelLinkageManifest(
      JSON.parse(linkageManifestBytes.toString('utf8')),
    );
    const template = buildPreparedForgewingLabelAttestationTemplate({
      ledgerBytes: loaded.ledgerBytes,
      linkageManifestBytes,
      labelObservationIds: manifest.records.map((record) => record.label_observation_id),
    });
    if (!preparedA3AttestationHumanFieldsAreBlank(template)) {
      return { ok: false as const, code: 'REVIEW_SESSION_INVALID' as const };
    }
    const bytes = serializeJson(template);
    const path = writeArtifact('tdot-phase0-human-attestation.prepared.json', bytes);
    return {
      ok: true as const,
      status: 'attestation_prepared' as const,
      artifactPath: path,
      artifactSha256: sha256Hex(bytes),
      remainingHumanFields: [
        'Reviewer', 'Reviewed at', 'Human verification statement', 'Attestation digest',
      ],
    };
  } catch {
    return { ok: false as const, code: 'INVALID_EVIDENCE_SELECTION' as const };
  }
}

export function preparedA3AttestationHumanFieldsAreBlank(template: unknown): boolean {
  if (!template || typeof template !== 'object') return false;
  const value = template as {
    reviewer?: { stable_handle?: unknown; reviewed_at?: unknown };
    status?: unknown;
    statement?: unknown;
    attestation_digest_sha256?: unknown;
  };
  return value.reviewer?.stable_handle === ''
    && value.reviewer.reviewed_at === ''
    && value.status === ''
    && value.statement === ''
    && value.attestation_digest_sha256 === '';
}
