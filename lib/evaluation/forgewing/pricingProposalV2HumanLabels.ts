/**
 * Evaluation-only human ground truth for Forgewing pricing proposal V2.
 *
 * This module validates labels against the exact provider-free Phase B
 * preparation artifact. It does not participate in serving, canonical truth,
 * Validator authority, or provider execution.
 */
import { z } from 'zod';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  deriveSourceFieldId,
  FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION,
  ForgewingContributionRoleSchema,
  ForgewingFieldInterpretationStateSchema,
  ForgewingSourceFieldRoleSchema,
} from '@/lib/forgewing/proposal/pricingInterpretationProposalV2';
import { ForgewingPricingSemanticRoleSchema } from '@/lib/forgewing/proposal/schema';

export const FORGEWING_PRICING_V2_HUMAN_LABEL_PACKAGE_VERSION =
  'forgewing-pricing-v2-human-label-package-v1' as const;
export const FORGEWING_PRICING_V2_HUMAN_ATTESTATION_VERSION =
  'forgewing-pricing-v2-human-attestation-v1' as const;
export const FORGEWING_PRICING_V2_HUMAN_ATTESTATION_STATEMENT =
  'I verified every in-scope V2 field label and contribution against the bound source artifact for evaluation use only.' as const;

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(200)
  .refine((value) => value.trim() === value, 'identifier must not contain surrounding whitespace');
const implementationCommit = z.string().regex(/^[a-f0-9]{40}$/);
const observationIds = z.array(identifier).min(1).max(16)
  .refine((ids) => new Set(ids).size === ids.length, 'observation ids must be distinct');

const expectedContributionSchema = z.object({
  observationId: identifier,
  contributionRole: ForgewingContributionRoleSchema,
}).strict();

export const ForgewingPricingV2HumanFieldLabelSchema = z.object({
  sourceFieldId: identifier,
  sourceObservationIds: observationIds,
  sourceDocumentId: identifier,
  sourceArtifactId: identifier,
  physicalPageNumber: z.number().int().positive(),
  rowObservationId: identifier,
  sourceFieldRole: ForgewingSourceFieldRoleSchema,
  expectedSemanticRole: ForgewingPricingSemanticRoleSchema,
  expectedInterpretationState: ForgewingFieldInterpretationStateSchema,
  expectedContributions: z.array(expectedContributionSchema).max(16),
  reviewStatus: z.literal('confirmed'),
  semanticRoleConfirmed: z.literal(true),
  explicitlyConfirmed: z.literal(true),
  reviewer: identifier,
  reviewedAt: z.string().datetime({ offset: true }),
}).strict();

const scopeSchema = z.object({
  rowCount: z.number().int().positive(),
  fieldCount: z.number().int().positive(),
  memberObservationCount: z.number().int().positive(),
  labelledContributionCount: z.number().int().nonnegative(),
  sourceFieldIdsSha256: sha256,
}).strict();

const attestationWithoutDigestSchema = z.object({
  statementVersion: z.literal(FORGEWING_PRICING_V2_HUMAN_ATTESTATION_VERSION),
  statement: z.literal(FORGEWING_PRICING_V2_HUMAN_ATTESTATION_STATEMENT),
  reviewer: identifier,
  reviewedAt: z.string().datetime({ offset: true }),
  confirmed: z.literal(true),
  packageDigestSha256: sha256,
  preparationArtifactSha256: sha256,
  preparationReportDigestSha256: sha256,
  implementationCommit,
  authority: z.literal('evaluation_ground_truth_only'),
  promotionAuthorized: z.literal(false),
  promotionEvidence: z.literal(false),
}).strict();

export const ForgewingPricingV2HumanAttestationSchema = attestationWithoutDigestSchema.extend({
  attestationDigestSha256: sha256,
}).strict();

const packageWithoutAttestationSchema = z.object({
  packageVersion: z.literal(FORGEWING_PRICING_V2_HUMAN_LABEL_PACKAGE_VERSION),
  proposalVersion: z.literal(FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION),
  preparationArtifactSha256: sha256,
  preparationReportDigestSha256: sha256,
  preparationImplementationCommit: implementationCommit,
  implementationCommit,
  scope: scopeSchema,
  fields: z.array(ForgewingPricingV2HumanFieldLabelSchema).min(1),
  authority: z.literal('evaluation_ground_truth_only'),
  promotionAuthorized: z.literal(false),
  promotionEvidence: z.literal(false),
}).strict();

