import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  FORGEWING_LABEL_ATTESTATION_STATEMENT,
  buildPreparedForgewingLabelAttestationTemplate,
  completePreparedForgewingLabelAttestation,
  parseForgewingLabelAttestation,
  validateForgewingLabelAttestation,
} from
  '@/lib/evaluation/forgewing/labelledPricingAttestation';
import {
  forgewingLabelLinkageManifestDigest,
  forgewingLabelLinkageRecordDigest,
  parseForgewingLabelLinkageManifest,
} from
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
  | 'ARTIFACT_WRITE_FAILED'
  | 'REVIEWER_REQUIRED'
  | 'VERIFICATION_CONFIRMATION_REQUIRED'
  | 'ATTESTATION_TEMPLATE_INVALID'
  | 'LINKAGE_MANIFEST_CHANGED'
  | 'SOURCE_IDENTITY_CHANGED'
  | 'ATTESTATION_DIGEST_INVALID'
  | 'ATTESTATION_VALIDATION_FAILED';

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
  REVIEWER_REQUIRED: 'REVIEWER REQUIRED',
  VERIFICATION_CONFIRMATION_REQUIRED: 'VERIFICATION CONFIRMATION REQUIRED',
  ATTESTATION_TEMPLATE_INVALID: 'ATTESTATION TEMPLATE INVALID',
  LINKAGE_MANIFEST_CHANGED: 'LINKAGE MANIFEST CHANGED — PREPARE ATTESTATION AGAIN',
  SOURCE_IDENTITY_CHANGED: 'SOURCE IDENTITY CHANGED',
  ATTESTATION_DIGEST_INVALID: 'ATTESTATION DIGEST INVALID',
  ATTESTATION_VALIDATION_FAILED: 'ATTESTATION VALIDATION FAILED',
};

const LINKAGE_MANIFEST_FILENAME = 'forgewing-label-linkage.reviewed.json';
const PREPARED_ATTESTATION_FILENAME = 'tdot-phase0-human-attestation.prepared.json';
const COMPLETED_ATTESTATION_FILENAME = 'tdot-phase0-human-attestation.completed.json';

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
    const path = writeArtifact(LINKAGE_MANIFEST_FILENAME, bytes);
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
  const manifestPath = join(artifactDirectory(), LINKAGE_MANIFEST_FILENAME);
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
    const path = writeArtifact(PREPARED_ATTESTATION_FILENAME, bytes);
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

type AttestationArtifactState = Readonly<{
  state: 'absent' | 'prepared' | 'completed';
  statement: typeof FORGEWING_LABEL_ATTESTATION_STATEMENT;
  preparedArtifactPath?: string;
  completedArtifactPath?: string;
  reviewer?: string;
  reviewedAt?: string;
  scopeKind?: 'FULL_PACKAGE' | 'SCORING_SUBSET';
  scopeLabelCount?: number;
  linkageManifestSha256?: string;
  attestationDigestSha256?: string;
  authority?: 'evaluation_ground_truth_only';
  promotionAuthorized?: false;
}>;

function readJsonFile(path: string): { bytes: Buffer; value: unknown } | null {
  try {
    if (!existsSync(path) || !statSync(path).isFile()) return null;
    const bytes = readFileSync(path);
    return { bytes, value: JSON.parse(bytes.toString('utf8')) as unknown };
  } catch {
    return null;
  }
}

function artifactFileExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function currentManifest(params: {
  loaded: Extract<LoadResult, { ok: true }>;
  manifestArtifact: { bytes: Buffer; value: unknown } | null;
  manifestExists: boolean;
}): Readonly<
  { ok: true; bytes: Buffer; manifest: ReturnType<typeof parseForgewingLabelLinkageManifest> }
  | { ok: false; code: A3WorkspaceFailureCode }
