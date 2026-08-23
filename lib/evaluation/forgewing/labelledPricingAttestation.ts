import { z } from 'zod';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import {
  auditLabelledPricingA3Ledger,
  type LabelledPricingA3LabelAudit,
} from '@/lib/evaluation/forgewing/labelledPricingA3';

export const FORGEWING_LABEL_ATTESTATION_VERSION =
  'forgewing-label-attestation-v1' as const;
export const FORGEWING_LABEL_ATTESTATION_STATEMENT =
  'I verified every in-scope label against the bound source artifact for evaluation use only.' as const;

const identifier = z.string().min(1).max(500)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sortedUniqueIdentifiers = z.array(identifier).min(1).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'duplicate label observation id' });
  }
  const sorted = [...values].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (values.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: 'custom', message: 'label observation ids must be sorted' });
  }
});

const scopeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('FULL_PACKAGE'),
    every_scored_label_reviewed: z.literal(true),
    label_observation_ids: sortedUniqueIdentifiers,
    label_observation_ids_sha256: sha256,
  }).strict(),
  z.object({
    kind: z.literal('SCORING_SUBSET'),
    every_scored_label_reviewed: z.literal(true),
    label_observation_ids: sortedUniqueIdentifiers,
    label_observation_ids_sha256: sha256,
  }).strict(),
]);

const unsignedAttestationSchema = z.object({
  attestation_version: z.literal(FORGEWING_LABEL_ATTESTATION_VERSION),
  authority: z.literal('evaluation_ground_truth_only'),
  status: z.literal('human_verified'),
  statement: z.literal(FORGEWING_LABEL_ATTESTATION_STATEMENT),
  label_package: z.object({
    ledger_version: identifier,
    ledger_sha256: sha256,
    ledger_byte_length: z.number().int().positive(),
    deterministic_package_digest: sha256,
  }).strict(),
  source_artifact: z.object({
    sha256,
    byte_length: z.number().int().positive(),
    pages: z.number().int().positive(),
  }).strict(),
  linkage_manifest_sha256: sha256,
  reviewer: z.object({
    stable_handle: identifier,
    reviewed_at: z.string().datetime({ offset: true }),
  }).strict(),
  scope: scopeSchema,
  notes: z.string().max(4_000).optional(),
}).strict();

const attestationSchema = unsignedAttestationSchema.extend({
  attestation_digest_sha256: sha256,
}).strict();

export type ForgewingLabelAttestation = z.infer<typeof attestationSchema>;
export type ForgewingLabelAttestationScope = z.infer<typeof scopeSchema>;

export type ForgewingLabelAttestationFailure =
  | 'attestation_missing'
  | 'attestation_schema_rejected'
  | 'attestation_digest_mismatch'
  | 'label_package_digest_mismatch'
  | 'source_artifact_digest_mismatch'
  | 'attestation_scope_digest_mismatch'
  | 'attestation_scope_unknown_label';

export type ForgewingLabelAttestationValidation = Readonly<{
  status: 'human_attestation_valid' | 'human_attestation_invalid';
  failureReasons: readonly ForgewingLabelAttestationFailure[];
  authority: 'evaluation_ground_truth_only';
  promotionAuthorized: false;
  attestedLabelObservationIds: readonly string[];
  linkageManifestSha256: string | null;
  audit: LabelledPricingA3LabelAudit;
}>;

