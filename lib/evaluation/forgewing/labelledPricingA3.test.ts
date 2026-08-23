import { describe, expect, it } from 'vitest';

import { sha256Hex } from '@/lib/extraction/domain/hash';
import {
  auditLabelledPricingA3Ledger,
  LABELLED_PRICING_A3_ROLE_MAPPING,
} from '@/lib/evaluation/forgewing/labelledPricingA3';

const sourceSha256 = 'a'.repeat(64);

function observation(
  id: string,
  role: string,
  rowIdentity: string,
  exactRawText: string,
) {
  return {
    field_identifier: id,
    source_pdf_sha256: sourceSha256,
    source_page: 2,
    bbox_x0: 10,
    bbox_y0: 20,
    bbox_x1: 40,
    bbox_y1: 30,
    page_width_points: 600,
    page_height_points: 800,
    exact_raw_text: exactRawText,
    raw_text_sha256: sha256Hex(exactRawText),
    interpreted_field_or_role: role,
    row_identity: rowIdentity,
  };
}

function ledger(overrides: Record<string, unknown> = {}) {
  return {
    ledger_version: '1.0.0',
    package_status: 'final',
    label_provenance: {
      method: 'human_verified',
      human_attestation: {
        attested: true,
        attested_by: 'reviewer-1',
        attested_at: '2026-01-02T03:04:05.000Z',
      },
    },
    source_pdf: { sha256: sourceSha256, byte_length: 1234, pages: 3 },
    observations: [
      observation('field-description-1', 'description', 'row-1', 'Hauling service'),
      observation('field-unit-1', 'unit', 'row-1', 'TON'),
      observation('field-cost-1', 'cost', 'row-1', '$ -'),
      observation('field-description-2', 'description', 'row-2', 'Disposal service'),
      observation('field-origin-1', 'origin_destination', 'row-1', 'Site to facility'),
      observation('field-label-1', 'row_label', 'row-1', '1'),
    ],
    ...overrides,
  };
}

describe('auditLabelledPricingA3Ledger', () => {
  it('computes exact mapped denominators and preserves authored nonnumeric cost text', () => {
    const report = auditLabelledPricingA3Ledger(ledger());

    expect(report.corpusStatus).toBe('labelled_a3_labels_ready');
    expect(report.roleMapping).toEqual({
      description: 'description_like_text',
      unit: 'unit_like_text',
      cost: 'rate_like_amount',
    });
    expect(report.denominators).toEqual({
      totalObservations: 6,
      totalDistinctRows: 2,
      scoredObservations: 4,
      scoredDistinctRows: 2,
      byRole: {
        description: {
          labelRole: 'description', semanticRole: 'description_like_text',
          observationCount: 2, distinctRowCount: 2,
        },
        unit: {
          labelRole: 'unit', semanticRole: 'unit_like_text',
          observationCount: 1, distinctRowCount: 1,
        },
        cost: {
          labelRole: 'cost', semanticRole: 'rate_like_amount',
          observationCount: 1, distinctRowCount: 1,
        },
      },
      excludedByRole: { origin_destination: 1, row_label: 1 },
    });
    expect(report.expectedLabels.find((label) => label.labelRole === 'cost'))
      .toMatchObject({ expectedRawText: '$ -', expectedSemanticRole: 'rate_like_amount' });
    expect(report.roleMapping).toBe(LABELLED_PRICING_A3_ROLE_MAPPING);
  });

  it('allows human-attested draft labels for evaluation but not promotion', () => {
    const report = auditLabelledPricingA3Ledger(ledger({ package_status: 'draft' }));
    expect(report.corpusStatus).toBe('labelled_a3_labels_ready');
    expect(report.warnings).toEqual(['label_package_draft']);
    expect(report.package.promotionSuitable).toBe(false);
  });

  it.each([
    ['machine-generated labels', {
      label_provenance: {
        method: 'machine_generated',
        human_attestation: {
          attested: true,
          attested_by: 'reviewer-1',
          attested_at: '2026-01-02T03:04:05.000Z',
        },
      },
    }, ['label_provenance_machine_generated']],
    ['missing human attestation', {
      label_provenance: { method: 'human_authored' },
    }, ['human_attestation_missing']],
  ])('classifies %s as unmet', (_name, overrides, reasons) => {
    const report = auditLabelledPricingA3Ledger(ledger(overrides));
    expect(report.corpusStatus).toBe('labelled_a3_unmet_labels');
    expect(report.unmetReasons).toEqual(reasons);
  });

  it('infers draft from a legacy version and fails closed when provenance is absent', () => {
    const {
      package_status: _packageStatus,
      label_provenance: _labelProvenance,
      ...input
    } = ledger({ ledger_version: '1.0.0-draft' });
    const report = auditLabelledPricingA3Ledger(input);

    expect(report.corpusStatus).toBe('labelled_a3_unmet_labels');
    expect(report.unmetReasons).toEqual([
      'human_attestation_missing',
      'label_provenance_missing',
    ]);
    expect(report.warnings).toEqual(['label_package_draft']);
  });

  it('recognizes legacy machine-generated status without treating it as human provenance', () => {
    const {
      package_status: _packageStatus,
      label_provenance: _labelProvenance,
      ...input
    } = ledger({ ledger_version: '1.0.0-draft', status: 'machine_generated' });
    const report = auditLabelledPricingA3Ledger(input);

    expect(report.package).toMatchObject({
      status: 'draft', provenanceMethod: 'machine_generated', humanAttested: false,
    });
    expect(report.unmetReasons).toEqual([
      'human_attestation_missing',
      'label_provenance_machine_generated',
    ]);
    expect(report.warnings).toEqual(['label_package_draft']);
  });

  it('strictly rejects malformed source identity, raw text hashes, and extra fields', () => {
    const sourceMismatch = ledger();
    sourceMismatch.observations[0]!.source_pdf_sha256 = 'b'.repeat(64);
    expect(() => auditLabelledPricingA3Ledger(sourceMismatch)).toThrow();

    const rawTextMismatch = ledger();
    rawTextMismatch.observations[0]!.raw_text_sha256 = 'b'.repeat(64);
    expect(() => auditLabelledPricingA3Ledger(rawTextMismatch)).toThrow();

    expect(() => auditLabelledPricingA3Ledger({ ...ledger(), unexpected: true })).toThrow();
  });
});
