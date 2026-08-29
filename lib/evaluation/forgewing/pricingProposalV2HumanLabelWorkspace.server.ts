import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  FORGEWING_PRICING_V2_HUMAN_ATTESTATION_STATEMENT,
  FORGEWING_PRICING_V2_HUMAN_ATTESTATION_VERSION,
  FORGEWING_PRICING_V2_HUMAN_LABEL_PACKAGE_VERSION,
  forgewingPricingV2HumanAttestationDigest,
  forgewingPricingV2HumanLabelPackageDigest,
  validateForgewingPricingV2AcceptedPhaseBArtifact,
  validateForgewingPricingV2HumanLabelPackage,
  type ForgewingPricingV2HumanLabelPackage,
  type ForgewingPricingV2ValidatedPhaseBScope,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabels';
import {
  restoreV2FieldLabelWorkspaceDraft,
  v2FieldLabelRecordIsReady,
  type V2FieldLabelWorkspaceDraft,
  type V2FieldLabelWorkspaceField,
  type V2FieldLabelWorkspaceSession,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabelWorkspace';

export type V2HumanLabelWorkspaceFailureCode =
  | 'CONFIGURATION_REQUIRED'
  | 'PREPARATION_ARTIFACT_CHANGED'
  | 'SOURCE_REPLAY_INVALID'
  | 'ORDERING_NONDETERMINISTIC'
  | 'IMPLEMENTATION_COMMIT_CHANGED'
  | 'SOURCE_IDENTITY_CHANGED'
  | 'REVIEW_SESSION_INVALID'
  | 'INCOMPLETE_REVIEW'
  | 'REVIEWER_REQUIRED'
  | 'VERIFICATION_CONFIRMATION_REQUIRED'
  | 'PACKAGE_VALIDATION_FAILED'
  | 'ARTIFACT_WRITE_FAILED';

export const V2_HUMAN_LABEL_WORKSPACE_ERROR_COPY:
Readonly<Record<V2HumanLabelWorkspaceFailureCode, string>> = {
  CONFIGURATION_REQUIRED: 'Evaluation configuration is missing — review disabled.',
  PREPARATION_ARTIFACT_CHANGED: 'PHASE B PREPARATION ARTIFACT CHANGED — REVIEW DISABLED',
  SOURCE_REPLAY_INVALID: 'SOURCE REPLAY CHANGED — REVIEW DISABLED',
  ORDERING_NONDETERMINISTIC: 'NONDETERMINISTIC INPUT ORDER — REVIEW DISABLED',
  IMPLEMENTATION_COMMIT_CHANGED: 'IMPLEMENTATION COMMIT CHANGED — REVIEW SESSION INVALID',
  SOURCE_IDENTITY_CHANGED: 'SOURCE IDENTITY CHANGED — REVIEW DISABLED',
  REVIEW_SESSION_INVALID: 'REVIEW SESSION INVALID',
  INCOMPLETE_REVIEW: 'INCOMPLETE REVIEW',
  REVIEWER_REQUIRED: 'REVIEWER REQUIRED',
  VERIFICATION_CONFIRMATION_REQUIRED: 'VERIFICATION CONFIRMATION REQUIRED',
  PACKAGE_VALIDATION_FAILED: 'HUMAN LABEL PACKAGE VALIDATION FAILED',
  ARTIFACT_WRITE_FAILED: 'The immutable human-label package could not be written.',
};

const EXPECTED_ARTIFACT_SHA256 =
  '641b52f5ed55152b22c6338d283eecf0ad41671f066e2bdab0835b37733c798a';
const EXPECTED_REPORT_DIGEST_SHA256 =
  '4b2c48410b5656457ae5d9f806e6f216bd52c8d3d4aab80753170a6bf198f936';
const EXPECTED_PREPARATION_COMMIT = 'f13c815b2bdb386353f008f8d56c5622407d8aec';
const EXPECTED_PACKET_VERSION = 'forgewing-pricing-v2-human-review-packet-v1';
const DEFAULT_ARTIFACT_PATH = join(process.cwd(), 'scripts', 'evaluation', 'artifacts',
  'local-v2-phase-b', 'phase-b-f13c815.json');
const COMPLETED_FILENAME = 'forgewing-pricing-v2-human-labels.completed.json';

type JsonRecord = Record<string, unknown>;
type LoadedWorkspace = Readonly<{
  session: V2FieldLabelWorkspaceSession;
  phaseB: ForgewingPricingV2ValidatedPhaseBScope;
  implementationCommit: string;
  sourceBytesByDocumentId: ReadonlyMap<string, Buffer>;
}>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function configuredFile(name: string, fallback?: string): string | null {
  const value = process.env[name]?.trim() || fallback;
  if (!value || !isAbsolute(value)) return null;
  const path = resolve(value);
  try { return existsSync(path) && statSync(path).isFile() ? path : null; } catch { return null; }
}

function outputDirectory(): string {
  const supplied = process.env.V2_BPRIME_REVIEW_OUTPUT_DIRECTORY?.trim();
  return supplied && isAbsolute(supplied) ? resolve(supplied) : join(process.cwd(), 'scripts',
    'evaluation', 'artifacts', 'local-v2-bprime-review');
}

function parseLoopbackHost(rawHost: string): string {
  const lower = rawHost.toLowerCase();
  return lower.startsWith('[') ? lower.slice(1, lower.indexOf(']')) : lower.split(':')[0]!;
}

export function isV2HumanLabelWorkspaceEnabled(params: {
  nodeEnv?: string; featureFlag?: string; host?: string | null;
} = {}): boolean {
  if (params.host === null) return false;
  const host = parseLoopbackHost(params.host ?? 'localhost');
  return (params.nodeEnv ?? process.env.NODE_ENV) !== 'production'
    && (params.featureFlag ?? process.env.ENABLE_V2_PHASE_B_PRIME_REVIEW_WORKSPACE) === '1'
    && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
}

function acceptedExpectations(artifact: JsonRecord) {
  const sources = Array.isArray(artifact.sources) ? artifact.sources : [];
  const preparations = sources.map((value) => record(record(value)?.preparation));
  const rows = preparations.flatMap((value) => Array.isArray(value?.rows) ? value.rows : []);
  const fields = rows.flatMap((value) => Array.isArray(record(value)?.fields)
    ? record(value)!.fields as unknown[] : []);
  const ids = fields.map((value) => record(record(value)?.field)?.sourceFieldId)
    .filter((value): value is string => typeof value === 'string');
  const memberCount = fields.reduce<number>((count, value) => {
    const memberIds = record(record(value)?.field)?.sourceObservationIds;
    return count + (Array.isArray(memberIds) ? memberIds.length : 0);
  }, 0);
  return {
    preparationArtifactSha256: EXPECTED_ARTIFACT_SHA256,
    reportDigestSha256: EXPECTED_REPORT_DIGEST_SHA256,
    preparationImplementationCommit: EXPECTED_PREPARATION_COMMIT,
    expectedPreparationDigests: preparations.map((value) => value?.preparationDigestSha256)
      .filter((value): value is string => typeof value === 'string'),
    expectedRowCount: rows.length,
    expectedFieldCount: ids.length,
    expectedMemberObservationCount: memberCount,
    expectedSourceFieldIds: ids,
  };
}

function packetFields(packet: JsonRecord): V2FieldLabelWorkspaceField[] | null {
  if (!Array.isArray(packet.sources)) return null;
  const fields: V2FieldLabelWorkspaceField[] = [];
  for (const sourceValue of packet.sources) {
    const source = record(sourceValue);
    if (!source || source.orderingDeterministic !== true || !Array.isArray(source.rows)) return null;
    for (const rowValue of source.rows) {
      const row = record(rowValue);
      const context = record(row?.context);
      if (!row || !context || !Array.isArray(row.fields)) return null;
      for (const fieldValue of row.fields) {
        const wrapper = record(fieldValue);
        const field = record(wrapper?.field);
        if (!wrapper || !field || !Array.isArray(field.sourceObservationIds)
          || !Array.isArray(wrapper.primitiveEvidence)) return null;
        fields.push({
          sourceFieldId: field.sourceFieldId as string,
          sourceObservationIds: field.sourceObservationIds as string[],
          sourceDocumentId: context.sourceDocumentId as string,
          sourceArtifactId: context.sourceArtifactId as string,
          physicalPageNumber: context.physicalPageNumber as number,
          rowObservationId: context.rowObservationId as string,
          sourceFieldRole: field.sourceFieldRole as V2FieldLabelWorkspaceField['sourceFieldRole'],
          authoredRawTextDisplayOnly: wrapper.authoredRawTextDisplayOnly as string,
          primitiveEvidence: wrapper.primitiveEvidence as V2FieldLabelWorkspaceField['primitiveEvidence'],
        });
      }
    }
  }
  return fields.sort((left, right) => left.sourceFieldId.localeCompare(right.sourceFieldId, 'en-US'));
}

export function loadV2HumanLabelWorkspace(): Readonly<
  { ok: true; loaded: LoadedWorkspace } | { ok: false; code: V2HumanLabelWorkspaceFailureCode }
> {
  const artifactPath = configuredFile('V2_BPRIME_PHASE_B_ARTIFACT', DEFAULT_ARTIFACT_PATH);
  const packetPath = configuredFile('V2_BPRIME_REVIEW_PACKET_PATH');
  const tdotPath = configuredFile('TDOT_PHASE1_SOURCE_PDF');
  const dnPath = configuredFile('DN_PRICED_SCHEDULE_SOURCE_PDF');
  const implementationCommit = process.env.V2_BPRIME_IMPLEMENTATION_COMMIT?.trim();
  if (!artifactPath || !packetPath || !tdotPath || !dnPath
    || !implementationCommit?.match(/^[a-f0-9]{40}$/)) {
    return { ok: false, code: 'CONFIGURATION_REQUIRED' };
  }
  let artifactBytes: Buffer; let artifact: JsonRecord; let packet: JsonRecord;
  try {
    artifactBytes = readFileSync(artifactPath);
    artifact = record(JSON.parse(artifactBytes.toString('utf8')))!;
    packet = record(JSON.parse(readFileSync(packetPath, 'utf8')))!;
  } catch { return { ok: false, code: 'CONFIGURATION_REQUIRED' }; }
  if (!artifact || sha256Hex(artifactBytes) !== EXPECTED_ARTIFACT_SHA256) {
    return { ok: false, code: 'PREPARATION_ARTIFACT_CHANGED' };
  }
  const phaseB = validateForgewingPricingV2AcceptedPhaseBArtifact({
    artifactBytes, expected: acceptedExpectations(artifact),
  });
  if (phaseB.status !== 'valid') return { ok: false, code: 'PREPARATION_ARTIFACT_CHANGED' };
  const { packetDigestSha256, ...unsignedPacket } = packet;
  if (packet.packetVersion !== EXPECTED_PACKET_VERSION
    || typeof packetDigestSha256 !== 'string'
    || hashCanonical(unsignedPacket) !== packetDigestSha256
    || record(packet.preparationArtifact)?.sha256 !== EXPECTED_ARTIFACT_SHA256
    || record(packet.preparationArtifact)?.reportDigestSha256 !== EXPECTED_REPORT_DIGEST_SHA256
    || record(packet.preparationArtifact)?.implementationCommit !== EXPECTED_PREPARATION_COMMIT
    || packet.labelWorkflowImplementationCommit !== implementationCommit
    || packet.providerCalls !== 0 || packet.promotionAuthorized !== false
    || packet.promotionEvidence !== false) return { ok: false, code: 'SOURCE_REPLAY_INVALID' };
  const fields = packetFields(packet);
  if (!fields || fields.length !== phaseB.value.fields.length
    || hashCanonical(fields.map((field) => ({ sourceFieldId: field.sourceFieldId,
      sourceObservationIds: field.sourceObservationIds,
      sourceDocumentId: field.sourceDocumentId, sourceArtifactId: field.sourceArtifactId,
      physicalPageNumber: field.physicalPageNumber, rowObservationId: field.rowObservationId,
      sourceFieldRole: field.sourceFieldRole }))) !== hashCanonical(phaseB.value.fields)) {
    return { ok: false, code: 'SOURCE_REPLAY_INVALID' };
  }
  const sourceRecords = (packet.sources as unknown[]).map((value) => record(value)?.source)
    .map(record).filter((value): value is JsonRecord => Boolean(value));
  const paths = [tdotPath, dnPath];
  const sourceBytesByDocumentId = new Map<string, Buffer>();
  for (let index = 0; index < sourceRecords.length; index += 1) {
    const source = sourceRecords[index]!;
    const bytes = readFileSync(paths[index]!);
    if (sha256Hex(bytes) !== source.sourceSha256 || bytes.byteLength !== source.sourceByteLength
      || typeof source.sourceDocumentId !== 'string') {
      return { ok: false, code: 'SOURCE_IDENTITY_CHANGED' };
    }
    sourceBytesByDocumentId.set(source.sourceDocumentId, bytes);
  }
  const freezeIdentity = {
    phaseBArtifactSha256: EXPECTED_ARTIFACT_SHA256,
    phaseBReportDigestSha256: EXPECTED_REPORT_DIGEST_SHA256,
    implementationCommit,
    proposalVersion: String(packet.proposalVersion),
    fieldSetDigestSha256: hashCanonical(phaseB.value.fields),
    sourceReplayDigestSha256: packetDigestSha256,
    orderingDeterministic: true as const,
  };
  return { ok: true, loaded: {
    session: { freezeIdentity, fields, sourceUrls: Object.fromEntries(sourceRecords.map((source) => [
      source.sourceDocumentId as string,
      `/api/evaluation/forgewing/v2-field-labels/source?sourceDocumentId=${encodeURIComponent(
        source.sourceDocumentId as string)}`,
    ])) }, phaseB: phaseB.value, implementationCommit,
    sourceBytesByDocumentId,
  } };
}

function parseCompletionInput(input: unknown): Readonly<
  { ok: true; draft: V2FieldLabelWorkspaceDraft; reviewer: string }
  | { ok: false; code: V2HumanLabelWorkspaceFailureCode }
> {
  const value = record(input);
  if (!value || Object.keys(value).some((key) => !['draft', 'reviewer', 'confirmed'].includes(key))) {
    return { ok: false, code: 'REVIEW_SESSION_INVALID' };
  }
  if (typeof value.reviewer !== 'string' || value.reviewer.trim().length === 0) {
    return { ok: false, code: 'REVIEWER_REQUIRED' };
  }
  if (value.confirmed !== true) return { ok: false, code: 'VERIFICATION_CONFIRMATION_REQUIRED' };
  return { ok: true, draft: value.draft as V2FieldLabelWorkspaceDraft,
    reviewer: value.reviewer.trim() };
}

function buildCompletedPackage(params: {
  loaded: LoadedWorkspace; draft: V2FieldLabelWorkspaceDraft; reviewer: string; reviewedAt: string;
}): ForgewingPricingV2HumanLabelPackage | null {
  const restored = restoreV2FieldLabelWorkspaceDraft({ saved: params.draft,
    session: params.loaded.session });
  if (restored.status !== 'restored') return null;
  const fieldsById = new Map(params.loaded.session.fields.map((field) =>
    [field.sourceFieldId, field]));
  if (restored.draft.records.some((item) => {
    const field = fieldsById.get(item.sourceFieldId);
    return !field || !item.confirmed || !v2FieldLabelRecordIsReady(item, field);
  })) return null;
  const fields = restored.draft.records.map((item) => {
    const field = fieldsById.get(item.sourceFieldId)!;
    return {
      sourceFieldId: field.sourceFieldId,
      sourceObservationIds: [...field.sourceObservationIds],
      sourceDocumentId: field.sourceDocumentId,
      sourceArtifactId: field.sourceArtifactId,
      physicalPageNumber: field.physicalPageNumber,
      rowObservationId: field.rowObservationId,
      sourceFieldRole: field.sourceFieldRole,
      expectedSemanticRole: item.expectedSemanticRole as Exclude<typeof item.expectedSemanticRole, ''>,
      expectedInterpretationState: item.expectedInterpretationState as
        Exclude<typeof item.expectedInterpretationState, ''>,
      expectedContributions: item.expectedContributions.map((entry) => ({
        observationId: entry.observationId,
        contributionRole: entry.contributionRole as Exclude<typeof entry.contributionRole, ''>,
      })),
      reviewStatus: 'confirmed' as const, semanticRoleConfirmed: true as const,
      explicitlyConfirmed: true as const, reviewer: params.reviewer, reviewedAt: params.reviewedAt,
    };
  });
  const body = {
    packageVersion: FORGEWING_PRICING_V2_HUMAN_LABEL_PACKAGE_VERSION,
    proposalVersion: params.loaded.session.freezeIdentity.proposalVersion as
      'forgewing-pricing-interpretation-proposal-v2',
    preparationArtifactSha256: params.loaded.phaseB.preparationArtifactSha256,
    preparationReportDigestSha256: params.loaded.phaseB.reportDigestSha256,
    preparationImplementationCommit: params.loaded.phaseB.preparationImplementationCommit,
    implementationCommit: params.loaded.implementationCommit,
    scope: { rowCount: params.loaded.phaseB.rowIds.length,
      fieldCount: params.loaded.phaseB.fields.length,
      memberObservationCount: params.loaded.phaseB.memberObservationCount,
      labelledContributionCount: fields.flatMap((field) => field.expectedContributions).length,
      sourceFieldIdsSha256: hashCanonical(params.loaded.phaseB.fields
        .map((field) => field.sourceFieldId).sort((a, b) => a.localeCompare(b, 'en-US'))) },
    fields,
    authority: 'evaluation_ground_truth_only' as const,
    promotionAuthorized: false as const, promotionEvidence: false as const,
  };
  const packageDigestSha256 = forgewingPricingV2HumanLabelPackageDigest(body);
  const attestationBody = {
    statementVersion: FORGEWING_PRICING_V2_HUMAN_ATTESTATION_VERSION,
    statement: FORGEWING_PRICING_V2_HUMAN_ATTESTATION_STATEMENT,
    reviewer: params.reviewer, reviewedAt: params.reviewedAt, confirmed: true as const,
    packageDigestSha256,
    preparationArtifactSha256: body.preparationArtifactSha256,
    preparationReportDigestSha256: body.preparationReportDigestSha256,
    implementationCommit: body.implementationCommit,
    authority: 'evaluation_ground_truth_only' as const,
    promotionAuthorized: false as const, promotionEvidence: false as const,
  };
  return { ...body, packageDigestSha256, attestation: { ...attestationBody,
    attestationDigestSha256: forgewingPricingV2HumanAttestationDigest(attestationBody) } };
}

export function validateV2HumanLabelWorkspaceDraft(input: unknown) {
  const value = record(input);
  const loaded = loadV2HumanLabelWorkspace();
  if (!loaded.ok) return loaded;
  const restored = restoreV2FieldLabelWorkspaceDraft({ saved: value?.draft ?? input,
    session: loaded.loaded.session });
  if (restored.status !== 'restored') return { ok: false as const,
    code: 'REVIEW_SESSION_INVALID' as const };
  const fields = new Map(loaded.loaded.session.fields.map((field) => [field.sourceFieldId, field]));
  const complete = restored.draft.records.every((item) => item.confirmed
    && Boolean(fields.get(item.sourceFieldId))
    && v2FieldLabelRecordIsReady(item, fields.get(item.sourceFieldId)!));
  return complete ? { ok: true as const, status: 'attestation_required' as const,
    fieldCount: restored.draft.records.length,
    contributionCount: restored.draft.records.flatMap((item) => item.expectedContributions).length }
    : { ok: false as const, code: 'INCOMPLETE_REVIEW' as const };
}

export function completeV2HumanLabelPackage(input: unknown, options: { now?: () => Date } = {}) {
  const parsed = parseCompletionInput(input);
  if (!parsed.ok) return parsed;
  const load = loadV2HumanLabelWorkspace();
  if (!load.ok) return load;
  const completedPath = join(outputDirectory(), COMPLETED_FILENAME);
  if (existsSync(completedPath)) {
    try {
      const existing = JSON.parse(readFileSync(completedPath, 'utf8')) as unknown;
      const validation = validateForgewingPricingV2HumanLabelPackage({ package: existing,
        phaseB: load.loaded.phaseB,
        expectedLabelWorkflowImplementationCommit: load.loaded.implementationCommit });
      if (validation.status === 'valid') return { ok: true as const,
        status: 'human_labels_complete' as const, artifactPath: completedPath,
        package: validation.value, resumed: true };
    } catch { /* fail closed below */ }
    return { ok: false as const, code: 'ARTIFACT_WRITE_FAILED' as const };
  }
  const completed = buildCompletedPackage({ loaded: load.loaded, draft: parsed.draft,
    reviewer: parsed.reviewer, reviewedAt: (options.now ?? (() => new Date()))().toISOString() });
  if (!completed) return { ok: false as const, code: 'INCOMPLETE_REVIEW' as const };
  const validated = validateForgewingPricingV2HumanLabelPackage({ package: completed,
    phaseB: load.loaded.phaseB,
    expectedLabelWorkflowImplementationCommit: load.loaded.implementationCommit });
  if (validated.status !== 'valid') return { ok: false as const,
    code: 'PACKAGE_VALIDATION_FAILED' as const };
  const bytes = Buffer.from(`${JSON.stringify(validated.value, null, 2)}\n`, 'utf8');
  try {
    mkdirSync(outputDirectory(), { recursive: true });
    writeFileSync(completedPath, bytes, { flag: 'wx' });
    const reread = JSON.parse(readFileSync(completedPath, 'utf8')) as unknown;
    const revalidated = validateForgewingPricingV2HumanLabelPackage({ package: reread,
      phaseB: load.loaded.phaseB,
      expectedLabelWorkflowImplementationCommit: load.loaded.implementationCommit });
    if (revalidated.status !== 'valid') return { ok: false as const,
      code: 'PACKAGE_VALIDATION_FAILED' as const };
    return { ok: true as const, status: 'human_labels_complete' as const,
      artifactPath: completedPath, packageSha256: sha256Hex(bytes),
      package: revalidated.value, resumed: false };
  } catch { return { ok: false as const, code: 'ARTIFACT_WRITE_FAILED' as const }; }
}

export function getV2HumanLabelSource(sourceDocumentId: string) {
  const loaded = loadV2HumanLabelWorkspace();
  if (!loaded.ok) return loaded;
  const bytes = loaded.loaded.sourceBytesByDocumentId.get(sourceDocumentId);
  return bytes ? { ok: true as const, bytes }
    : { ok: false as const, code: 'SOURCE_IDENTITY_CHANGED' as const };
}