function scoredLabelIds(audit: LabelledPricingA3LabelAudit): string[] {
  return audit.expectedLabels.map((label) => label.labelObservationId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function labelObservationIdsDigest(ids: readonly string[]): string {
  return hashCanonical([...ids].sort((left, right) => left.localeCompare(right, 'en-US')));
}

export function forgewingLabelAttestationDigest(
  attestation: Omit<ForgewingLabelAttestation, 'attestation_digest_sha256'>,
): string {
  return hashCanonical(attestation);
}

export function validateForgewingLabelAttestation(params: {
  ledgerBytes: Uint8Array;
  attestation: unknown;
}): ForgewingLabelAttestationValidation {
  const ledgerText = new TextDecoder().decode(params.ledgerBytes);
  const ledger = JSON.parse(ledgerText) as unknown;
  const audit = auditLabelledPricingA3Ledger(ledger);
  const rejected = attestationSchema.safeParse(params.attestation);
  if (!rejected.success) {
    return {
      status: 'human_attestation_invalid',
      failureReasons: ['attestation_schema_rejected'],
      authority: 'evaluation_ground_truth_only',
      promotionAuthorized: false,
      attestedLabelObservationIds: [],
      linkageManifestSha256: null,
      audit,
    };
  }
  const attestation = rejected.data;
  const { attestation_digest_sha256: suppliedDigest, ...unsigned } = attestation;
  const failures = new Set<ForgewingLabelAttestationFailure>();
  if (forgewingLabelAttestationDigest(unsigned) !== suppliedDigest) {
    failures.add('attestation_digest_mismatch');
  }
  if (attestation.label_package.ledger_sha256 !== sha256Hex(params.ledgerBytes)
    || attestation.label_package.ledger_byte_length !== params.ledgerBytes.byteLength
    || attestation.label_package.deterministic_package_digest !== hashCanonical(ledger)
    || attestation.label_package.ledger_version !== audit.package.ledgerVersion) {
    failures.add('label_package_digest_mismatch');
  }
  if (attestation.source_artifact.sha256 !== audit.source.sha256
    || attestation.source_artifact.byte_length !== audit.source.byteLength
    || attestation.source_artifact.pages !== audit.source.pages) {
    failures.add('source_artifact_digest_mismatch');
  }
  const allScoredIds = scoredLabelIds(audit);
  const scopedIds = attestation.scope.label_observation_ids;
  if (attestation.scope.label_observation_ids_sha256 !== labelObservationIdsDigest(scopedIds)) {
    failures.add('attestation_scope_digest_mismatch');
  }
  const knownIds = new Set(allScoredIds);
  if (scopedIds.some((id) => !knownIds.has(id))) {
    failures.add('attestation_scope_unknown_label');
  }
  if (attestation.scope.kind === 'FULL_PACKAGE'
    && (scopedIds.length !== allScoredIds.length
      || scopedIds.some((id, index) => id !== allScoredIds[index]))) {
    failures.add('attestation_scope_unknown_label');
  }
  return {
    status: failures.size === 0 ? 'human_attestation_valid' : 'human_attestation_invalid',
    failureReasons: [...failures].sort(),
    authority: 'evaluation_ground_truth_only',
    promotionAuthorized: false,
    attestedLabelObservationIds: failures.size === 0 ? scopedIds : [],
    linkageManifestSha256: failures.size === 0
      ? attestation.linkage_manifest_sha256 : null,
    audit,
  };
}

export function buildForgewingLabelAttestationTemplate(params: {
  ledgerBytes: Uint8Array;
}): Readonly<Record<string, unknown>> {
  const ledgerText = new TextDecoder().decode(params.ledgerBytes);
  const ledger = JSON.parse(ledgerText) as unknown;
  const audit = auditLabelledPricingA3Ledger(ledger);
  const ids = scoredLabelIds(audit);
  return {
    template_only: true,
    template_instructions: [
      'Review every listed scoring label against the exact bound source PDF.',
      'Do not complete this attestation until an exact modern-observation linkage manifest has been reviewed; never infer links from row number, text, value, or geometry.',
      'Fill linkage_manifest_sha256 with the SHA-256 of the exact reviewed linkage manifest bytes.',
      'Fill the blank human fields only after completing that review.',
      'Remove template_only and template_instructions, then compute attestation_digest_sha256 over all remaining fields except that digest.',
      'This attestation authorizes evaluation ground truth only and never promotion or publication.',
    ],
    attestation_version: FORGEWING_LABEL_ATTESTATION_VERSION,
    authority: 'evaluation_ground_truth_only',
    status: '',
    statement: '',
    label_package: {
      ledger_version: audit.package.ledgerVersion,
      ledger_sha256: sha256Hex(params.ledgerBytes),
      ledger_byte_length: params.ledgerBytes.byteLength,
      deterministic_package_digest: hashCanonical(ledger),
    },
    source_artifact: {
      sha256: audit.source.sha256,
      byte_length: audit.source.byteLength,
      pages: audit.source.pages,
    },
    linkage_manifest_sha256: '',
    reviewer: { stable_handle: '', reviewed_at: '' },
    scope: {
      kind: 'FULL_PACKAGE',
      every_scored_label_reviewed: true,
      label_observation_ids: ids,
      label_observation_ids_sha256: labelObservationIdsDigest(ids),
    },
    notes: '',
    attestation_digest_sha256: '',
  };
}