> {
  if (!params.manifestArtifact) {
    return {
      ok: false,
      code: params.manifestExists ? 'LINKAGE_MANIFEST_CHANGED' : 'INCOMPLETE_REVIEW',
    };
  }
  let manifest: ReturnType<typeof parseForgewingLabelLinkageManifest>;
  try {
    manifest = parseForgewingLabelLinkageManifest(params.manifestArtifact.value);
  } catch {
    return { ok: false, code: 'LINKAGE_MANIFEST_CHANGED' };
  }
  const packet = params.loaded.session.packet;
  const { manifest_digest_sha256: manifestDigest, ...unsignedManifest } = manifest;
  const labels = new Map(packet.labels.map((label) => [label.label_observation_id, label]));
  const seenSourceObservationIds = new Set<string>();
  if (forgewingLabelLinkageManifestDigest(unsignedManifest) !== manifestDigest
    || manifest.label_package_sha256 !== sha256Hex(params.loaded.ledgerBytes)
    || manifest.source.source_pdf_sha256 !== sha256Hex(params.loaded.sourceBytes)
    || manifest.source.source_document_id !== packet.source.source_document_id
    || manifest.source.source_artifact_id !== packet.source.source_artifact_id
    || manifest.source.extraction_snapshot_id !== packet.source.extraction_snapshot_id
    || manifest.records.length !== packet.labels.length
    || manifest.records.some((record) => {
      const label = labels.get(record.label_observation_id);
      const { linkage_record_digest_sha256: recordDigest, ...unsignedRecord } = record;
      const allowedObservationIds = new Set(
        label?.modern_pdf_layout_token_observations
          .filter((observation) => observation.candidate_admitted
            && label.modern_candidate_source_anchor_ids.includes(observation.observation_id))
          .map((observation) => observation.observation_id) ?? [],
      );
      const duplicatesSourceObservation = record.source_observation_ids.some((id) => {
        if (seenSourceObservationIds.has(id)) return true;
        seenSourceObservationIds.add(id);
        return false;
      });
      return duplicatesSourceObservation
        || forgewingLabelLinkageRecordDigest(unsignedRecord) !== recordDigest
        || !label
        || record.label_row_identity !== label.legacy_row_identity
        || record.label_role !== label.role
        || record.label_raw_text_sha256 !== label.legacy_raw_text_sha256
        || record.physical_page !== label.physical_page
        || record.candidate_row_id !== label.candidate_row_id
        || record.source_observation_ids.some((id) => !allowedObservationIds.has(id));
    })) {
    return { ok: false, code: 'LINKAGE_MANIFEST_CHANGED' };
  }
  return { ok: true, bytes: params.manifestArtifact.bytes, manifest };
}

function freshPreparedAttestation(params: {
  loaded: Extract<LoadResult, { ok: true }>;
  manifestBytes: Buffer;
  manifest: ReturnType<typeof parseForgewingLabelLinkageManifest>;
}): Readonly<Record<string, unknown>> {
  const prepared = buildPreparedForgewingLabelAttestationTemplate({
    ledgerBytes: params.loaded.ledgerBytes,
    linkageManifestBytes: params.manifestBytes,
    labelObservationIds: params.manifest.records.map((record) => record.label_observation_id),
  });
  const source = prepared.source_artifact as {
    sha256: string; byte_length: number; pages: number;
  };
  if (source.sha256 !== sha256Hex(params.loaded.sourceBytes)
    || source.byte_length !== params.loaded.sourceBytes.byteLength
    || source.pages !== params.loaded.session.packet.source.source_pages) {
    throw new Error('SOURCE_IDENTITY_CHANGED');
  }
  return prepared;
}

function freshPreparedFailure(error: unknown): A3WorkspaceFailureCode {
  return error instanceof Error && error.message === 'SOURCE_IDENTITY_CHANGED'
    ? 'SOURCE_IDENTITY_CHANGED' : 'LINKAGE_MANIFEST_CHANGED';
}

