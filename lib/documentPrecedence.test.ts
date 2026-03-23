import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  resolveDocumentPrecedence,
  type DocumentPrecedenceRecord,
  type DocumentRelationshipRecord,
} from './documentPrecedence';

function buildDocument(
  overrides: Partial<DocumentPrecedenceRecord> = {},
): DocumentPrecedenceRecord {
  return {
    id: 'doc-1',
    project_id: 'project-1',
    title: 'Master Contract',
    name: 'master-contract.pdf',
    document_type: 'contract',
    created_at: '2026-03-20T00:00:00Z',
    document_role: null,
    authority_status: 'active',
    effective_date: null,
    precedence_rank: null,
    operator_override_precedence: false,
    ...overrides,
  };
}

describe('resolveDocumentPrecedence', () => {
  it('prefers a contract amendment over a later-uploaded base contract', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'Base Contract',
          name: 'base-contract.pdf',
          created_at: '2026-03-25T00:00:00Z',
          effective_date: '2026-02-01',
        }),
        buildDocument({
          id: 'contract-amendment-1',
          title: 'Contract Amendment 1',
          name: 'contract-amendment-1.pdf',
          created_at: '2026-03-10T00:00:00Z',
          effective_date: '2026-03-15',
        }),
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'contract-amendment-1');
    assert.equal(contractFamily.governing_reason, 'role_priority');
    assert.equal(contractFamily.documents[0]?.resolved_role, 'contract_amendment');
  });

  it('respects operator override precedence before automatic ordering', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'Base Contract',
          name: 'base-contract.pdf',
          operator_override_precedence: true,
          precedence_rank: 0,
        }),
        buildDocument({
          id: 'contract-amendment-1',
          title: 'Contract Amendment 1',
          name: 'contract-amendment-1.pdf',
          operator_override_precedence: true,
          precedence_rank: 1,
        }),
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');
    assert.equal(contractFamily.governing_reason, 'operator_override');
    assert.equal(contractFamily.has_operator_override, true);
  });

  it('uses explicit supersedes relationships before recency fallback', () => {
    const documents: DocumentPrecedenceRecord[] = [
      buildDocument({
        id: 'rate-sheet-a',
        title: 'Rate Sheet A',
        name: 'rate-sheet-a.xlsx',
        document_type: 'spreadsheet',
        created_at: '2026-03-24T00:00:00Z',
      }),
      buildDocument({
        id: 'rate-sheet-b',
        title: 'Rate Sheet B',
        name: 'rate-sheet-b.xlsx',
        document_type: 'spreadsheet',
        created_at: '2026-03-10T00:00:00Z',
      }),
    ];
    const relationships: DocumentRelationshipRecord[] = [
      {
        id: 'relationship-1',
        project_id: 'project-1',
        source_document_id: 'rate-sheet-b',
        target_document_id: 'rate-sheet-a',
        relationship_type: 'supersedes',
      },
    ];

    const families = resolveDocumentPrecedence({
      documents,
      relationships,
    });

    const rateSheetFamily = families.find((family) => family.family === 'rate_sheet');
    assert.ok(rateSheetFamily);
    assert.equal(rateSheetFamily.governing_document_id, 'rate-sheet-b');
    assert.equal(rateSheetFamily.governing_reason, 'supersedes_relationship');
    assert.match(rateSheetFamily.governing_reason_detail ?? '', /explicitly supersedes/i);
  });
});
