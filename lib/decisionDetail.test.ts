import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { ValidationEvidence } from '@/types/validator';
import { resolveDecisionEvidence } from '@/lib/decisionDetail';

function buildEvidence(overrides: Partial<ValidationEvidence> = {}): ValidationEvidence {
  return {
    id: 'evidence-1',
    finding_id: 'finding-1',
    evidence_type: 'transaction_row',
    source_document_id: 'doc-1',
    source_page: null,
    fact_id: null,
    record_id: null,
    field_name: null,
    field_value: null,
    note: null,
    created_at: '2026-04-28T10:00:00.000Z',
    ...overrides,
  };
}

describe('decisionDetail evidence resolution', () => {
  it('creates actionable exact evidence targets from validator evidence', () => {
    const evidence = resolveDecisionEvidence({
      details: null,
      projectId: 'project-1',
      decisionId: 'decision-1',
      validatorEvidence: [
        buildEvidence({
          source_page: 7,
          fact_id: 'doc-1:invoice_total',
          field_name: 'invoice_total',
        }),
      ],
    });

    assert.equal(evidence.targets.length, 1);
    assert.equal(evidence.targets[0]?.exactTarget, true);
    assert.equal(evidence.targets[0]?.label, 'Canonical fact invoice_total');
    assert.equal(
      evidence.targets[0]?.href,
      '/platform/documents/doc-1?source=project&projectId=project-1&page=7&factId=doc-1%3Ainvoice_total&fieldKey=invoice_total&action=review&decisionId=decision-1',
    );
    assert.equal(evidence.missingEvidenceMessage, null);
  });

  it('returns an explicit missing-evidence message when validator only linked a source document', () => {
    const evidence = resolveDecisionEvidence({
      details: null,
      projectId: 'project-1',
      decisionId: 'decision-1',
      validatorEvidence: [
        buildEvidence(),
      ],
    });

    assert.equal(evidence.targets.length, 1);
    assert.equal(evidence.targets[0]?.exactTarget, false);
    assert.equal(
      evidence.missingEvidenceMessage,
      'Validator linked this decision to evidence, but the persisted evidence does not include an exact document page, fact, or row target yet.',
    );
  });

  it('turns human invoice-line evidence refs into decision references', () => {
    const evidence = resolveDecisionEvidence({
      details: {
        evidence_refs: ['Invoice 2026-002 · Line 1F · Contract rate match'],
      },
    });

    assert.ok(
      evidence.references.some((reference) =>
        reference.detail.includes('Invoice 2026-002'),
      ),
    );
  });

  it('shows resolved actual value source for string mismatches', () => {
    const evidence = resolveDecisionEvidence({
      severity: 'critical',
      details: {
        field_key: 'vendor_name',
        expected_value: 'AFTERMATH DISASTER RECOVERY, INC',
        actual_value: 'Other Debris LLC',
        actual_value_source: 'human override',
      },
    });

    assert.equal(evidence.metrics[0]?.label, 'Vendor Name');
    assert.equal(evidence.metrics[0]?.value, 'Other Debris LLC');
    assert.equal(
      evidence.metrics[0]?.detail,
      'Expected AFTERMATH DISASTER RECOVERY, INC. Source: human override.',
    );
  });
});