function classifyPreparedMismatch(params: {
  prepared: unknown;
  expected: Readonly<Record<string, unknown>>;
}): A3WorkspaceFailureCode {
  if (!params.prepared || typeof params.prepared !== 'object') {
    return 'ATTESTATION_TEMPLATE_INVALID';
  }
  const value = params.prepared as {
    label_package?: { ledger_sha256?: unknown };
    source_artifact?: { sha256?: unknown };
    linkage_manifest_sha256?: unknown;
  };
  const expected = params.expected as {
    label_package: { ledger_sha256: string };
    source_artifact: { sha256: string };
    linkage_manifest_sha256: string;
  };
  if (value.label_package?.ledger_sha256 !== expected.label_package.ledger_sha256) {
    return 'LABEL_PACKAGE_CHANGED';
  }
  if (value.source_artifact?.sha256 !== expected.source_artifact.sha256) {
    return 'SOURCE_IDENTITY_CHANGED';
  }
  if (value.linkage_manifest_sha256 !== expected.linkage_manifest_sha256) {
    return 'LINKAGE_MANIFEST_CHANGED';
  }
  return 'ATTESTATION_TEMPLATE_INVALID';
}

function validateCompletedArtifact(params: {
  loaded: Extract<LoadResult, { ok: true }>;
  completed: unknown;
  expectedPrepared: Readonly<Record<string, unknown>>;
  manifestSha256: string;
}): Readonly<
  { ok: true; attestation: ReturnType<typeof parseForgewingLabelAttestation> }
  | { ok: false; code: A3WorkspaceFailureCode }
> {
  let attestation: ReturnType<typeof parseForgewingLabelAttestation>;
  try {
    attestation = parseForgewingLabelAttestation(params.completed);
  } catch {
    return { ok: false, code: 'ATTESTATION_VALIDATION_FAILED' };
  }
  const validation = validateForgewingLabelAttestation({
    ledgerBytes: params.loaded.ledgerBytes,
    attestation,
  });
  if (validation.failureReasons.includes('attestation_digest_mismatch')) {
    return { ok: false, code: 'ATTESTATION_DIGEST_INVALID' };
  }
  if (validation.failureReasons.includes('label_package_digest_mismatch')) {
    return { ok: false, code: 'LABEL_PACKAGE_CHANGED' };
  }
  if (validation.failureReasons.includes('source_artifact_digest_mismatch')) {
    return { ok: false, code: 'SOURCE_IDENTITY_CHANGED' };
  }
  if (validation.status !== 'human_attestation_valid'
    || validation.authority !== 'evaluation_ground_truth_only'
    || validation.promotionAuthorized !== false
    || attestation.linkage_manifest_sha256 !== params.manifestSha256) {
    return {
      ok: false,
      code: attestation.linkage_manifest_sha256 !== params.manifestSha256
        ? 'LINKAGE_MANIFEST_CHANGED' : 'ATTESTATION_VALIDATION_FAILED',
    };
  }
  let expectedCompleted;
  try {
    expectedCompleted = completePreparedForgewingLabelAttestation({
      preparedAttestation: params.expectedPrepared,
      reviewer: attestation.reviewer.stable_handle,
      reviewedAt: attestation.reviewer.reviewed_at,
    });
  } catch {
    return { ok: false, code: 'ATTESTATION_VALIDATION_FAILED' };
  }
  if (hashCanonical(expectedCompleted) !== hashCanonical(attestation)) {
    return { ok: false, code: 'ATTESTATION_VALIDATION_FAILED' };
  }
  return { ok: true, attestation };
}

function mapLoadFailure(code: A3WorkspaceFailureCode): A3WorkspaceFailureCode {
  return code === 'SOURCE_MISMATCH' ? 'SOURCE_IDENTITY_CHANGED' : code;
}

export function getA3WorkspaceAttestationState(): Readonly<
  { ok: true; status: AttestationArtifactState }
  | { ok: false; code: A3WorkspaceFailureCode }
