import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import type { PdfLayoutTokenObservation } from '@/lib/extraction/pdf/layoutObservationEvidence';
import { buildPreparedForgewingLabelAttestationTemplate } from
  '@/lib/evaluation/forgewing/labelledPricingAttestation';
import {
  buildForgewingLabelLinkageReviewInputTemplate,
  buildForgewingLabelLinkageReviewPacket,
  forgewingLabelLinkageReviewPacketDigest,
  generateForgewingLabelLinkageManifestFromReview,
  type ForgewingLabelLinkageReviewPacket,
} from '@/lib/evaluation/forgewing/labelledPricingLinkageReview';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';

const sourcePdfSha256 = 'a'.repeat(64);
const source = {
  sourcePdfSha256,
  sourceByteLength: 1_234,
  sourcePages: 3,
  sourceDocumentId: 'document-1',
  sourceArtifactId: 'artifact-1',
  extractionSnapshotId: 'snapshot-1',
};

function ledger() {
  const observation = (row: number, role: 'description' | 'unit' | 'cost') => {
    const id = `label-row-${row}-${role}`;
    return {
      field_identifier: id, source_pdf_sha256: sourcePdfSha256, source_page: 2,
      bbox_x0: 10, bbox_y0: 20 + row, bbox_x1: 40, bbox_y1: 30 + row,
      page_width_points: 600, page_height_points: 800,
      exact_raw_text: `${role}-${row}`, raw_text_sha256: sha256Hex(`${role}-${row}`),
      interpreted_field_or_role: role, row_identity: `legacy-row-${row}`,
      coordinate_space: 'PDF points, top-left origin', generation_method_id: 'fixture',
      evidence_status: 'machine_generated',
    };
  };
  return {
    ledger_version: 'fixture-v1', status: 'machine_generated',
    source_pdf: { sha256: sourcePdfSha256, byte_length: 1_234, pages: 3 },
    observations: [1, 2].flatMap((row) =>
      (['description', 'unit', 'cost'] as const).map((role) => observation(row, role))),
  };
}

