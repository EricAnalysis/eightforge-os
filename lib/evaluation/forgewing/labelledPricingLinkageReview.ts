import { z } from 'zod';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import type { PdfLayoutTokenObservation } from '@/lib/extraction/pdf/layoutObservationEvidence';
import {
  parseLabelledPricingA3Ledger,
  type LabelledPricingA3Ledger,
  type LabelledPricingA3Observation,
} from '@/lib/evaluation/forgewing/labelledPricingA3';
import {
  FORGEWING_LABEL_LINKAGE_VERSION,
  forgewingLabelLinkageManifestDigest,
  forgewingLabelLinkageRecordDigest,
  type ForgewingLabelLinkageManifest,
} from '@/lib/evaluation/forgewing/labelledPricingLinkage';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';

export const FORGEWING_LABEL_LINKAGE_REVIEW_PACKET_VERSION =
  'forgewing-label-linkage-review-packet-v1' as const;
export const FORGEWING_LABEL_LINKAGE_REVIEW_INPUT_VERSION =
  'forgewing-label-linkage-review-input-v1' as const;

const identifier = z.string().min(1).max(500)
  .refine((value) => value.trim() === value, 'identifier whitespace');
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const bboxSchema = z.object({
  x_min: z.number().finite(), x_max: z.number().finite(),
  y_min: z.number().finite(), y_max: z.number().finite(),
}).strict().refine((bbox) => bbox.x_min < bbox.x_max && bbox.y_min < bbox.y_max,
  'invalid bounding box');

const modernObservationSchema = z.object({
  observation_id: identifier,
  evidence_object_id: identifier,
  kind: z.literal('pdf_layout_token'),
  raw_text: z.string(),
  bbox: bboxSchema,
  source_method: z.enum(['pdfjs', 'ocr_fallback']),
  physical_page: z.number().int().positive(),
  source_document_id: identifier,
  source_artifact_id: identifier,
  extraction_snapshot_id: identifier,
  candidate_row_id: identifier,
  candidate_admitted: z.boolean(),
  parser: identifier.nullable(),
  parser_observation_key: identifier.nullable(),
  page_representation_digest: sha256.nullable(),
}).strict();

const packetLabelSchema = z.object({
  label_observation_id: identifier,
  field_identifier: identifier,
  role: z.enum(['description', 'unit', 'cost']),
  legacy_labelled_value: z.string(),
  legacy_raw_text_sha256: sha256,
  legacy_row_identity: identifier,
  physical_page: z.number().int().positive(),
  legacy_source_evidence: z.object({
    source_pdf_sha256: sha256,
    coordinate_space: identifier.nullable(),
    bbox: bboxSchema,
    page_width_points: z.number().finite().positive(),
    page_height_points: z.number().finite().positive(),
    generation_method_id: identifier.nullable(),
    evidence_status: identifier.nullable(),
  }).strict(),
  candidate_row_id: identifier,
  candidate_id: sha256,
  modern_candidate_source_anchor_ids: z.array(identifier).min(1),
  modern_pdf_layout_token_observations: z.array(modernObservationSchema).min(1),
}).strict();

const unsignedPacketSchema = z.object({
  packet_version: z.literal(FORGEWING_LABEL_LINKAGE_REVIEW_PACKET_VERSION),
  authority: z.literal('evaluation_ground_truth_only'),
  presentation_only: z.literal(true),
  machine_selection_prohibited: z.literal(true),
  label_package: z.object({
    ledger_version: identifier,
    ledger_sha256: sha256,
    ledger_byte_length: z.number().int().positive(),
  }).strict(),
  source: z.object({
    source_pdf_sha256: sha256,
    source_byte_length: z.number().int().positive(),
    source_pages: z.number().int().positive(),
    source_document_id: identifier,
    source_artifact_id: identifier,
    extraction_snapshot_id: identifier,
  }).strict(),
  review_scope: z.object({
    kind: z.literal('SCORING_SUBSET'),
    candidate_row_ids: z.array(identifier).min(1),
    label_observation_ids: z.array(identifier).min(1),
    label_observation_ids_sha256: sha256,
  }).strict(),
  labels: z.array(packetLabelSchema).min(1),
}).strict();

const packetSchema = unsignedPacketSchema.extend({ packet_digest_sha256: sha256 }).strict();

