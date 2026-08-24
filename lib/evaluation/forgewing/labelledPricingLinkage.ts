import { z } from 'zod';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import type { LabelledPricingA3LabelAudit } from '@/lib/evaluation/forgewing/labelledPricingA3';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';

export const FORGEWING_LABEL_LINKAGE_VERSION = 'forgewing-label-linkage-v1' as const;

const identifier = z.string().min(1).max(500)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const sortedUniqueIdentifiers = z.array(identifier).min(1).superRefine((values, context) => {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: 'custom', message: 'duplicate identity' });
  }
  const sorted = [...values].sort((left, right) => left.localeCompare(right, 'en-US'));
  if (values.some((value, index) => value !== sorted[index])) {
    context.addIssue({ code: 'custom', message: 'identities must be sorted' });
  }
});

const unsignedManifestSchema = z.object({
  linkage_version: z.literal(FORGEWING_LABEL_LINKAGE_VERSION),
  authority: z.literal('evaluation_linkage_only'),
  label_package_sha256: sha256,
  source: z.object({
    source_pdf_sha256: sha256,
    source_document_id: identifier,
    source_artifact_id: identifier,
    extraction_snapshot_id: identifier,
  }).strict(),
  records: z.array(z.object({
    label_observation_id: identifier,
    label_row_identity: identifier,
    label_role: z.enum(['description', 'unit', 'cost']),
    label_raw_text_sha256: sha256,
    physical_page: z.number().int().positive(),
    candidate_row_id: identifier,
    source_observation_ids: sortedUniqueIdentifiers,
    linkage_record_digest_sha256: sha256,
  }).strict()).min(1),
}).strict();

const manifestSchema = unsignedManifestSchema.extend({ manifest_digest_sha256: sha256 }).strict();
export type ForgewingLabelLinkageManifest = z.infer<typeof manifestSchema>;
export type ForgewingLabelLinkageRecord = ForgewingLabelLinkageManifest['records'][number];

export function parseForgewingLabelLinkageManifest(input: unknown): ForgewingLabelLinkageManifest {
  return manifestSchema.parse(input);
}

export type ForgewingCandidateLabelLinkage = Readonly<{
  candidateId: string;
  rowId: string;
  sourceAnchorIds: readonly string[];
  linkedLabelObservationIds: readonly string[];
  linkedRoles: readonly ('description' | 'unit' | 'cost')[];
  attestationScope: 'FULL_PACKAGE' | 'SCORING_SUBSET' | 'UNATTESTED';
  linkageStatus: 'exact_linkage_complete' | 'missing_label_linkage' | 'unattested_linkage';
}>;

export type ForgewingLabelLinkageValidation = Readonly<{
  status: 'label_linkage_ready' | 'label_linkage_gap';
  failureReasons: readonly string[];
  candidateLinkages: readonly ForgewingCandidateLabelLinkage[];
  scoredLabelObservationIds: readonly string[];
  promotionAuthorized: false;
}>;

export function forgewingLabelLinkageRecordDigest(
  record: Omit<ForgewingLabelLinkageRecord, 'linkage_record_digest_sha256'>,
): string {
  return hashCanonical(record);
}

export function forgewingLabelLinkageManifestDigest(
  manifest: Omit<ForgewingLabelLinkageManifest, 'manifest_digest_sha256'>,
): string {
  return hashCanonical({
    ...manifest,
    records: [...manifest.records].sort((left, right) =>
      left.label_observation_id.localeCompare(right.label_observation_id, 'en-US')),
  });
}

