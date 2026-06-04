import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  effectiveReviewedFactForAskDocument,
  findingSupportRowsForAskDocument,
} from '@/app/api/ask/document/route';

describe('ask document retrieval helpers', () => {
  it('resolves reviewed and overridden facts before trace fallback while preserving evidence', () => {
    const result = effectiveReviewedFactForAskDocument({
      factKey: 'contractor_name',
      overrides: [
        {
          id: 'override-1',
          organization_id: 'org-1',
          document_id: 'doc-1',
          field_key: 'contractor_name',
          value_json: { value: 'Corrected Contractor LLC' },
          raw_value: 'Corrected Contractor LLC',
          action_type: 'correct',
          reason: 'Operator correction',
          created_by: 'user-1',
          created_at: '2026-05-01T00:00:00Z',
          is_active: true,
          supersedes_override_id: null,
        },
      ],
      reviews: [
        {
          id: 'review-1',
          organization_id: 'org-1',
          document_id: 'doc-1',
          field_key: 'contractor_name',
          review_status: 'confirmed',
          reviewed_value_json: { value: 'Reviewed Contractor LLC' },
          reviewed_by: 'user-1',
          reviewed_at: '2026-04-30T00:00:00Z',
          notes: null,
        },
      ],
      anchors: [
        {
          id: 'anchor-1',
          organization_id: 'org-1',
          document_id: 'doc-1',
          field_key: 'contractor_name',
          override_id: 'override-1',
          anchor_type: 'text',
          page_number: 3,
          snippet: 'Contractor: Corrected Contractor LLC',
          quote_text: 'Corrected Contractor LLC',
          rect_json: null,
          anchor_json: null,
          created_by: 'user-1',
          created_at: '2026-05-01T00:00:00Z',
          is_primary: true,
        },
      ],
    });

    assert.equal(result?.value, 'Corrected Contractor LLC');
    assert.match(result?.support.join('\n') ?? '', /manual override/);
    assert.match(result?.support.join('\n') ?? '', /p\.3/);
  });

  it('surfaces project validation context before intelligence trace fallback support', () => {
    const support = findingSupportRowsForAskDocument({
      documentId: 'doc-1',
      findings: [
        {
          id: 'finding-1',
          rule_id: 'invoice_vendor_mismatch',
          severity: 'critical',
          status: 'open',
          field: 'vendor_name',
          expected: 'Correct Vendor',
          actual: 'Stale Vendor',
          blocked_reason: 'Vendor does not match reviewed contract fact',
        },
      ],
      evidence: [
        {
          finding_id: 'finding-1',
          source_document_id: 'doc-1',
          source_page: 4,
          field_name: 'vendor_name',
          field_value: 'Stale Vendor',
          note: 'Invoice header vendor',
        },
      ],
    });

    assert.equal(support.length, 1);
    assert.match(support[0] ?? '', /Validator critical p\.4/);
    assert.match(support[0] ?? '', /Vendor does not match reviewed contract fact/);
  });
});