> {
  const loaded = loadA3WorkspaceSession();
  if (!loaded.ok) return { ok: false, code: mapLoadFailure(loaded.code) };
  const directory = artifactDirectory();
  const manifestPath = join(directory, LINKAGE_MANIFEST_FILENAME);
  const preparedPath = join(directory, PREPARED_ATTESTATION_FILENAME);
  const completedPath = join(directory, COMPLETED_ATTESTATION_FILENAME);
  const manifestResult = currentManifest({
    loaded,
    manifestArtifact: readJsonFile(manifestPath),
    manifestExists: artifactFileExists(manifestPath),
  });
  const preparedExists = artifactFileExists(preparedPath);
  const completedExists = artifactFileExists(completedPath);
  const preparedArtifact = readJsonFile(preparedPath);
  const completedArtifact = readJsonFile(completedPath);
  if (!preparedExists && !completedExists) {
    return {
      ok: true,
      status: { state: 'absent', statement: FORGEWING_LABEL_ATTESTATION_STATEMENT },
    };
  }
  if (completedExists && !completedArtifact) {
    return { ok: false, code: 'ATTESTATION_VALIDATION_FAILED' };
  }
  if (preparedExists && !preparedArtifact && !completedExists) {
    return { ok: false, code: 'ATTESTATION_TEMPLATE_INVALID' };
  }
  if (!manifestResult.ok) return manifestResult;
  let expectedPrepared: Readonly<Record<string, unknown>>;
  try {
    expectedPrepared = freshPreparedAttestation({
      loaded, manifestBytes: manifestResult.bytes, manifest: manifestResult.manifest,
    });
  } catch (error) {
    return { ok: false, code: freshPreparedFailure(error) };
  }
  if (completedArtifact) {
    const completed = validateCompletedArtifact({
      loaded,
      completed: completedArtifact.value,
      expectedPrepared,
      manifestSha256: sha256Hex(manifestResult.bytes),
    });
    if (!completed.ok) return completed;
    return {
      ok: true,
      status: {
        state: 'completed',
        statement: FORGEWING_LABEL_ATTESTATION_STATEMENT,
        completedArtifactPath: completedPath,
        reviewer: completed.attestation.reviewer.stable_handle,
        reviewedAt: completed.attestation.reviewer.reviewed_at,
        scopeKind: completed.attestation.scope.kind,
        scopeLabelCount: completed.attestation.scope.label_observation_ids.length,
        linkageManifestSha256: completed.attestation.linkage_manifest_sha256,
        attestationDigestSha256: completed.attestation.attestation_digest_sha256,
        authority: 'evaluation_ground_truth_only',
        promotionAuthorized: false,
      },
    };
  }
  if (!preparedArtifact || !preparedA3AttestationHumanFieldsAreBlank(preparedArtifact.value)
    || hashCanonical(preparedArtifact.value) !== hashCanonical(expectedPrepared)) {
    return {
      ok: false,
      code: classifyPreparedMismatch({ prepared: preparedArtifact?.value, expected: expectedPrepared }),
    };
  }
  return {
    ok: true,
    status: {
      state: 'prepared',
      statement: FORGEWING_LABEL_ATTESTATION_STATEMENT,
      preparedArtifactPath: preparedPath,
      scopeKind: (expectedPrepared.scope as { kind: 'FULL_PACKAGE' | 'SCORING_SUBSET' }).kind,
      scopeLabelCount: (expectedPrepared.scope as { label_observation_ids: string[] })
        .label_observation_ids.length,
      linkageManifestSha256: sha256Hex(manifestResult.bytes),
      authority: 'evaluation_ground_truth_only',
      promotionAuthorized: false,
    },
  };
}

export function parseA3WorkspaceAttestationCompletionInput(input: unknown): Readonly<
  { ok: true; reviewer: string }
  | { ok: false; code: A3WorkspaceFailureCode }
> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, code: 'ATTESTATION_VALIDATION_FAILED' };
  }
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => key !== 'reviewer' && key !== 'confirmed')) {
    return { ok: false, code: 'ATTESTATION_VALIDATION_FAILED' };
  }
  if (typeof value.reviewer !== 'string' || value.reviewer.trim().length === 0) {
    return { ok: false, code: 'REVIEWER_REQUIRED' };
  }
  if (value.confirmed !== true) {
    return { ok: false, code: 'VERIFICATION_CONFIRMATION_REQUIRED' };
  }
  return { ok: true, reviewer: value.reviewer.trim() };
}

export function completeA3WorkspaceAttestation(
  input: unknown,
  options: { now?: () => Date } = {},
) {
  const parsedInput = parseA3WorkspaceAttestationCompletionInput(input);
  if (!parsedInput.ok) return parsedInput;
  const loaded = loadA3WorkspaceSession();
  if (!loaded.ok) return { ok: false as const, code: mapLoadFailure(loaded.code) };
  const directory = artifactDirectory();
  const manifestPath = join(directory, LINKAGE_MANIFEST_FILENAME);
  const manifestResult = currentManifest({
    loaded,
    manifestArtifact: readJsonFile(manifestPath),
    manifestExists: artifactFileExists(manifestPath),
  });
  if (!manifestResult.ok) return manifestResult;
  const preparedArtifact = readJsonFile(join(directory, PREPARED_ATTESTATION_FILENAME));
  if (!preparedArtifact) return { ok: false as const, code: 'ATTESTATION_TEMPLATE_INVALID' as const };
  let expectedPrepared: Readonly<Record<string, unknown>>;
  try {
    expectedPrepared = freshPreparedAttestation({
      loaded, manifestBytes: manifestResult.bytes, manifest: manifestResult.manifest,
    });
  } catch (error) {
    return { ok: false as const, code: freshPreparedFailure(error) };
  }
  if (!preparedA3AttestationHumanFieldsAreBlank(preparedArtifact.value)
    || hashCanonical(preparedArtifact.value) !== hashCanonical(expectedPrepared)) {
    return {
      ok: false as const,
      code: classifyPreparedMismatch({ prepared: preparedArtifact.value, expected: expectedPrepared }),
    };
  }
  let completed;
  try {
    completed = completePreparedForgewingLabelAttestation({
      preparedAttestation: preparedArtifact.value,
      reviewer: parsedInput.reviewer,
      reviewedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
  } catch {
    return { ok: false as const, code: 'ATTESTATION_VALIDATION_FAILED' as const };
  }
  let artifactPath: string;
  try {
    artifactPath = writeArtifact(COMPLETED_ATTESTATION_FILENAME, serializeJson(completed));
  } catch {
    return { ok: false as const, code: 'ARTIFACT_WRITE_FAILED' as const };
  }
  const reread = readJsonFile(artifactPath);
  if (!reread) return { ok: false as const, code: 'ATTESTATION_VALIDATION_FAILED' as const };
  const validated = validateCompletedArtifact({
    loaded,
    completed: reread.value,
    expectedPrepared,
    manifestSha256: sha256Hex(manifestResult.bytes),
  });
  if (!validated.ok) return validated;
  return {
    ok: true as const,
    status: 'human_attestation_complete' as const,
    artifactPath,
    reviewer: validated.attestation.reviewer.stable_handle,
    reviewedAt: validated.attestation.reviewer.reviewed_at,
    scopeKind: validated.attestation.scope.kind,
    scopeLabelCount: validated.attestation.scope.label_observation_ids.length,
    linkageManifestSha256: validated.attestation.linkage_manifest_sha256,
    attestationDigestSha256: validated.attestation.attestation_digest_sha256,
    authority: 'evaluation_ground_truth_only' as const,
    promotionAuthorized: false as const,
  };
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
