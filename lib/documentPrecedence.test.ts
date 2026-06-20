import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  resolveDocumentPrecedence,
  resolveDocumentTruthCategoryIds,
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
  it('keeps the base contract governing when an amendment is linked to it', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'Base Contract',
          name: 'base-contract.pdf',
          created_at: '2026-03-25T00:00:00Z',
          document_subtype: 'base_contract',
          effective_date: '2026-02-01',
        }),
        buildDocument({
          id: 'contract-amendment-1',
          title: 'Contract Amendment 1',
          name: 'contract-amendment-1.pdf',
          created_at: '2026-03-10T00:00:00Z',
          document_subtype: 'amendment',
          effective_date: '2026-03-15',
        }),
      ],
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'contract-amendment-1',
          target_document_id: 'base-contract',
          relationship_type: 'amends',
        },
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');
    assert.equal(contractFamily.governing_reason, 'role_priority');
    assert.equal(contractFamily.documents[0]?.resolved_subtype, 'base_contract');
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

  it('does not let an attached pricing schedule replace the base contract', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'MVSU Draft Contract',
          name: 'mvsu-contract.pdf',
          document_subtype: 'base_contract',
        }),
        buildDocument({
          id: 'exhibit-a',
          title: 'Exhibit A',
          name: 'exhibit-a.pdf',
          document_subtype: 'pricing_schedule',
        }),
      ],
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'exhibit-a',
          target_document_id: 'base-contract',
          relationship_type: 'attached_to',
        },
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');
  });

  it('routes explicit price sheet documents into pricing truth without an attachment relationship', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'Base Contract',
          name: 'base-contract.pdf',
          document_subtype: 'base_contract',
        }),
        buildDocument({
          id: 'declared-price-sheet',
          title: 'Declared Price Sheet',
          name: 'declared-price-sheet.pdf',
          document_type: 'price_sheet',
        }),
      ],
    });

    const truthCategoryDocumentIds = resolveDocumentTruthCategoryIds({ families });

    assert.ok(truthCategoryDocumentIds.pricing.includes('declared-price-sheet'));
    assert.ok(truthCategoryDocumentIds.contract_identity.includes('base-contract'));
  });

  it('does not let an attached contract exhibit become governing over its parent contract', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'MVSU Draft Contract',
          name: 'mvsu-contract.pdf',
          document_subtype: 'base_contract',
          created_at: '2026-03-10T00:00:00Z',
        }),
        buildDocument({
          id: 'exhibit-a',
          title: 'Exhibit A',
          name: 'exhibit-a.pdf',
          // Intentionally leave subtype unset so heuristics apply.
          document_subtype: null,
          created_at: '2026-04-10T00:00:00Z',
        }),
      ],
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'exhibit-a',
          target_document_id: 'base-contract',
          relationship_type: 'attached_to',
        },
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');
  });

  it('allows operator override to explicitly keep the base contract governing', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'MVSU Draft Contract',
          name: 'mvsu-contract.pdf',
          document_subtype: 'base_contract',
          operator_override_precedence: true,
          precedence_rank: 1,
        }),
        buildDocument({
          id: 'exhibit-a',
          title: 'Exhibit A',
          name: 'exhibit-a.pdf',
          operator_override_precedence: true,
          precedence_rank: 2,
        }),
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');
    assert.equal(contractFamily.governing_reason, 'operator_override');
  });

  it('keeps the base contract governing when guidance supplements it', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'MVSU Draft Contract',
          name: 'mvsu-contract.pdf',
          document_subtype: 'base_contract',
          effective_date: '2026-02-01',
        }),
        buildDocument({
          id: 'federal-guidance',
          title: 'Federal Guidance',
          name: 'federal-guidance.pdf',
          document_subtype: 'compliance_requirements',
          effective_date: '2026-04-01',
        }),
      ],
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'federal-guidance',
          target_document_id: 'base-contract',
          relationship_type: 'supplements',
        },
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');
    assert.equal(contractFamily.governing_reason, 'role_priority');
  });

  it('retains cross-family relationship summaries for requirement-style documents outside governing families', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'MVSU Draft Contract',
          name: 'mvsu-contract.pdf',
          document_subtype: 'base_contract',
        }),
        buildDocument({
          id: 'federal-guidance',
          title: 'Federal Guidance Requirements',
          name: 'federal-guidance-requirements.pdf',
          document_type: 'Specification',
          document_subtype: null,
          document_role: null,
        }),
      ],
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'federal-guidance',
          target_document_id: 'base-contract',
          relationship_type: 'supplements',
        },
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.deepEqual(contractFamily.documents[0]?.relationship_summary, [
      'Federal Guidance Requirements supplements this document',
    ]);
  });

  it('uses attached, supplemental, and amendment links for truth context without changing the governing contract', () => {
    const relationships: DocumentRelationshipRecord[] = [
      {
        id: 'relationship-1',
        project_id: 'project-1',
        source_document_id: 'exhibit-a',
        target_document_id: 'base-contract',
        relationship_type: 'attached_to',
      },
      {
        id: 'relationship-2',
        project_id: 'project-1',
        source_document_id: 'federal-guidance',
        target_document_id: 'base-contract',
        relationship_type: 'supplements',
      },
      {
        id: 'relationship-3',
        project_id: 'project-1',
        source_document_id: 'contract-amendment-1',
        target_document_id: 'base-contract',
        relationship_type: 'amends',
      },
    ];
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'MVSU Draft Contract',
          name: 'mvsu-contract.pdf',
          document_subtype: 'base_contract',
        }),
        buildDocument({
          id: 'exhibit-a',
          title: 'Exhibit A',
          name: 'exhibit-a.pdf',
          document_type: 'spreadsheet',
          document_role: 'rate_sheet',
          document_subtype: 'pricing_schedule',
        }),
        buildDocument({
          id: 'federal-guidance',
          title: 'Federal Guidance',
          name: 'federal-guidance.pdf',
          document_subtype: 'compliance_requirements',
        }),
        buildDocument({
          id: 'contract-amendment-1',
          title: 'Contract Amendment 1',
          name: 'contract-amendment-1.pdf',
          document_subtype: 'amendment',
        }),
      ],
      relationships,
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'base-contract');

    const truthCategoryIds = resolveDocumentTruthCategoryIds({
      families,
      relationships,
    });
    assert.deepEqual(truthCategoryIds.pricing.slice(0, 2), ['exhibit-a', 'base-contract']);
    assert.deepEqual(truthCategoryIds.compliance.slice(0, 2), ['federal-guidance', 'base-contract']);
    assert.deepEqual(truthCategoryIds.amendments.slice(0, 2), ['contract-amendment-1', 'base-contract']);
  });

  it('allows a replacement contract to govern after a supersedes relationship', () => {
    const families = resolveDocumentPrecedence({
      documents: [
        buildDocument({
          id: 'base-contract',
          title: 'Base Contract',
          name: 'base-contract.pdf',
          document_subtype: 'base_contract',
          effective_date: '2026-01-01',
        }),
        buildDocument({
          id: 'replacement-contract',
          title: 'Replacement Contract',
          name: 'replacement-contract.pdf',
          document_subtype: 'replacement_contract',
          effective_date: '2026-04-01',
        }),
      ],
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'replacement-contract',
          target_document_id: 'base-contract',
          relationship_type: 'supersedes',
        },
      ],
    });

    const contractFamily = families.find((family) => family.family === 'contract');
    assert.ok(contractFamily);
    assert.equal(contractFamily.governing_document_id, 'replacement-contract');
    assert.equal(contractFamily.governing_reason, 'supersedes_relationship');
  });

  it('returns governing control to the base contract when a supersedes link is removed', () => {
    const documents: DocumentPrecedenceRecord[] = [
      buildDocument({
        id: 'base-contract',
        title: 'MVSU Draft Contract',
        name: 'mvsu-draft-contract.pdf',
        document_subtype: 'base_contract',
        effective_date: '2026-01-01',
      }),
      buildDocument({
        id: 'replacement-contract',
        title: 'Replacement Contract',
        name: 'replacement-contract.pdf',
        document_subtype: 'replacement_contract',
        effective_date: '2026-04-01',
      }),
    ];

    const withSupersedes = resolveDocumentPrecedence({
      documents,
      relationships: [
        {
          id: 'relationship-1',
          project_id: 'project-1',
          source_document_id: 'replacement-contract',
          target_document_id: 'base-contract',
          relationship_type: 'supersedes',
        },
      ],
    });
    const withoutSupersedes = resolveDocumentPrecedence({
      documents,
      relationships: [],
    });

    const supersedingFamily = withSupersedes.find((family) => family.family === 'contract');
    const restoredFamily = withoutSupersedes.find((family) => family.family === 'contract');
    assert.ok(supersedingFamily);
    assert.ok(restoredFamily);
    assert.equal(supersedingFamily.governing_document_id, 'replacement-contract');
    assert.equal(restoredFamily.governing_document_id, 'base-contract');
    assert.equal(restoredFamily.governing_reason, 'role_priority');
  });
});
