import { describe, expect, it } from 'vitest';

import { hashCanonical, sha256Hex } from '@/lib/extraction/domain/hash';
import { auditLabelledPricingA3Ledger } from '@/lib/evaluation/forgewing/labelledPricingA3';
import {
  FORGEWING_LABEL_ATTESTATION_STATEMENT,
  FORGEWING_LABEL_ATTESTATION_VERSION,
  buildForgewingLabelAttestationTemplate,
  forgewingLabelAttestationDigest,
  labelObservationIdsDigest,
  validateForgewingLabelAttestation,
} from '@/lib/evaluation/forgewing/labelledPricingAttestation';

const sourceSha256 = 'a'.repeat(64);

function ledger() {
  const observation = (id: string, role: string, text: string) => ({
    field_identifier: id,
    source_pdf_sha256: sourceSha256,
    source_page: 2,
    bbox_x0: 10,
    bbox_y0: 20,
    bbox_x1: 40,
    bbox_y1: 30,
    page_width_points: 600,
    page_height_points: 800,
    exact_raw_text: text,
    raw_text_sha256: sha256Hex(text),
    interpreted_field_or_role: role,
    row_identity: 'row-1',
  });
  return {
    ledger_version: '1.0.0-draft',
    status: 'machine_generated',
    source_pdf: { sha256: sourceSha256, byte_length: 1234, pages: 3 },
    observations: [
      observation('label-description', 'description', 'Hauling'),
      observation('label-unit', 'unit', 'TON'),
      observation('label-cost', 'cost', '$ -'),
      observation('label-origin', 'origin_destination', 'A to B'),
    ],
  };
}

function bytes(value: unknown = ledger()): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

function validAttestation(ledgerBytes = bytes(), scopeIds?: string[]) {
  const parsedLedger = JSON.parse(new TextDecoder().decode(ledgerBytes));
  const audit = auditLabelledPricingA3Ledger(parsedLedger);
  const ids = scopeIds ?? audit.expectedLabels.map((label) => label.labelObservationId)
    .sort((left, right) => left.localeCompare(right, 'en-US'));
  const unsigned = {
    attestation_version: FORGEWING_LABEL_ATTESTATION_VERSION,
    authority: 'evaluation_ground_truth_only' as const,
    status: 'human_verified' as const,
    statement: FORGEWING_LABEL_ATTESTATION_STATEMENT,
    label_package: {
      ledger_version: audit.package.ledgerVersion,
      ledger_sha256: sha256Hex(ledgerBytes),
      ledger_byte_length: ledgerBytes.byteLength,
      deterministic_package_digest: hashCanonical(parsedLedger),
    },
    source_artifact: {
      sha256: audit.source.sha256,
      byte_length: audit.source.byteLength,
      pages: audit.source.pages,
    },
    linkage_manifest_sha256: 'd'.repeat(64),
    reviewer: {
      stable_handle: 'synthetic-reviewer-fixture',
      reviewed_at: '2026-01-02T03:04:05.000Z',
    },
    scope: scopeIds
      ? {
          kind: 'SCORING_SUBSET' as const,
          every_scored_label_reviewed: true as const,
          label_observation_ids: ids,
          label_observation_ids_sha256: labelObservationIdsDigest(ids),
        }
      : {
          kind: 'FULL_PACKAGE' as const,
          every_scored_label_reviewed: true as const,
          label_observation_ids: ids,
          label_observation_ids_sha256: labelObservationIdsDigest(ids),
        },
  };
  return { ...unsigned, attestation_digest_sha256: forgewingLabelAttestationDigest(unsigned) };
}

describe('Forgewing label attestation', () => {
  it('keeps a machine-generated package without a sidecar at unmet labels', () => {
    const audit = auditLabelledPricingA3Ledger(ledger());
    expect(audit.corpusStatus).toBe('labelled_a3_unmet_labels');
    expect(audit.unmetReasons).toContain('human_attestation_missing');
  });

  it('accepts an exact synthetic attestation for evaluation only', () => {
    const result = validateForgewingLabelAttestation({
      ledgerBytes: bytes(), attestation: validAttestation(),
    });
    expect(result.status).toBe('human_attestation_valid');
    expect(result.attestedLabelObservationIds).toHaveLength(3);
    expect(result.promotionAuthorized).toBe(false);
  });

  it('rejects a wrong package hash', () => {
    const attestation = validAttestation();
    attestation.label_package.ledger_sha256 = 'b'.repeat(64);
    expect(validateForgewingLabelAttestation({ ledgerBytes: bytes(), attestation }))
      .toMatchObject({ status: 'human_attestation_invalid' });
  });

  it('rejects a wrong source hash', () => {
    const attestation = validAttestation();
    attestation.source_artifact.sha256 = 'b'.repeat(64);
    expect(validateForgewingLabelAttestation({ ledgerBytes: bytes(), attestation }).failureReasons)
      .toContain('source_artifact_digest_mismatch');
  });

  it('rejects modified exact ledger bytes after attestation', () => {
    const original = bytes();
    const modified = new Uint8Array([...original, 0x20]);
    expect(validateForgewingLabelAttestation({
      ledgerBytes: modified, attestation: validAttestation(original),
    }).failureReasons).toContain('label_package_digest_mismatch');
  });

  it.each([
    ['reviewer', { stable_handle: '', reviewed_at: '2026-01-02T03:04:05.000Z' }],
    ['reviewed_at', { stable_handle: 'reviewer', reviewed_at: '' }],
  ])('rejects a missing %s', (_name, reviewer) => {
    expect(validateForgewingLabelAttestation({
      ledgerBytes: bytes(), attestation: { ...validAttestation(), reviewer },
    }).failureReasons).toEqual(['attestation_schema_rejected']);
  });

  it('limits an incomplete scoring scope to its enumerated label ids', () => {
    const attestation = validAttestation(bytes(), ['label-description']);
    const result = validateForgewingLabelAttestation({ ledgerBytes: bytes(), attestation });
    expect(result.status).toBe('human_attestation_valid');
    expect(result.attestedLabelObservationIds).toEqual(['label-description']);
    expect(result.attestedLabelObservationIds).not.toContain('label-cost');
  });

  it('rejects unknown labels and scope digest changes', () => {
    const attestation = validAttestation(bytes(), ['label-description']);
    attestation.scope.label_observation_ids = ['unknown-label'];
    expect(validateForgewingLabelAttestation({ ledgerBytes: bytes(), attestation }).failureReasons)
      .toEqual(expect.arrayContaining([
        'attestation_digest_mismatch',
        'attestation_scope_digest_mismatch',
        'attestation_scope_unknown_label',
      ]));
  });

  it('never treats an attestation as promotion authority', () => {
    const result = validateForgewingLabelAttestation({
      ledgerBytes: bytes(), attestation: validAttestation(),
    });
    expect(result.authority).toBe('evaluation_ground_truth_only');
    expect(result.promotionAuthorized).toBe(false);
    expect(result.audit.package.promotionSuitable).toBe(false);
  });

  it('generates a deterministic blank template that cannot masquerade as proof', () => {
    const first = buildForgewingLabelAttestationTemplate({ ledgerBytes: bytes() });
    const second = buildForgewingLabelAttestationTemplate({ ledgerBytes: bytes() });
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      template_only: true,
      status: '',
      reviewer: { stable_handle: '', reviewed_at: '' },
      attestation_digest_sha256: '',
      linkage_manifest_sha256: '',
    });
    expect(validateForgewingLabelAttestation({ ledgerBytes: bytes(), attestation: first }).status)
      .toBe('human_attestation_invalid');
  });
});