const linkedReviewRecordSchema = z.object({
  label_observation_id: identifier,
  candidate_row_id: identifier,
  reviewer_decision: z.literal('linked'),
  selected_observation_ids: z.array(identifier).min(1),
  notes: z.string().max(4_000).optional(),
}).strict();
const unresolvedReviewRecordSchema = z.object({
  label_observation_id: identifier,
  candidate_row_id: identifier,
  reviewer_decision: z.enum(['not_linkable', 'needs_follow_up']),
  selected_observation_ids: z.array(identifier).max(0),
  notes: z.string().max(4_000).optional(),
}).strict();
const completedReviewInputSchema = z.object({
  review_input_version: z.literal(FORGEWING_LABEL_LINKAGE_REVIEW_INPUT_VERSION),
  authority: z.literal('evaluation_ground_truth_only'),
  review_packet_digest_sha256: sha256,
  records: z.array(z.union([linkedReviewRecordSchema, unresolvedReviewRecordSchema])).min(1),
}).strict();

export type ForgewingLabelLinkageReviewPacket = z.infer<typeof packetSchema>;
export type ForgewingLabelLinkageReviewInput = z.infer<typeof completedReviewInputSchema>;

export type ForgewingLabelReviewRowBinding = Readonly<{
  candidateRowId: string;
  legacyRowIdentity: string;
}>;

export type ForgewingLabelLinkageReviewGeneration = Readonly<{
  status: 'manifest_ready' | 'review_incomplete' | 'review_rejected';
  failureReasons: readonly string[];
  manifest: ForgewingLabelLinkageManifest | null;
  canonicalSelections: readonly Readonly<{
    labelObservationId: string;
    selectedObservationIds: readonly string[];
    reviewerDecision: 'linked' | 'not_linkable' | 'needs_follow_up';
  }>[];
}>;

function metadataString(observation: PdfLayoutTokenObservation, key: string): string | null {
  const value = observation.metadata?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function labelRole(observation: LabelledPricingA3Observation) {
  const role = observation.interpreted_field_or_role;
  return role === 'description' || role === 'unit' || role === 'cost' ? role : null;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, 'en-US'));
}

export function forgewingLabelLinkageReviewPacketDigest(
  packet: Omit<ForgewingLabelLinkageReviewPacket, 'packet_digest_sha256'>,
): string {
  return hashCanonical(packet);
}

