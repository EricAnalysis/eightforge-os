import assert from 'node:assert/strict';
import { describe, it } from 'vitest';
import type { ValidationEvidence } from '@/types/validator';
import { buildEvidenceTarget } from '@/lib/validator/evidenceNavigation';

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

describe('evidenceNavigation', () => {
  it('builds an exact spreadsheet row target for validator evidence', () => {
    const target = buildEvidenceTarget({
      projectId: 'project-1',
      action: 'review',
      decisionId: 'decision-1',
      findingId: 'finding-1',
      evidence: buildEvidence({
        record_id: 'transaction:sheet-1:12',
        field_name: 'invoice_readiness_summary',
      }),
    });

    assert.equal(target.exactTarget, true);
    assert.equal(target.label, 'Spreadsheet row transaction:sheet-1:12');
    assert.equal(target.detail, 'row transaction:sheet-1:12 | fact invoice_readiness_summary');
    assert.equal(target.missingReason, null);
    assert.equal(
      target.href,
      '/platform/documents/doc-1?source=project&projectId=project-1&fieldKey=invoice_readiness_summary&recordId=transaction%3Asheet-1%3A12&action=review&decisionId=decision-1&findingId=finding-1',
    );
  });

  it('returns an explicit missing evidence reason when validator did not persist an exact target', () => {
    const target = buildEvidenceTarget({
      projectId: 'project-1',
      action: 'inspect',
      evidence: buildEvidence(),
    });

    assert.equal(target.exactTarget, false);
    assert.equal(target.label, 'Source document');
    assert.equal(target.detail, 'Document-level context only');
    assert.equal(
      target.missingReason,
      'The source document is linked, but validator did not persist an exact page, row, or fact target.',
    );
    assert.equal(
      target.href,
      '/platform/documents/doc-1?source=project&projectId=project-1&action=inspect',
    );
  });
});