export const ForgewingPricingV2HumanLabelPackageSchema = packageWithoutAttestationSchema.extend({
  packageDigestSha256: sha256,
  attestation: ForgewingPricingV2HumanAttestationSchema,
}).strict();

export type ForgewingPricingV2HumanFieldLabel =
  z.infer<typeof ForgewingPricingV2HumanFieldLabelSchema>;
export type ForgewingPricingV2HumanLabelPackage =
  z.infer<typeof ForgewingPricingV2HumanLabelPackageSchema>;
export type ForgewingPricingV2HumanLabelPackageBody =
  z.infer<typeof packageWithoutAttestationSchema>;
export type ForgewingPricingV2HumanAttestationBody =
  z.infer<typeof attestationWithoutDigestSchema>;

export type ForgewingPricingV2AcceptedPhaseBBinding = Readonly<{
  preparationArtifactSha256: string;
  reportDigestSha256: string;
  preparationImplementationCommit: string;
  expectedPreparationDigests: readonly string[];
  expectedRowCount: number;
  expectedFieldCount: number;
  expectedMemberObservationCount: number;
  expectedSourceFieldIds: readonly string[];
}>;

export type ForgewingPricingV2PreparedFieldIdentity = Readonly<{
  sourceFieldId: string;
  sourceObservationIds: readonly string[];
  sourceDocumentId: string;
  sourceArtifactId: string;
  physicalPageNumber: number;
  rowObservationId: string;
  sourceFieldRole: z.infer<typeof ForgewingSourceFieldRoleSchema>;
}>;

export type ForgewingPricingV2ValidatedPhaseBScope = Readonly<{
  preparationArtifactSha256: string;
  reportDigestSha256: string;
  preparationImplementationCommit: string;
  preparationDigests: readonly string[];
  rowIds: readonly string[];
  fields: readonly ForgewingPricingV2PreparedFieldIdentity[];
  memberObservationCount: number;
}>;

export type ForgewingPricingV2HumanLabelViolation =
  | 'artifact_bytes_invalid'
  | 'artifact_sha256_mismatch'
  | 'artifact_contract_mismatch'
  | 'report_digest_mismatch'
  | 'preparation_digest_mismatch'
  | 'implementation_commit_mismatch'
  | 'ordering_not_deterministic'
  | 'scope_mismatch'
  | 'duplicate_source_field'
  | 'source_field_identity_mismatch'
  | 'member_identity_mismatch'
  | 'package_schema_rejected'
  | 'package_binding_mismatch'
  | 'package_digest_mismatch'
  | 'attestation_digest_mismatch'
  | 'duplicate_contribution_label'
  | 'missing_contribution_label'
  | 'foreign_observation_contribution'
  | 'abstention_contract_mismatch'
  | 'review_incomplete'
  | 'attestation_mismatch';

type ValidationResult<T> = Readonly<
  { status: 'valid'; value: T }
  | { status: 'rejected'; violations: readonly ForgewingPricingV2HumanLabelViolation[] }
>;

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord : null;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort((left, right) => left.localeCompare(right, 'en-US'));
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rejected<T>(violations: Iterable<ForgewingPricingV2HumanLabelViolation>): ValidationResult<T> {
  return { status: 'rejected', violations: sorted([...new Set(violations)]) as
    ForgewingPricingV2HumanLabelViolation[] };
}

function parseArtifactBytes(bytes: Uint8Array): unknown | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Validates and flattens the accepted Phase B artifact without trusting its
 * persisted identity claims. Every sourceFieldId is independently rederived.
 */
