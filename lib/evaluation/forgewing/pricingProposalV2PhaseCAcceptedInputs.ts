/**
 * Evaluation-only accepted-input pins and authentication for Forgewing V2 Phase C.
 *
 * These pins are EVALUATION BINDINGS, not production logic. They exist so the
 * frozen measurement cannot be pointed at a self-consistent alternate package:
 * expected identity is declared here and compared against the bytes under
 * authentication, never derived from them.
 */
import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  deriveSourceFieldId,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import {
  validateForgewingPricingV2AcceptedPhaseBArtifact,
  validateForgewingPricingV2HumanLabelPackage,
} from '@/lib/evaluation/forgewing/pricingProposalV2HumanLabels';

export const FORGEWING_V2_PHASE_C_ACCEPTED_PINS = {
  humanLabelPackageSha256:
    '0dd8c1eb726e42c496108c0e7e9692546b640fe6deeab3726ec1665a5344a24b',
  phaseBArtifactSha256:
    '641b52f5ed55152b22c6338d283eecf0ad41671f066e2bdab0835b37733c798a',
  phaseBReportDigestSha256:
    '4b2c48410b5656457ae5d9f806e6f216bd52c8d3d4aab80753170a6bf198f936',
  reviewPacketSha256:
    '0e815b0c2cf7db58a12ebd430025dda4c8e9fb213273aa07f5020881027285a9',
  labelWorkflowImplementationCommit: 'fc7433a98194b49efd09430d8a27e63d3f1f1984',
  phaseBPreparationCommit: 'f13c815b2bdb386353f008f8d56c5622407d8aec',
  packetVersion: 'forgewing-pricing-v2-human-review-packet-v1',
  fieldCount: 17,
  memberObservationCount: 19,
} as const;

export type ForgewingV2PhaseCAcceptedPins = typeof FORGEWING_V2_PHASE_C_ACCEPTED_PINS;

export type ForgewingV2PhaseCAuthenticationFailure =
  | 'human_label_package_sha_mismatch'
  | 'phase_b_artifact_sha_mismatch'
  | 'phase_b_report_digest_mismatch'
  | 'phase_b_preparation_commit_mismatch'
  | 'phase_b_artifact_invalid'
  | 'human_label_package_invalid'
  | 'label_workflow_commit_mismatch'
  | 'review_packet_sha_mismatch'
  | 'review_packet_version_mismatch'
  | 'review_packet_digest_mismatch'
  | 'review_packet_binding_mismatch'
  | 'review_packet_ordering_nondeterministic'
  | 'review_packet_field_identity_mismatch'
  | 'review_packet_member_membership_mismatch'
  | 'review_packet_field_id_not_derivable'
  | 'review_packet_field_absent_from_phase_b'
  | 'review_packet_context_mismatch'
  | 'review_packet_candidate_mismatch'
  | 'review_packet_role_mismatch'
  | 'review_packet_evidence_identity_mismatch'
  | 'field_count_mismatch'
  | 'member_count_mismatch'
  | 'input_contract_violation';

export class ForgewingV2PhaseCAuthenticationError extends Error {
  constructor(readonly failure: ForgewingV2PhaseCAuthenticationFailure) {
    super(`FORGEWING_V2_PHASE_C_INPUT_AUTHENTICATION_FAILED:${failure}`);
    this.name = 'ForgewingV2PhaseCAuthenticationError';
  }
}

type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;

function fail(failure: ForgewingV2PhaseCAuthenticationFailure): never {
  throw new ForgewingV2PhaseCAuthenticationError(failure);
}

export type ForgewingV2AuthenticatedInputs = Readonly<{
  humanLabelPackage: JsonRecord;
  reviewPacket: JsonRecord;
  humanLabelPackageSha256: string;
  phaseBArtifactSha256: string;
  reviewPacketSha256: string;
  labelWorkflowImplementationCommit: string;
  fieldCount: number;
  memberObservationCount: number;
}>;

type AuthenticationInputs = Readonly<{
  humanLabelPackageBytes: Buffer;
  phaseBArtifactBytes: Buffer;
  reviewPacketBytes: Buffer;
}>;