export function buildForgewingLabelLinkageReviewPacket(params: {
  ledgerBytes: Uint8Array;
  source: Readonly<{
    sourcePdfSha256: string;
    sourceByteLength: number;
    sourcePages: number;
    sourceDocumentId: string;
    sourceArtifactId: string;
    extractionSnapshotId: string;
  }>;
  candidates: readonly ForgewingPricingInterpretationInput[];
  pricingLayoutObservations: readonly PdfLayoutTokenObservation[];
  rowBindings: readonly ForgewingLabelReviewRowBinding[];
}): ForgewingLabelLinkageReviewPacket {
  const ledgerInput = JSON.parse(new TextDecoder().decode(params.ledgerBytes)) as unknown;
  const ledger = parseLabelledPricingA3Ledger(ledgerInput);
  if (ledger.source_pdf.sha256 !== params.source.sourcePdfSha256
    || ledger.source_pdf.byte_length !== params.source.sourceByteLength
    || ledger.source_pdf.pages !== params.source.sourcePages) {
    throw new Error('SOURCE_MISMATCH');
  }
  const candidates = new Map(params.candidates.map((candidate) =>
    [candidate.rowObservation.observationId, candidate]));
  const expectedCandidateIds = sortedUnique(params.rowBindings.map((binding) => binding.candidateRowId));
  const actualCandidateIds = sortedUnique(params.candidates.map((candidate) =>
    candidate.rowObservation.observationId));
  if (expectedCandidateIds.length !== actualCandidateIds.length
    || expectedCandidateIds.some((id, index) => id !== actualCandidateIds[index])) {
    throw new Error('CANDIDATE_SET_CHANGED');
  }
  if (new Set(params.rowBindings.map((binding) => binding.legacyRowIdentity)).size
    !== params.rowBindings.length) {
    throw new Error('forgewing_label_review_duplicate_legacy_row');
  }
  const observations = new Map(params.pricingLayoutObservations.map((observation) =>
    [observation.id, observation]));
  const labels = params.rowBindings.flatMap((binding) => {
    const candidate = candidates.get(binding.candidateRowId);
    if (!candidate) throw new Error('CANDIDATE_SET_CHANGED');
    const rowLabels = ledger.observations.filter((observation) =>
      observation.row_identity === binding.legacyRowIdentity && labelRole(observation) != null);
    const roles = rowLabels.map((observation) => labelRole(observation));
    if (rowLabels.length !== 3 || !['description', 'unit', 'cost'].every((role) =>
      roles.filter((value) => value === role).length === 1)) {
      throw new Error('forgewing_label_review_row_scope_incomplete');
    }
    if (rowLabels.some((observation) =>
      observation.source_page !== candidate.rowObservation.physicalPageNumber
      || observation.source_pdf_sha256 !== params.source.sourcePdfSha256)) {
      throw new Error('SOURCE_MISMATCH');
    }
    const anchorIds = sortedUnique(candidate.rowObservation.cells.map((cell) => cell.observationId));
    const modern = anchorIds.map((observationId) => {
      const observation = observations.get(observationId);
      if (!observation
        || observation.kind !== 'pdf_layout_token'
        || observation.evidence_object_id !== observation.id
        || observation.source_document_id !== params.source.sourceDocumentId
        || observation.source_artifact_id !== params.source.sourceArtifactId
        || observation.physical_page_number !== candidate.rowObservation.physicalPageNumber
        || !observation.location.bounding_box) {
        throw new Error('forgewing_label_review_modern_observation_closure_failed');
      }
      return {
        observation_id: observation.id,
        evidence_object_id: observation.evidence_object_id,
        kind: 'pdf_layout_token' as const,
        raw_text: observation.raw_text,
        bbox: observation.location.bounding_box,
        source_method: observation.source_method,
        physical_page: observation.physical_page_number,
        source_document_id: observation.source_document_id,
        source_artifact_id: observation.source_artifact_id,
        extraction_snapshot_id: params.source.extractionSnapshotId,
        candidate_row_id: binding.candidateRowId,
        candidate_admitted: true,
        parser: metadataString(observation, 'parser'),
        parser_observation_key: metadataString(observation, 'parser_observation_key'),
        page_representation_digest: metadataString(observation, 'page_representation_digest'),
      };
    });
    return rowLabels.map((observation) => ({
      label_observation_id: observation.field_identifier,
      field_identifier: observation.field_identifier,
      role: labelRole(observation)!,
      legacy_labelled_value: observation.exact_raw_text,
      legacy_raw_text_sha256: observation.raw_text_sha256,
      legacy_row_identity: observation.row_identity,
      physical_page: observation.source_page,
      legacy_source_evidence: {
        source_pdf_sha256: observation.source_pdf_sha256,
        coordinate_space: observation.coordinate_space ?? null,
        bbox: {
          x_min: observation.bbox_x0, x_max: observation.bbox_x1,
          y_min: observation.bbox_y0, y_max: observation.bbox_y1,
        },
        page_width_points: observation.page_width_points,
        page_height_points: observation.page_height_points,
        generation_method_id: observation.generation_method_id ?? null,
        evidence_status: observation.evidence_status ?? null,
      },
      candidate_row_id: binding.candidateRowId,
      candidate_id: hashCanonical(candidate),
      modern_candidate_source_anchor_ids: anchorIds,
      modern_pdf_layout_token_observations: modern,
    }));
  }).sort((left, right) => left.label_observation_id
    .localeCompare(right.label_observation_id, 'en-US'));
  const labelIds = labels.map((label) => label.label_observation_id);
  const unsigned = unsignedPacketSchema.parse({
    packet_version: FORGEWING_LABEL_LINKAGE_REVIEW_PACKET_VERSION,
    authority: 'evaluation_ground_truth_only',
    presentation_only: true,
    machine_selection_prohibited: true,
    label_package: {
      ledger_version: ledger.ledger_version,
      ledger_sha256: sha256Hex(params.ledgerBytes),
      ledger_byte_length: params.ledgerBytes.byteLength,
    },
    source: {
      source_pdf_sha256: params.source.sourcePdfSha256,
      source_byte_length: params.source.sourceByteLength,
      source_pages: params.source.sourcePages,
      source_document_id: params.source.sourceDocumentId,
      source_artifact_id: params.source.sourceArtifactId,
      extraction_snapshot_id: params.source.extractionSnapshotId,
    },
    review_scope: {
      kind: 'SCORING_SUBSET',
      candidate_row_ids: expectedCandidateIds,
      label_observation_ids: labelIds,
      label_observation_ids_sha256: hashCanonical(labelIds),
    },
    labels,
  });
  return packetSchema.parse({
    ...unsigned,
    packet_digest_sha256: forgewingLabelLinkageReviewPacketDigest(unsigned),
  });
}