function ledgerBytes(): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(ledger(), null, 2)}\n`);
}

function candidate(row: number, anchorIds: string[]): ForgewingPricingInterpretationInput {
  return {
    organizationId: 'org', sourceDocumentId: source.sourceDocumentId,
    sourceArtifactId: source.sourceArtifactId, extractionSnapshotId: source.extractionSnapshotId,
    pricingScope: {
      scopeKind: 'authoritative', eligibility: 'canonical_eligible',
      eligibilityReason: 'authoritative_scope_match', scopeIdentity: 'c'.repeat(64),
    },
    rowObservation: {
      observationId: `candidate-row-${row}`, rawText: `candidate ${row}`,
      deterministicState: 'unresolved', physicalPageNumber: 2,
      cells: anchorIds.map((observationId, index) => ({
        observationId, rawText: observationId, columnIndex: index, readingOrder: index,
        sourceDocumentId: source.sourceDocumentId, sourceArtifactId: source.sourceArtifactId,
        physicalPageNumber: 2, sourceLayer: 'pdf_native_text',
      })),
    },
  };
}

function modern(id: string): PdfLayoutTokenObservation {
  return {
    id, evidence_object_id: id, kind: 'pdf_layout_token', source_type: 'pdf',
    source_document_id: source.sourceDocumentId, source_artifact_id: source.sourceArtifactId,
    physical_page_number: 2, source_method: 'pdfjs', raw_text: `raw-${id}`,
    description: 'fixture token', location: {
      page: 2, bounding_box: { x_min: 1, x_max: 2, y_min: 3, y_max: 4 },
    },
    confidence: 0.95, weak: false,
    metadata: {
      parser: 'pdfjs_text_content', parser_observation_key: `key-${id}`,
      page_representation_digest: 'd'.repeat(64),
    },
  } as PdfLayoutTokenObservation;
}

const candidates = [
  candidate(1, ['token-a', 'token-b']),
  candidate(2, ['token-c', 'token-d']),
];

function packet(): ForgewingLabelLinkageReviewPacket {
  return buildForgewingLabelLinkageReviewPacket({
    ledgerBytes: ledgerBytes(), source, candidates,
    pricingLayoutObservations: ['token-a', 'token-b', 'token-c', 'token-d'].map(modern),
    rowBindings: [
      { candidateRowId: 'candidate-row-1', legacyRowIdentity: 'legacy-row-1' },
      { candidateRowId: 'candidate-row-2', legacyRowIdentity: 'legacy-row-2' },
    ],
  });
}

function completedReview(packetValue = packet()) {
  return {
    review_input_version: 'forgewing-label-linkage-review-input-v1' as const,
    authority: 'evaluation_ground_truth_only' as const,
    review_packet_digest_sha256: packetValue.packet_digest_sha256,
    records: packetValue.labels.map((label) => ({
      label_observation_id: label.label_observation_id,
      candidate_row_id: label.candidate_row_id,
      reviewer_decision: 'linked' as const,
      selected_observation_ids: [label.modern_candidate_source_anchor_ids[0]!],
      notes: '',
    })),
  };
}

function resignedPacket(
  mutate: (value: ForgewingLabelLinkageReviewPacket) => void,
): ForgewingLabelLinkageReviewPacket {
  const value = structuredClone(packet());
  mutate(value);
  const { packet_digest_sha256: _digest, ...unsigned } = value;
  value.packet_digest_sha256 = forgewingLabelLinkageReviewPacketDigest(unsigned);
  return value;
}

describe('Forgewing human label linkage review workflow', () => {
  it('generates only blank reviewer decisions and selections', () => {
    const template = buildForgewingLabelLinkageReviewInputTemplate(packet()) as {
      records: Array<{ reviewer_decision: string; selected_observation_ids: string[] }>;
    };
    expect(template.records).toHaveLength(6);
    expect(template.records.every((record) => record.reviewer_decision === '')).toBe(true);
    expect(template.records.every((record) => record.selected_observation_ids.length === 0))
      .toBe(true);
  });

  it('presents row evidence without any automatic linkage field', () => {
    const value = packet();
    expect(value.labels.every((label) =>
      label.modern_pdf_layout_token_observations.length === 2)).toBe(true);
    expect(JSON.stringify(value)).not.toContain('selected_observation_ids');
    expect(JSON.stringify(value)).not.toContain('source_observation_ids');
    expect(generateForgewingLabelLinkageManifestFromReview({
      packet: value, reviewInput: buildForgewingLabelLinkageReviewInputTemplate(value),
    }).status).toBe('review_rejected');
  });

  it('creates the existing exact manifest only from explicit valid selections', () => {
    const value = packet();
    const result = generateForgewingLabelLinkageManifestFromReview({
      packet: value, reviewInput: completedReview(value),
    });
    expect(result.status).toBe('manifest_ready');
    expect(result.manifest?.records).toHaveLength(6);
    expect(result.manifest?.authority).toBe('evaluation_linkage_only');
  });

  it.each([
    ['page', 'selected_observation_wrong_page', (observation: Record<string, unknown>) => {
      observation.physical_page = 3;
    }],
    ['document', 'selected_observation_wrong_document', (observation: Record<string, unknown>) => {
      observation.source_document_id = 'foreign-document';
    }],
    ['artifact', 'selected_observation_wrong_artifact', (observation: Record<string, unknown>) => {
      observation.source_artifact_id = 'foreign-artifact';
    }],
    ['snapshot', 'selected_observation_wrong_snapshot', (observation: Record<string, unknown>) => {
      observation.extraction_snapshot_id = 'foreign-snapshot';
    }],
  ])('rejects a reviewer selection from the wrong %s', (_name, reason, mutate) => {
    const value = resignedPacket((draft) => mutate(
      draft.labels[0]!.modern_pdf_layout_token_observations[0]! as Record<string, unknown>,
    ));
    const result = generateForgewingLabelLinkageManifestFromReview({
      packet: value, reviewInput: completedReview(value),
    });
    expect(result.failureReasons).toContain(reason);
    expect(result.manifest).toBeNull();
  });

  it('rejects an unknown observation id', () => {
    const value = packet();
    const review = completedReview(value);
    review.records[0]!.selected_observation_ids = ['unknown-token'];
    expect(generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review })
      .failureReasons).toContain('unknown_observation_id');
  });

  it('rejects diagnostic-only or otherwise non-admitted evidence', () => {
    const value = resignedPacket((draft) => {
      draft.labels[0]!.modern_pdf_layout_token_observations[0]!.candidate_admitted = false;
    });
    expect(generateForgewingLabelLinkageManifestFromReview({
      packet: value, reviewInput: completedReview(value),
    }).failureReasons).toContain('selected_observation_not_candidate_admitted');
  });

  it('rejects an observation admitted only to another candidate row', () => {
    const value = packet();
    const review = completedReview(value);
    review.records[0]!.selected_observation_ids = ['token-c'];
    expect(generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review })
      .failureReasons).toContain('observation_belongs_to_another_candidate_row');
  });

  it('accepts a label explicitly linked to multiple primitive tokens', () => {
    const value = packet();
    const review = completedReview(value);
    review.records[0]!.selected_observation_ids = ['token-a', 'token-b'];
    const result = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review });
    expect(result.manifest?.records.find((record) =>
      record.label_observation_id === review.records[0]!.label_observation_id)
      ?.source_observation_ids).toEqual(['token-a', 'token-b']);
  });

  it('deduplicates and lexically sorts explicit selections before digesting', () => {
    const value = packet();
    const review = completedReview(value);
    review.records[0]!.selected_observation_ids = ['token-b', 'token-a', 'token-a'];
    const result = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review });
    expect(result.manifest?.records.find((record) =>
      record.label_observation_id === review.records[0]!.label_observation_id)
      ?.source_observation_ids).toEqual(['token-a', 'token-b']);
  });

  it('supports not_linkable without forcing or emitting a partial manifest', () => {
    const value = packet();
    const review = completedReview(value);
    review.records[0] = {
      ...review.records[0]!, reviewer_decision: 'not_linkable' as never,
      selected_observation_ids: [], notes: 'Primitive identity cannot be proven.',
    };
    const result = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review });
    expect(result.status).toBe('review_incomplete');
    expect(result.manifest).toBeNull();
    expect(result.failureReasons[0]).toContain('not_linkable:');
  });

  it('does not turn an omitted or follow-up record into a complete manifest', () => {
    const value = packet();
    const omitted = completedReview(value);
    omitted.records.pop();
    expect(generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: omitted }).status)
      .toBe('review_rejected');
    const followUp = completedReview(value);
    followUp.records[0] = {
      ...followUp.records[0]!, reviewer_decision: 'needs_follow_up' as never,
      selected_observation_ids: [],
    };
    expect(generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: followUp }).status)
      .toBe('review_incomplete');
  });

  it('produces deterministic record and manifest digests', () => {
    const value = packet();
    const review = completedReview(value);
    const first = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review });
    const second = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: review });
    expect(second.manifest).toEqual(first.manifest);
  });

  it('keeps the manifest identical under review-record and selection reorder', () => {
    const value = packet();
    const forward = completedReview(value);
    forward.records[0]!.selected_observation_ids = ['token-a', 'token-b'];
    const reverse = structuredClone(forward);
    reverse.records.reverse();
    reverse.records.find((record) => record.label_observation_id === forward.records[0]!.label_observation_id)!
      .selected_observation_ids.reverse();
    const first = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: forward });
    const second = generateForgewingLabelLinkageManifestFromReview({ packet: value, reviewInput: reverse });
    expect(second.manifest).toEqual(first.manifest);
  });

  it('prepares an exact-byte-bound SCORING_SUBSET attestation without attesting it', () => {
    const value = packet();
    const generated = generateForgewingLabelLinkageManifestFromReview({
      packet: value, reviewInput: completedReview(value),
    });
    const manifestBytes = new TextEncoder().encode(`${JSON.stringify(generated.manifest, null, 2)}\n`);
    const template = buildPreparedForgewingLabelAttestationTemplate({
      ledgerBytes: ledgerBytes(),
      linkageManifestBytes: manifestBytes,
      labelObservationIds: generated.manifest!.records.map((record) => record.label_observation_id),
    }) as {
      linkage_manifest_sha256: string;
      scope: { kind: string; label_observation_ids: string[] };
      reviewer: { stable_handle: string; reviewed_at: string };
      status: string; statement: string; attestation_digest_sha256: string;
    };
    expect(template.linkage_manifest_sha256).toBe(sha256Hex(manifestBytes));
    expect(template.scope).toMatchObject({ kind: 'SCORING_SUBSET' });
    expect(template.scope.label_observation_ids).toHaveLength(6);
    expect(template.reviewer).toEqual({ stable_handle: '', reviewed_at: '' });
    expect(template.status).toBe('');
    expect(template.statement).toBe('');
    expect(template.attestation_digest_sha256).toBe('');
  });

  it('selects labels only through explicit legacy row identity bindings', () => {
    const value = packet();
    expect(value.labels.map((label) => label.legacy_row_identity))
      .toEqual(['legacy-row-1', 'legacy-row-1', 'legacy-row-1',
        'legacy-row-2', 'legacy-row-2', 'legacy-row-2']);
  });
});