export function validateForgewingLabelLinkage(params: {
  manifest: unknown;
  labelPackageSha256: string;
  sourcePdfSha256: string;
  linkageManifestSha256: string;
  attestedLinkageManifestSha256: string;
  audit: LabelledPricingA3LabelAudit;
  candidates: readonly ForgewingPricingInterpretationInput[];
  attestedLabelObservationIds: readonly string[];
  attestationScope: 'FULL_PACKAGE' | 'SCORING_SUBSET' | 'UNATTESTED';
}): ForgewingLabelLinkageValidation {
  const parsed = manifestSchema.safeParse(params.manifest);
  if (!parsed.success) {
    return {
      status: 'label_linkage_gap', failureReasons: ['linkage_manifest_schema_rejected'],
      candidateLinkages: [], scoredLabelObservationIds: [], promotionAuthorized: false,
    };
  }
  const manifest = parsed.data;
  const failures = new Set<string>();
  if (params.linkageManifestSha256 !== params.attestedLinkageManifestSha256) {
    failures.add('unattested_linkage_manifest');
  }
  const { manifest_digest_sha256: suppliedManifestDigest, ...unsignedManifest } = manifest;
  if (forgewingLabelLinkageManifestDigest(unsignedManifest) !== suppliedManifestDigest) {
    failures.add('linkage_manifest_digest_mismatch');
  }
  if (manifest.label_package_sha256 !== params.labelPackageSha256) {
    failures.add('linkage_label_package_mismatch');
  }
  if (manifest.source.source_pdf_sha256 !== params.sourcePdfSha256) {
    failures.add('linkage_source_pdf_mismatch');
  }
  const firstCandidate = params.candidates[0];
  if (firstCandidate && (manifest.source.source_document_id !== firstCandidate.sourceDocumentId
    || manifest.source.source_artifact_id !== firstCandidate.sourceArtifactId
    || manifest.source.extraction_snapshot_id !== firstCandidate.extractionSnapshotId)) {
    failures.add('linkage_modern_source_identity_mismatch');
  }
  for (const candidate of params.candidates) {
    if (candidate.sourceDocumentId !== manifest.source.source_document_id
      || candidate.sourceArtifactId !== manifest.source.source_artifact_id
      || candidate.extractionSnapshotId !== manifest.source.extraction_snapshot_id
      || candidate.rowObservation.cells.some((cell) =>
        cell.sourceDocumentId !== manifest.source.source_document_id
        || cell.sourceArtifactId !== manifest.source.source_artifact_id
        || cell.physicalPageNumber !== candidate.rowObservation.physicalPageNumber)) {
      failures.add('linkage_modern_source_identity_mismatch');
    }
  }
  const labels = new Map(params.audit.expectedLabels.map((label) => [label.labelObservationId, label]));
  const candidates = new Map(params.candidates.map((candidate) =>
    [candidate.rowObservation.observationId, candidate]));
  const seenLabels = new Set<string>();
  const seenSourceObservations = new Set<string>();
  for (const record of manifest.records) {
    const { linkage_record_digest_sha256: suppliedRecordDigest, ...unsignedRecord } = record;
    if (forgewingLabelLinkageRecordDigest(unsignedRecord) !== suppliedRecordDigest) {
      failures.add('linkage_record_digest_mismatch');
    }
    if (seenLabels.has(record.label_observation_id)) failures.add('duplicate_label_linkage');
    seenLabels.add(record.label_observation_id);
    for (const sourceObservationId of record.source_observation_ids) {
      if (seenSourceObservations.has(sourceObservationId)) {
        failures.add('duplicate_source_observation_linkage');
      }
      seenSourceObservations.add(sourceObservationId);
    }
    const label = labels.get(record.label_observation_id);
    if (!label) {
      failures.add('unknown_label_observation_id');
      continue;
    }
    if (label.rowIdentity !== record.label_row_identity
      || label.labelRole !== record.label_role
      || label.rawTextSha256 !== record.label_raw_text_sha256) {
      failures.add('label_identity_or_role_mismatch');
    }
    if (label.sourcePage !== record.physical_page) failures.add('label_page_mismatch');
    const candidate = candidates.get(record.candidate_row_id);
    if (!candidate) {
      failures.add('unknown_candidate_row_id');
      continue;
    }
    if (candidate.rowObservation.physicalPageNumber !== record.physical_page) {
      failures.add('candidate_page_mismatch');
    }
    const anchors = new Set(candidate.rowObservation.cells.map((cell) => cell.observationId));
    if (record.source_observation_ids.some((id) => !anchors.has(id))) {
      failures.add('foreign_source_observation_id');
    }
  }
  const attested = new Set(params.attestedLabelObservationIds);
  const candidateLinkages = [...params.candidates]
    .sort((left, right) => left.rowObservation.observationId
      .localeCompare(right.rowObservation.observationId, 'en-US'))
    .map((candidate) => {
      const candidateId = hashCanonical(candidate);
      const records = manifest.records.filter((record) =>
        record.candidate_row_id === candidate.rowObservation.observationId);
      const linkedIds = records.map((record) => record.label_observation_id)
        .sort((left, right) => left.localeCompare(right, 'en-US'));
      const allAttested = linkedIds.length > 0 && linkedIds.every((id) => attested.has(id));
      const roles = [...new Set(records.map((record) => record.label_role))]
        .sort((left, right) => left.localeCompare(right, 'en-US'));
      const expectedRoles = new Set(candidate.rowObservation.cells
        .flatMap((cell) => cell.semanticHints ?? [])
        .flatMap((hint) => hint === 'description_like_text' ? ['description' as const]
          : hint === 'unit_like_text' ? ['unit' as const]
          : hint === 'rate_like_amount' ? ['cost' as const] : []));
      if ([...expectedRoles].some((role) => !roles.includes(role))) {
        failures.add('missing_role_linkage');
      }
      return {
        candidateId,
        rowId: candidate.rowObservation.observationId,
        sourceAnchorIds: candidate.rowObservation.cells.map((cell) => cell.observationId),
        linkedLabelObservationIds: linkedIds,
        linkedRoles: roles,
        attestationScope: params.attestationScope,
        linkageStatus: linkedIds.length === 0
          ? 'missing_label_linkage' as const
          : allAttested ? 'exact_linkage_complete' as const : 'unattested_linkage' as const,
      };
    });
  if (candidateLinkages.some((linkage) => linkage.linkageStatus === 'missing_label_linkage')) {
    failures.add('missing_label_linkage');
  }
  const scoredLabelObservationIds = candidateLinkages
    .filter((linkage) => linkage.linkageStatus === 'exact_linkage_complete')
    .flatMap((linkage) => linkage.linkedLabelObservationIds)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  return {
    status: failures.size === 0 ? 'label_linkage_ready' : 'label_linkage_gap',
    failureReasons: [...failures].sort(),
    candidateLinkages,
    scoredLabelObservationIds: failures.size === 0 ? scoredLabelObservationIds : [],
    promotionAuthorized: false,
  };
}