export function buildForgewingLabelLinkageReviewInputTemplate(
  packetInput: unknown,
): Readonly<Record<string, unknown>> {
  const packet = packetSchema.parse(packetInput);
  return {
    template_only: true,
    template_instructions: [
      'Inspect the row-wide modern observations presented for each legacy label.',
      'Set reviewer_decision to linked, not_linkable, or needs_follow_up.',
      'Only explicitly entered selected_observation_ids can become linkage.',
      'Do not infer selections from text, value, row number, geometry, role, or anchor order.',
      'Remove template_only and template_instructions before manifest generation.',
    ],
    review_input_version: FORGEWING_LABEL_LINKAGE_REVIEW_INPUT_VERSION,
    authority: 'evaluation_ground_truth_only',
    review_packet_digest_sha256: packet.packet_digest_sha256,
    records: packet.labels.map((label) => ({
      label_observation_id: label.label_observation_id,
      candidate_row_id: label.candidate_row_id,
      reviewer_decision: '',
      selected_observation_ids: [],
      notes: '',
    })),
  };
}

function rejected(reason: string): ForgewingLabelLinkageReviewGeneration {
  return {
    status: 'review_rejected', failureReasons: [reason], manifest: null,
    canonicalSelections: [],
  };
}

export function generateForgewingLabelLinkageManifestFromReview(params: {
  packet: unknown;
  reviewInput: unknown;
}): ForgewingLabelLinkageReviewGeneration {
  const parsedPacket = packetSchema.safeParse(params.packet);
  if (!parsedPacket.success) return rejected('review_packet_schema_rejected');
  const packet = parsedPacket.data;
  const { packet_digest_sha256: packetDigest, ...unsignedPacket } = packet;
  if (forgewingLabelLinkageReviewPacketDigest(unsignedPacket) !== packetDigest) {
    return rejected('review_packet_digest_mismatch');
  }
  const packetLabelIds = packet.labels.map((label) => label.label_observation_id)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const packetCandidateIds = sortedUnique(packet.labels.map((label) => label.candidate_row_id));
  if (packet.review_scope.label_observation_ids.length !== packetLabelIds.length
    || packet.review_scope.label_observation_ids.some((id, index) => id !== packetLabelIds[index])
    || packet.review_scope.label_observation_ids_sha256 !== hashCanonical(packetLabelIds)
    || packet.review_scope.candidate_row_ids.length !== packetCandidateIds.length
    || packet.review_scope.candidate_row_ids.some((id, index) => id !== packetCandidateIds[index])) {
    return rejected('review_packet_scope_mismatch');
  }
  const parsedReview = completedReviewInputSchema.safeParse(params.reviewInput);
  if (!parsedReview.success) return rejected('review_input_schema_rejected');
  const review = parsedReview.data;
  if (review.review_packet_digest_sha256 !== packetDigest) {
    return rejected('review_input_packet_mismatch');
  }
  const packetLabels = new Map(packet.labels.map((label) => [label.label_observation_id, label]));
  if (new Set(review.records.map((record) => record.label_observation_id)).size
    !== review.records.length) return rejected('duplicate_review_label');
  if (review.records.length !== packet.labels.length
    || review.records.some((record) => !packetLabels.has(record.label_observation_id))) {
    return rejected('incomplete_review_set');
  }
  const globalObservations = new Map(packet.labels.flatMap((label) =>
    label.modern_pdf_layout_token_observations.map((observation) =>
      [observation.observation_id, observation] as const)));
  const failures = new Set<string>();
  const canonicalSelections = review.records.map((record) => ({
    labelObservationId: record.label_observation_id,
    selectedObservationIds: sortedUnique(record.selected_observation_ids),
    reviewerDecision: record.reviewer_decision,
  })).sort((left, right) => left.labelObservationId
    .localeCompare(right.labelObservationId, 'en-US'));
  const linkageRecords = canonicalSelections.flatMap((selection) => {
    const label = packetLabels.get(selection.labelObservationId)!;
    const reviewRecord = review.records.find((record) =>
      record.label_observation_id === selection.labelObservationId)!;
    if (reviewRecord.candidate_row_id !== label.candidate_row_id) {
      failures.add('review_candidate_row_mismatch');
      return [];
    }
    if (selection.reviewerDecision !== 'linked') {
      failures.add(`${selection.reviewerDecision}:${selection.labelObservationId}`);
      return [];
    }
    const available = new Map(label.modern_pdf_layout_token_observations.map((observation) =>
      [observation.observation_id, observation]));
    for (const selectedId of selection.selectedObservationIds) {
      const observation = available.get(selectedId);
      const global = globalObservations.get(selectedId);
      if (!observation) {
        failures.add(global && global.candidate_row_id !== label.candidate_row_id
          ? 'observation_belongs_to_another_candidate_row'
          : 'unknown_observation_id');
        continue;
      }
      if (observation.kind !== 'pdf_layout_token'
        || observation.evidence_object_id !== observation.observation_id) {
        failures.add('selected_observation_not_pdf_layout_token');
      }
      if (!observation.parser || !observation.parser_observation_key
        || !observation.page_representation_digest) {
        failures.add('selected_observation_parser_identity_missing');
      }
      if (observation.source_document_id !== packet.source.source_document_id) {
        failures.add('selected_observation_wrong_document');
      }
      if (observation.source_artifact_id !== packet.source.source_artifact_id) {
        failures.add('selected_observation_wrong_artifact');
      }
      if (observation.extraction_snapshot_id !== packet.source.extraction_snapshot_id) {
        failures.add('selected_observation_wrong_snapshot');
      }
      if (observation.physical_page !== label.physical_page) {
        failures.add('selected_observation_wrong_page');
      }
      if (!observation.candidate_admitted
        || !label.modern_candidate_source_anchor_ids.includes(selectedId)) {
        failures.add('selected_observation_not_candidate_admitted');
      }
      if (observation.candidate_row_id !== label.candidate_row_id) {
        failures.add('observation_belongs_to_another_candidate_row');
      }
    }
    if (failures.size > 0) return [];
    const unsignedRecord = {
      label_observation_id: label.label_observation_id,
      label_row_identity: label.legacy_row_identity,
      label_role: label.role,
      label_raw_text_sha256: label.legacy_raw_text_sha256,
      physical_page: label.physical_page,
      candidate_row_id: label.candidate_row_id,
      source_observation_ids: selection.selectedObservationIds,
    };
    return [{
      ...unsignedRecord,
      linkage_record_digest_sha256: forgewingLabelLinkageRecordDigest(unsignedRecord),
    }];
  });
  if (failures.size > 0 || linkageRecords.length !== packet.labels.length) {
    return {
      status: failures.size > 0 && [...failures].every((reason) =>
        reason.startsWith('not_linkable:') || reason.startsWith('needs_follow_up:'))
        ? 'review_incomplete' : 'review_rejected',
      failureReasons: [...failures].sort(), manifest: null, canonicalSelections,
    };
  }
  const sortedRecords = linkageRecords.sort((left, right) =>
    left.label_observation_id.localeCompare(right.label_observation_id, 'en-US'));
  const unsignedManifest = {
    linkage_version: FORGEWING_LABEL_LINKAGE_VERSION,
    authority: 'evaluation_linkage_only' as const,
    label_package_sha256: packet.label_package.ledger_sha256,
    source: {
      source_pdf_sha256: packet.source.source_pdf_sha256,
      source_document_id: packet.source.source_document_id,
      source_artifact_id: packet.source.source_artifact_id,
      extraction_snapshot_id: packet.source.extraction_snapshot_id,
    },
    records: sortedRecords,
  };
  return {
    status: 'manifest_ready', failureReasons: [],
    manifest: {
      ...unsignedManifest,
      manifest_digest_sha256: forgewingLabelLinkageManifestDigest(unsignedManifest),
    },
    canonicalSelections,
  };
}

export function parseForgewingLabelLinkageReviewPacket(input: unknown) {
  return packetSchema.parse(input);
}

export function parseForgewingLabelLinkageReviewInput(input: unknown) {
  return completedReviewInputSchema.parse(input);
}

export function parseLedgerForForgewingLabelReview(input: unknown): LabelledPricingA3Ledger {
  return parseLabelledPricingA3Ledger(input);
}