export function validateForgewingPricingV2AcceptedPhaseBArtifact(params: {
  artifactBytes: Uint8Array;
  expected: ForgewingPricingV2AcceptedPhaseBBinding;
}): ValidationResult<ForgewingPricingV2ValidatedPhaseBScope> {
  const violations = new Set<ForgewingPricingV2HumanLabelViolation>();
  if (!(params.artifactBytes instanceof Uint8Array) || params.artifactBytes.byteLength === 0) {
    return rejected(['artifact_bytes_invalid']);
  }
  const artifactSha = sha256Hex(params.artifactBytes);
  if (artifactSha !== params.expected.preparationArtifactSha256) {
    violations.add('artifact_sha256_mismatch');
  }
  const parsed = parseArtifactBytes(params.artifactBytes);
  const artifact = record(parsed);
  if (!artifact) return rejected([...violations, 'artifact_contract_mismatch']);
  const reportDigest = artifact.reportDigestSha256;
  const implementation = record(artifact.implementation);
  if (artifact.reportVersion !== 'forgewing-pricing-proposal-v2-phase-b-v1'
    || artifact.proposalVersion !== FORGEWING_PRICING_INTERPRETATION_PROPOSAL_V2_SCHEMA_VERSION
    || artifact.authority !== 'non_authoritative_preparation'
    || artifact.providerCalls !== 0
    || artifact.promotionAuthorized !== false
    || artifact.promotionEvidence !== false
    || !implementation
    || implementation.commit !== params.expected.preparationImplementationCommit
    || implementation.worktreeDirty !== false
    || !Array.isArray(artifact.sources)) {
    violations.add('artifact_contract_mismatch');
  }
  if (implementation?.commit !== params.expected.preparationImplementationCommit) {
    violations.add('implementation_commit_mismatch');
  }
  const { reportDigestSha256: _storedReportDigest, ...unsignedReport } = artifact;
  if (reportDigest !== params.expected.reportDigestSha256
    || typeof reportDigest !== 'string'
    || hashCanonical(unsignedReport) !== reportDigest) {
    violations.add('report_digest_mismatch');
  }

  const preparationDigests: string[] = [];
  const rowIds: string[] = [];
  const fields: ForgewingPricingV2PreparedFieldIdentity[] = [];
  for (const sourceValue of Array.isArray(artifact.sources) ? artifact.sources : []) {
    const source = record(sourceValue);
    const preparation = record(source?.preparation);
    if (!source || !preparation) {
      violations.add('artifact_contract_mismatch');
      continue;
    }
    const preparationDigest = preparation.preparationDigestSha256;
    const { preparationDigestSha256: _storedPreparationDigest, ...unsignedPreparation } = preparation;
    if (typeof preparationDigest !== 'string'
      || hashCanonical(unsignedPreparation) !== preparationDigest) {
      violations.add('preparation_digest_mismatch');
    } else {
      preparationDigests.push(preparationDigest);
    }
    const compatibility = record(preparation.v1Compatibility);
    if (compatibility?.orderingDeterministic !== true) {
      violations.add('ordering_not_deterministic');
    }
    if (!Array.isArray(preparation.rows)) {
      violations.add('artifact_contract_mismatch');
      continue;
    }
    for (const rowValue of preparation.rows) {
      const preparedRow = record(rowValue);
      const context = record(preparedRow?.context);
      if (!preparedRow || !context || !Array.isArray(preparedRow.fields)
        || preparedRow.exactMembershipClosure !== true
        || typeof preparedRow.rowObservationId !== 'string'
        || preparedRow.rowObservationId !== context.rowObservationId) {
        violations.add('member_identity_mismatch');
        continue;
      }
      rowIds.push(preparedRow.rowObservationId);
      const rowMembers = new Set<string>();
      for (const fieldValue of preparedRow.fields) {
        const preparedField = record(fieldValue);
        const field = record(preparedField?.field);
        if (!preparedField || !field || !Array.isArray(field.sourceObservationIds)
          || !field.sourceObservationIds.every((id) => typeof id === 'string')
          || !Array.isArray(preparedField.primitiveEvidence)) {
          violations.add('member_identity_mismatch');
          continue;
        }
        const sourceObservationIds = field.sourceObservationIds as string[];
        const primitiveIds = preparedField.primitiveEvidence.map((value) => record(value)?.observationId);
        if (new Set(sourceObservationIds).size !== sourceObservationIds.length
          || primitiveIds.some((id) => typeof id !== 'string')
          || !sameOrdered(primitiveIds as string[], sourceObservationIds)
          || sourceObservationIds.some((id) => rowMembers.has(id))) {
          violations.add('member_identity_mismatch');
        }
        sourceObservationIds.forEach((id) => rowMembers.add(id));
        const sourceFieldRole = ForgewingSourceFieldRoleSchema.safeParse(field.sourceFieldRole);
        const identity = {
          sourceFieldId: field.sourceFieldId,
          sourceObservationIds,
          sourceDocumentId: context.sourceDocumentId,
          sourceArtifactId: context.sourceArtifactId,
          physicalPageNumber: context.physicalPageNumber,
          rowObservationId: context.rowObservationId,
          sourceFieldRole: sourceFieldRole.data,
        };
        if (typeof identity.sourceFieldId !== 'string'
          || typeof identity.sourceDocumentId !== 'string'
          || typeof identity.sourceArtifactId !== 'string'
          || typeof identity.rowObservationId !== 'string'
          || typeof identity.physicalPageNumber !== 'number'
          || !sourceFieldRole.success
          || field.physicalPageNumber !== identity.physicalPageNumber) {
          violations.add('source_field_identity_mismatch');
          continue;
        }
        const expectedId = deriveSourceFieldId({
          sourceDocumentId: identity.sourceDocumentId,
          sourceArtifactId: identity.sourceArtifactId,
          physicalPageNumber: identity.physicalPageNumber,
          rowObservationId: identity.rowObservationId,
          sourceFieldRole: sourceFieldRole.data,
          sourceObservationIds,
        });
        if (identity.sourceFieldId !== expectedId) violations.add('source_field_identity_mismatch');
        if (preparedField.primitiveEvidence.some((value) => {
          const primitive = record(value);
          return !primitive
            || primitive.sourceDocumentId !== identity.sourceDocumentId
            || primitive.sourceArtifactId !== identity.sourceArtifactId
            || primitive.physicalPageNumber !== identity.physicalPageNumber;
        })) violations.add('member_identity_mismatch');
        fields.push(identity as ForgewingPricingV2PreparedFieldIdentity);
      }
    }
  }
  const fieldIds = fields.map((field) => field.sourceFieldId);
  if (new Set(fieldIds).size !== fieldIds.length) violations.add('duplicate_source_field');
  const memberCount = fields.reduce((count, field) => count + field.sourceObservationIds.length, 0);
  if (!sameOrdered(sorted(preparationDigests), sorted(params.expected.expectedPreparationDigests))) {
    violations.add('preparation_digest_mismatch');
  }
  if (rowIds.length !== params.expected.expectedRowCount
    || fields.length !== params.expected.expectedFieldCount
    || memberCount !== params.expected.expectedMemberObservationCount
    || !sameOrdered(sorted(fieldIds), sorted(params.expected.expectedSourceFieldIds))
    || artifact.combinedSourceFieldCount !== params.expected.expectedFieldCount
    || !Array.isArray(artifact.combinedDuplicateSourceFieldIds)
    || artifact.combinedDuplicateSourceFieldIds.length !== 0) {
    violations.add('scope_mismatch');
  }
  if (violations.size > 0) return rejected(violations);
  return { status: 'valid', value: {
    preparationArtifactSha256: artifactSha,
    reportDigestSha256: reportDigest as string,
    preparationImplementationCommit: params.expected.preparationImplementationCommit,
    preparationDigests: sorted(preparationDigests),
    rowIds: sorted(rowIds),
    fields: [...fields].sort((left, right) => left.sourceFieldId.localeCompare(
      right.sourceFieldId, 'en-US')),
    memberObservationCount: memberCount,
  } };
}

