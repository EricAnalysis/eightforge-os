import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import { auditLabelledPricingA3Ledger } from '@/lib/evaluation/forgewing/labelledPricingA3';
import {
  FORGEWING_LABEL_LINKAGE_VERSION,
  forgewingLabelLinkageManifestDigest,
  forgewingLabelLinkageRecordDigest,
  validateForgewingLabelLinkage,
} from '@/lib/evaluation/forgewing/labelledPricingLinkage';
import type { ForgewingPricingInterpretationInput } from '@/lib/forgewing/tasks/pricingInterpretation';

const sourcePdfSha256 = 'a'.repeat(64);
const labelPackageSha256 = 'b'.repeat(64);

function audit() {
  const make = (id: string, role: string, row: string, page: number) => ({
    field_identifier: id,
    source_pdf_sha256: sourcePdfSha256,
    source_page: page,
    bbox_x0: 1, bbox_y0: 1, bbox_x1: 2, bbox_y1: 2,
    page_width_points: 600, page_height_points: 800,
    exact_raw_text: id,
    raw_text_sha256: sha256Hex(id),
    interpreted_field_or_role: role,
    row_identity: row,
  });
  return auditLabelledPricingA3Ledger({
    ledger_version: 'test-v1',
    status: 'machine_generated',
    source_pdf: { sha256: sourcePdfSha256, byte_length: 123, pages: 3 },
    observations: [
      make('label-description-1', 'description', 'label-row-1', 2),
      make('label-cost-1', 'cost', 'label-row-1', 2),
      make('label-description-2', 'description', 'label-row-2', 2),
    ],
  });
}

function candidate(rowId: string, anchors: string[]): ForgewingPricingInterpretationInput {
  return {
    organizationId: 'org', sourceDocumentId: 'document', sourceArtifactId: 'artifact',
    extractionSnapshotId: 'snapshot',
    pricingScope: {
      scopeKind: 'authoritative', eligibility: 'canonical_eligible',
      eligibilityReason: 'authoritative_scope_match', scopeIdentity: 'c'.repeat(64),
    },
    rowObservation: {
      observationId: rowId, rawText: anchors.join(' '), deterministicState: 'unresolved',
      physicalPageNumber: 2,
      cells: anchors.map((observationId, index) => ({
        observationId, rawText: observationId, columnIndex: index, readingOrder: index,
        sourceDocumentId: 'document', sourceArtifactId: 'artifact', physicalPageNumber: 2,
      })),
    },
  };
}

const candidates = [candidate('candidate-row-1', ['anchor-1', 'anchor-2'])];

function record(overrides: Record<string, unknown> = {}) {
  const unsigned = {
    label_observation_id: 'label-description-1',
    label_row_identity: 'label-row-1',
    label_role: 'description' as const,
    label_raw_text_sha256: sha256Hex('label-description-1'),
    physical_page: 2,
    candidate_row_id: 'candidate-row-1',
    source_observation_ids: ['anchor-1'],
    ...overrides,
  };
  return { ...unsigned, linkage_record_digest_sha256: forgewingLabelLinkageRecordDigest(unsigned) };
}

function manifest(records = [record()], overrides: Record<string, unknown> = {}) {
  const unsigned = {
    linkage_version: FORGEWING_LABEL_LINKAGE_VERSION,
    authority: 'evaluation_linkage_only' as const,
    label_package_sha256: labelPackageSha256,
    source: {
      source_pdf_sha256: sourcePdfSha256,
      source_document_id: 'document', source_artifact_id: 'artifact',
      extraction_snapshot_id: 'snapshot',
    },
    records,
    ...overrides,
  };
  return { ...unsigned, manifest_digest_sha256: forgewingLabelLinkageManifestDigest(unsigned) };
}

function validate(params: Partial<Parameters<typeof validateForgewingLabelLinkage>[0]> = {}) {
  return validateForgewingLabelLinkage({
    manifest: manifest(), labelPackageSha256, sourcePdfSha256, audit: audit(), candidates,
    linkageManifestSha256: 'd'.repeat(64), attestedLinkageManifestSha256: 'd'.repeat(64),
    attestedLabelObservationIds: ['label-description-1', 'label-cost-1', 'label-description-2'],
    attestationScope: 'FULL_PACKAGE', ...params,
  });
}

describe('Forgewing exact label linkage', () => {
  it('accepts exact observation-id linkage', () => {
    expect(validate()).toMatchObject({
      status: 'label_linkage_ready',
      scoredLabelObservationIds: ['label-description-1'],
      candidateLinkages: [{ linkageStatus: 'exact_linkage_complete' }],
      promotionAuthorized: false,
    });
  });

  it('rejects the wrong modern document identity', () => {
    const value = manifest([record()], { source: {
      source_pdf_sha256: sourcePdfSha256, source_document_id: 'foreign-document',
      source_artifact_id: 'artifact', extraction_snapshot_id: 'snapshot',
    } });
    expect(validate({ manifest: value }).failureReasons)
      .toContain('linkage_modern_source_identity_mismatch');
  });

  it('rejects a linkage manifest not bound by the human attestation', () => {
    expect(validate({ attestedLinkageManifestSha256: 'e'.repeat(64) }).failureReasons)
      .toContain('unattested_linkage_manifest');
  });

  it('rejects the wrong physical page', () => {
    expect(validate({ manifest: manifest([record({ physical_page: 3 })]) }).failureReasons)
      .toEqual(expect.arrayContaining(['candidate_page_mismatch', 'label_page_mismatch']));
  });

  it('rejects a source observation id absent from the candidate closure', () => {
    expect(validate({ manifest: manifest([record({ source_observation_ids: ['foreign-anchor'] })]) })
      .failureReasons).toContain('foreign_source_observation_id');
  });

  it('rejects duplicate label and source-observation assignment', () => {
    const duplicate = record({ source_observation_ids: ['anchor-1'] });
    expect(validate({ manifest: manifest([record(), duplicate]) }).failureReasons)
      .toEqual(expect.arrayContaining(['duplicate_label_linkage', 'duplicate_source_observation_linkage']));
  });

  it('reports missing label linkage for every candidate without a record', () => {
    const second = candidate('candidate-row-2', ['anchor-3']);
    expect(validate({ candidates: [...candidates, second] }).failureReasons)
      .toContain('missing_label_linkage');
  });

  it('rejects role mismatch without inferring from text or column position', () => {
    expect(validate({ manifest: manifest([record({ label_role: 'cost' })]) }).failureReasons)
      .toContain('label_identity_or_role_mismatch');
  });

  it('excludes linked but unattested labels from the scored denominator', () => {
    const result = validate({ attestedLabelObservationIds: [] });
    expect(result.candidateLinkages[0]?.linkageStatus).toBe('unattested_linkage');
    expect(result.scoredLabelObservationIds).toEqual([]);
  });

  it('is deterministic under candidate and manifest-record reorder', () => {
    const secondCandidate = candidate('candidate-row-2', ['anchor-3']);
    const secondRecord = record({
      label_observation_id: 'label-description-2',
      label_row_identity: 'label-row-2',
      label_raw_text_sha256: sha256Hex('label-description-2'),
      candidate_row_id: 'candidate-row-2',
      source_observation_ids: ['anchor-3'],
    });
    const forward = validate({ candidates: [candidates[0]!, secondCandidate],
      manifest: manifest([record(), secondRecord]) });
    const reverse = validate({ candidates: [secondCandidate, candidates[0]!],
      manifest: manifest([secondRecord, record()]) });
    expect(reverse).toEqual(forward);
  });
});