/**
 * Fail-closed authentication of every accepted Phase C input, ALWAYS against the
 * frozen accepted pins. There is deliberately no caller-supplied pin override on
 * this path: trust anchors are frozen evaluation identity, not configuration.
 */
export function authenticateForgewingV2PhaseCInputs(
  params: AuthenticationInputs,
): ForgewingV2AuthenticatedInputs {
  return authenticateWithPins(params, FORGEWING_V2_PHASE_C_ACCEPTED_PINS);
}

/**
 * INTERNAL / TEST ONLY. Allows a mutated pin set so exploit regressions can
 * exercise drift paths. Never reachable from the live runner API.
 */
export function authenticateForgewingV2PhaseCInputsForMutationTests(
  params: AuthenticationInputs, pins: ForgewingV2PhaseCAcceptedPins,
): ForgewingV2AuthenticatedInputs {
  return authenticateWithPins(params, pins);
}

function authenticateWithPins(
  params: AuthenticationInputs, pins: ForgewingV2PhaseCAcceptedPins,
): ForgewingV2AuthenticatedInputs {

  const humanLabelPackageSha256 = sha256Hex(params.humanLabelPackageBytes);
  const phaseBArtifactSha256 = sha256Hex(params.phaseBArtifactBytes);
  const reviewPacketSha256 = sha256Hex(params.reviewPacketBytes);

  if (humanLabelPackageSha256 !== pins.humanLabelPackageSha256) {
    fail('human_label_package_sha_mismatch');
  }
  if (phaseBArtifactSha256 !== pins.phaseBArtifactSha256) fail('phase_b_artifact_sha_mismatch');
  if (reviewPacketSha256 !== pins.reviewPacketSha256) fail('review_packet_sha_mismatch');

  let pkg: JsonRecord | null; let packet: JsonRecord | null; let artifact: JsonRecord | null;
  try {
    pkg = record(JSON.parse(params.humanLabelPackageBytes.toString('utf8')));
    packet = record(JSON.parse(params.reviewPacketBytes.toString('utf8')));
    artifact = record(JSON.parse(params.phaseBArtifactBytes.toString('utf8')));
  } catch { fail('input_contract_violation'); }
  if (!pkg || !packet || !artifact) fail('input_contract_violation');

  if (pkg.preparationReportDigestSha256 !== pins.phaseBReportDigestSha256) {
    fail('phase_b_report_digest_mismatch');
  }
  if (pkg.preparationImplementationCommit !== pins.phaseBPreparationCommit) {
    fail('phase_b_preparation_commit_mismatch');
  }
  if (pkg.implementationCommit !== pins.labelWorkflowImplementationCommit) {
    fail('label_workflow_commit_mismatch');
  }

  const preparations = (artifact.sources as JsonRecord[] ?? [])
    .map((source) => record(source.preparation)).filter((v): v is JsonRecord => Boolean(v));
  const preparedRows = preparations.flatMap((value) => (value.rows as JsonRecord[]) ?? []);
  const preparedFields = preparedRows
    .flatMap((row) => (row.fields as JsonRecord[]) ?? [])
    .map((wrapper) => record(wrapper.field)).filter((v): v is JsonRecord => Boolean(v));

  // Expected counts come from the PINS, not from the artifact being checked.
  const phaseB = validateForgewingPricingV2AcceptedPhaseBArtifact({
    artifactBytes: params.phaseBArtifactBytes,
    expected: {
      preparationArtifactSha256: pins.phaseBArtifactSha256,
      reportDigestSha256: pins.phaseBReportDigestSha256,
      preparationImplementationCommit: pins.phaseBPreparationCommit,
      expectedPreparationDigests: preparations
        .map((value) => value.preparationDigestSha256 as string),
      expectedRowCount: preparedRows.length,
      expectedFieldCount: pins.fieldCount,
      expectedMemberObservationCount: pins.memberObservationCount,
      expectedSourceFieldIds: preparedFields.map((field) => field.sourceFieldId as string),
    },
  });
  if (phaseB.status !== 'valid') fail('phase_b_artifact_invalid');

  const validated = validateForgewingPricingV2HumanLabelPackage({
    package: pkg, phaseB: phaseB.value,
    expectedLabelWorkflowImplementationCommit: pins.labelWorkflowImplementationCommit,
  });
  if (validated.status !== 'valid') fail('human_label_package_invalid');

  // ---- packet authentication (not merely "the SHA is 64 chars") ----
  if (packet.packetVersion !== pins.packetVersion) fail('review_packet_version_mismatch');
  const { packetDigestSha256, ...unsignedPacket } = packet;
  if (typeof packetDigestSha256 !== 'string'
    || hashCanonical(unsignedPacket) !== packetDigestSha256) {
    fail('review_packet_digest_mismatch');
  }
  const packetPreparation = record(packet.preparationArtifact);
  if (packetPreparation?.sha256 !== pins.phaseBArtifactSha256
    || packetPreparation?.reportDigestSha256 !== pins.phaseBReportDigestSha256
    || packetPreparation?.implementationCommit !== pins.phaseBPreparationCommit
    || packet.labelWorkflowImplementationCommit !== pins.labelWorkflowImplementationCommit
    || packet.providerCalls !== 0 || packet.promotionAuthorized !== false
    || packet.promotionEvidence !== false) {
    fail('review_packet_binding_mismatch');
  }
  const packetSources = (packet.sources as JsonRecord[]) ?? [];
  if (packetSources.some((source) => source.orderingDeterministic !== true)) {
    fail('review_packet_ordering_nondeterministic');
  }

  const packetFields = packetSources
    .flatMap((source) => (source.rows as JsonRecord[]) ?? [])
    .flatMap((row) => (row.fields as JsonRecord[]) ?? [])
    .map((wrapper) => record(wrapper.field)).filter((v): v is JsonRecord => Boolean(v));
  if (packetFields.length !== pins.fieldCount) fail('field_count_mismatch');
  const packetMemberCount = packetFields
    .reduce((sum, field) => sum + ((field.sourceObservationIds as string[]) ?? []).length, 0);
  if (packetMemberCount !== pins.memberObservationCount) fail('member_count_mismatch');

  // Packet field identity and exact membership must equal the human package.
  const humanFields = (pkg.fields as JsonRecord[]) ?? [];
  if (humanFields.length !== pins.fieldCount) fail('field_count_mismatch');
  const identityOf = (field: JsonRecord) => hashCanonical({
    sourceFieldId: field.sourceFieldId,
    sourceFieldRole: field.sourceFieldRole,
    sourceObservationIds: [...((field.sourceObservationIds as string[]) ?? [])]
      .sort((a, b) => a.localeCompare(b, 'en-US')),
  });
  const packetIdentities = packetFields.map(identityOf).sort();
  const humanIdentities = humanFields.map(identityOf).sort();
  if (hashCanonical(packetIdentities) !== hashCanonical(humanIdentities)) {
    fail('review_packet_field_identity_mismatch');
  }
  const humanMemberCount = humanFields
    .reduce((sum, field) => sum + ((field.sourceObservationIds as string[]) ?? []).length, 0);
  if (humanMemberCount !== pins.memberObservationCount) fail('member_count_mismatch');
  const packetMembers = [...new Set(packetFields
    .flatMap((field) => (field.sourceObservationIds as string[]) ?? []))].sort();
  const humanMembers = [...new Set(humanFields
    .flatMap((field) => (field.sourceObservationIds as string[]) ?? []))].sort();
  if (hashCanonical(packetMembers) !== hashCanonical(humanMembers)) {
    fail('review_packet_member_membership_mismatch');
  }

  // ---- packet SEMANTIC closure against validated Phase B preparation ----
  // Exact packet bytes are not the only protection: every packet row/field/member
  // must close against the accepted Phase B preparation, so a locally recomputed
  // packet digest cannot smuggle artifact, page, row, candidate, role, context,
  // or member drift.
  type Closure = Readonly<{
    context: string; candidateId: unknown; role: unknown;
    members: readonly string[]; evidence: string;
  }>;
  const contextKey = (context: JsonRecord): string => hashCanonical({
    sourceDocumentId: context.sourceDocumentId,
    sourceArtifactId: context.sourceArtifactId,
    physicalPageNumber: context.physicalPageNumber,
    rowObservationId: context.rowObservationId,
  });
  const evidenceKey = (evidence: JsonRecord[]): string => hashCanonical(
    [...evidence].map((item) => ({
      observationId: item.observationId,
      sourceDocumentId: item.sourceDocumentId,
      sourceArtifactId: item.sourceArtifactId,
      physicalPageNumber: item.physicalPageNumber,
    })).sort((left, right) =>
      String(left.observationId).localeCompare(String(right.observationId), 'en-US')));

  const phaseBClosure = new Map<string, Closure>();
  for (const preparation of preparations) {
    for (const rowValue of (preparation.rows as JsonRecord[]) ?? []) {
      const rowContext = record(rowValue.context);
      if (!rowContext) fail('review_packet_context_mismatch');
      for (const wrapper of (rowValue.fields as JsonRecord[]) ?? []) {
        const field = record(wrapper.field);
        if (!field) fail('input_contract_violation');
        phaseBClosure.set(field.sourceFieldId as string, {
          context: contextKey(rowContext),
          candidateId: rowValue.candidateId,
          role: field.sourceFieldRole,
          members: [...((field.sourceObservationIds as string[]) ?? [])]
            .sort((a, b) => a.localeCompare(b, 'en-US')),
          evidence: evidenceKey((wrapper.primitiveEvidence as JsonRecord[]) ?? []),
        });
      }
    }
  }

  for (const sourceValue of packetSources) {
    for (const rowValue of (sourceValue.rows as JsonRecord[]) ?? []) {
      const rowContext = record(rowValue.context);
      if (!rowContext) fail('review_packet_context_mismatch');
      for (const wrapper of (rowValue.fields as JsonRecord[]) ?? []) {
        const field = record(wrapper.field);
        if (!field) fail('input_contract_violation');
        const members = [...((field.sourceObservationIds as string[]) ?? [])];

        // (a) identity must be derivable from the packet's OWN immutable context.
        let derived: string;
        try {
          derived = deriveSourceFieldId({
            sourceDocumentId: rowContext.sourceDocumentId as string,
            sourceArtifactId: rowContext.sourceArtifactId as string,
            physicalPageNumber: rowContext.physicalPageNumber as number,
            rowObservationId: rowContext.rowObservationId as string,
            sourceFieldRole: field.sourceFieldRole as never,
            sourceObservationIds: members,
          });
        } catch { fail('review_packet_field_id_not_derivable'); }
        if (derived !== field.sourceFieldId) fail('review_packet_field_id_not_derivable');

        // (b) that identity and its context must close against accepted Phase B.
        const authority = phaseBClosure.get(field.sourceFieldId as string);
        if (!authority) fail('review_packet_field_absent_from_phase_b');
        if (authority.context !== contextKey(rowContext)) fail('review_packet_context_mismatch');
        if (authority.candidateId !== rowValue.candidateId) {
          fail('review_packet_candidate_mismatch');
        }
        if (authority.role !== field.sourceFieldRole) fail('review_packet_role_mismatch');
        if (hashCanonical(authority.members)
          !== hashCanonical([...members].sort((a, b) => a.localeCompare(b, 'en-US')))) {
          fail('review_packet_member_membership_mismatch');
        }
        if (authority.evidence
          !== evidenceKey((wrapper.primitiveEvidence as JsonRecord[]) ?? [])) {
          fail('review_packet_evidence_identity_mismatch');
        }
      }
    }
  }

  return {
    humanLabelPackage: pkg, reviewPacket: packet,
    humanLabelPackageSha256, phaseBArtifactSha256, reviewPacketSha256,
    labelWorkflowImplementationCommit: pins.labelWorkflowImplementationCommit,
    fieldCount: pins.fieldCount, memberObservationCount: pins.memberObservationCount,
  };
}