/** Digest of the immutable package body, deliberately excluding attestation. */
export function forgewingPricingV2HumanLabelPackageDigest(
  body: ForgewingPricingV2HumanLabelPackageBody,
): string {
  return hashCanonical(body);
}

export function forgewingPricingV2HumanAttestationDigest(
  body: ForgewingPricingV2HumanAttestationBody,
): string {
  return hashCanonical(body);
}

/** Validates a completed human-label package against its independently validated Phase B scope. */
export function validateForgewingPricingV2HumanLabelPackage(params: {
  package: unknown;
  phaseB: ForgewingPricingV2ValidatedPhaseBScope;
  expectedLabelWorkflowImplementationCommit: string;
}): ValidationResult<ForgewingPricingV2HumanLabelPackage> {
  const parsed = ForgewingPricingV2HumanLabelPackageSchema.safeParse(params.package);
  if (!parsed.success) return rejected(['package_schema_rejected']);
  const value = parsed.data;
  const violations = new Set<ForgewingPricingV2HumanLabelViolation>();
  const { packageDigestSha256, attestation, ...body } = value;
  if (forgewingPricingV2HumanLabelPackageDigest(body) !== packageDigestSha256) {
    violations.add('package_digest_mismatch');
  }
  const { attestationDigestSha256, ...attestationBody } = attestation;
  if (forgewingPricingV2HumanAttestationDigest(attestationBody) !== attestationDigestSha256) {
    violations.add('attestation_digest_mismatch');
  }
  if (value.preparationArtifactSha256 !== params.phaseB.preparationArtifactSha256
    || value.preparationReportDigestSha256 !== params.phaseB.reportDigestSha256
    || value.preparationImplementationCommit !== params.phaseB.preparationImplementationCommit
    || value.implementationCommit !== params.expectedLabelWorkflowImplementationCommit) {
    violations.add('package_binding_mismatch');
  }
  const phaseFields = new Map(params.phaseB.fields.map((field) => [field.sourceFieldId, field]));
  const suppliedIds = value.fields.map((field) => field.sourceFieldId);
  if (new Set(suppliedIds).size !== suppliedIds.length) violations.add('duplicate_source_field');
  if (value.fields.length !== phaseFields.size
    || suppliedIds.some((id) => !phaseFields.has(id))) violations.add('scope_mismatch');

  let contributionCount = 0;
  for (const label of value.fields) {
    const field = phaseFields.get(label.sourceFieldId);
    if (!field) continue;
    if (label.sourceDocumentId !== field.sourceDocumentId
      || label.sourceArtifactId !== field.sourceArtifactId
      || label.physicalPageNumber !== field.physicalPageNumber
      || label.rowObservationId !== field.rowObservationId
      || label.sourceFieldRole !== field.sourceFieldRole
      || !sameOrdered(sorted(label.sourceObservationIds), sorted(field.sourceObservationIds))) {
      violations.add('member_identity_mismatch');
    }
    const contributionIds = label.expectedContributions.map((item) => item.observationId);
    if (new Set(contributionIds).size !== contributionIds.length) {
      violations.add('duplicate_contribution_label');
    }
    if (contributionIds.some((id) => !field.sourceObservationIds.includes(id))) {
      violations.add('foreign_observation_contribution');
    }
    if (label.expectedInterpretationState === 'insufficient_evidence') {
      if (label.expectedSemanticRole !== 'unknown' || label.expectedContributions.length !== 0) {
        violations.add('abstention_contract_mismatch');
      }
    } else if (contributionIds.length !== field.sourceObservationIds.length
      || field.sourceObservationIds.some((id) => !contributionIds.includes(id))) {
      violations.add('missing_contribution_label');
    }
    contributionCount += label.expectedContributions.length;
    if (label.reviewStatus !== 'confirmed' || !label.semanticRoleConfirmed
      || !label.explicitlyConfirmed) violations.add('review_incomplete');
  }
  const sourceFieldIds = sorted(params.phaseB.fields.map((field) => field.sourceFieldId));
  if (value.scope.rowCount !== params.phaseB.rowIds.length
    || value.scope.fieldCount !== params.phaseB.fields.length
    || value.scope.memberObservationCount !== params.phaseB.memberObservationCount
    || value.scope.labelledContributionCount !== contributionCount
    || value.scope.sourceFieldIdsSha256 !== hashCanonical(sourceFieldIds)) {
    violations.add('scope_mismatch');
  }
  if (attestation.packageDigestSha256 !== packageDigestSha256
    || attestation.preparationArtifactSha256 !== value.preparationArtifactSha256
    || attestation.preparationReportDigestSha256 !== value.preparationReportDigestSha256
    || attestation.implementationCommit !== value.implementationCommit
    || attestation.reviewer !== value.fields[0]?.reviewer
    || attestation.reviewedAt !== value.fields[0]?.reviewedAt
    || value.fields.some((field) => field.reviewer !== attestation.reviewer
      || field.reviewedAt !== attestation.reviewedAt)) {
    violations.add('attestation_mismatch');
  }
  if (violations.size > 0) return rejected(violations);
  return { status: 'valid', value };
}
