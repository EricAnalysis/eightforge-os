import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildDocumentIdsByFamily,
  buildPersistedContractValidationContextFromProjectSummary,
  synthesizeInvoicesFromLegacyExtractions,
  VALIDATOR_DOCUMENT_SELECT,
} from '@/lib/validator/projectValidator';
import { DOCUMENT_PRECEDENCE_SELECT } from '@/lib/server/documentPrecedence';
import type { ValidatorLegacyExtractionRow } from '@/lib/validator/shared';
import type { ResolvedDocumentPrecedenceFamily } from '@/lib/documentPrecedence';

describe('project validator input loading', () => {
  it('does not select deprecated document_subtype from documents', () => {
    assert.equal(VALIDATOR_DOCUMENT_SELECT.includes('document_subtype'), false);
    assert.equal(DOCUMENT_PRECEDENCE_SELECT.includes('document_subtype'), false);
  });

  it('reads contract validation context from projects.validation_summary_json when available', () => {
    const context = buildPersistedContractValidationContextFromProjectSummary({
      contract_validation_context: {
        document_id: 'contract-doc-1',
        analysis: {
          pricing_model: {
            rate_schedule_present: {
              value: true,
            },
          },
          rate_schedule_rows: [
            {
              row_id: 'rate-row-1',
              description: 'Vegetative debris haul and reduction',
              unit: 'per cubic yard',
              rate: 6.9,
              category: 'Vegetative',
            },
          ],
        },
      },
    });

    assert.ok(context);
    assert.equal(context?.document_id, 'contract-doc-1');
    assert.equal(context?.analysis.pricing_model.rate_schedule_present?.value, true);
    assert.equal(context?.analysis.rate_schedule_rows?.[0]?.rate, 6.9);
  });

  it('falls back safely to legacy invoice extraction when canonical invoice rows are absent', () => {
    const legacyRowsByDocumentId = new Map<string, ValidatorLegacyExtractionRow>([
      ['invoice-doc-1', {
        document_id: 'invoice-doc-1',
        created_at: '2026-04-24T10:00:00Z',
        data: {
          fields: {
            typed_fields: {
              schema_type: 'invoice',
              invoice_number: 'INV-100',
              total_amount: 100.5,
              line_items: [
                {
                  line_code: 'RC-01',
                  description: 'Haul debris',
                  quantity: 10,
                  unit_price: 10.05,
                  line_total: 100.5,
                },
              ],
            },
          },
        },
      }],
    ]);

    const synthetic = synthesizeInvoicesFromLegacyExtractions({
      legacyRowsByDocumentId,
      invoiceDocumentIds: ['invoice-doc-1'],
      existingInvoices: [],
      existingInvoiceLines: [],
    });

    assert.equal(synthetic.invoices.length, 1);
    assert.equal(synthetic.invoiceLines.length, 1);
    assert.equal(synthetic.invoices[0]?.invoice_number, 'INV-100');
    assert.equal(synthetic.invoices[0]?.total_amount, 100.5);
    assert.equal(synthetic.invoiceLines[0]?.line_total, 100.5);
  });

  it('uses active precedence-selected invoice documents and excludes superseded invoice records', () => {
    const precedenceFamilies: ResolvedDocumentPrecedenceFamily[] = [
      {
        family: 'invoice',
        label: 'Invoice',
        governing_document_id: 'invoice-doc-active',
        governing_reason: 'operator_override',
        governing_reason_detail: 'Selected by operator override for the invoice family.',
        has_operator_override: true,
        considered_document_ids: ['invoice-doc-active', 'invoice-doc-superseded'],
        documents: [
          {
            id: 'invoice-doc-active',
            project_id: 'project-1',
            title: 'Invoice 003',
            name: 'invoice-003.pdf',
            document_type: 'invoice',
            created_at: '2026-04-04T12:00:00Z',
            document_role: 'invoice',
            authority_status: 'active',
            effective_date: null,
            precedence_rank: 0,
            operator_override_precedence: true,
            family: 'invoice',
            resolved_role: 'invoice',
            resolved_subtype: 'invoice',
            resolved_order: 0,
            is_governing: true,
            governing_document_id: 'invoice-doc-active',
            governing_reason: 'operator_override',
            governing_reason_detail: 'Selected by operator override for the invoice family.',
            considered_document_ids: ['invoice-doc-active', 'invoice-doc-superseded'],
            relationship_summary: [],
          },
          {
            id: 'invoice-doc-superseded',
            project_id: 'project-1',
            title: 'Invoice 002',
            name: 'invoice-002.pdf',
            document_type: 'invoice',
            created_at: '2026-04-03T12:00:00Z',
            document_role: 'invoice',
            authority_status: 'superseded',
            effective_date: null,
            precedence_rank: 1,
            operator_override_precedence: true,
            family: 'invoice',
            resolved_role: 'invoice',
            resolved_subtype: 'invoice',
            resolved_order: 1,
            is_governing: false,
            governing_document_id: 'invoice-doc-active',
            governing_reason: 'operator_override',
            governing_reason_detail: 'Selected by operator override for the invoice family.',
            considered_document_ids: ['invoice-doc-active', 'invoice-doc-superseded'],
            relationship_summary: [],
          },
        ],
      },
    ];

    const ids = buildDocumentIdsByFamily([
      {
        id: 'invoice-doc-active',
        project_id: 'project-1',
        organization_id: 'org-1',
        title: 'Invoice 003',
        name: 'invoice-003.pdf',
        document_type: 'invoice',
        created_at: '2026-04-04T12:00:00Z',
      },
      {
        id: 'invoice-doc-superseded',
        project_id: 'project-1',
        organization_id: 'org-1',
        title: 'Invoice 002',
        name: 'invoice-002.pdf',
        document_type: 'invoice',
        created_at: '2026-04-03T12:00:00Z',
      },
    ], precedenceFamilies);

    assert.deepEqual(ids.governingDocumentIds.invoice, ['invoice-doc-active']);
    assert.deepEqual(ids.familyDocumentIds.invoice, ['invoice-doc-active']);
    assert.deepEqual(ids.truthCategoryDocumentIds.contract_identity, []);
  });

  it('routes attached, supplemental, and amendment relationship docs into canonical validator truth categories', () => {
    const precedenceFamilies: ResolvedDocumentPrecedenceFamily[] = [
      {
        family: 'contract',
        label: 'Contract',
        governing_document_id: 'base-contract',
        governing_reason: 'role_priority',
        governing_reason_detail: 'Selected because its contract role outranks the other candidate documents.',
        has_operator_override: false,
        considered_document_ids: ['base-contract'],
        documents: [
          {
            id: 'base-contract',
            project_id: 'project-1',
            title: 'MVSU Draft Contract',
            name: 'mvsu-draft-contract.pdf',
            document_type: 'contract',
            created_at: '2026-04-01T12:00:00Z',
            document_role: 'base_contract',
            authority_status: 'active',
            effective_date: '2026-04-01',
            precedence_rank: null,
            operator_override_precedence: false,
            family: 'contract',
            resolved_role: 'base_contract',
            resolved_subtype: 'base_contract',
            resolved_order: 0,
            is_governing: true,
            governing_document_id: 'base-contract',
            governing_reason: 'role_priority',
            governing_reason_detail: 'Selected because its contract role outranks the other candidate documents.',
            considered_document_ids: ['base-contract'],
            relationship_summary: [],
          },
        ],
      },
    ];

    const ids = buildDocumentIdsByFamily(
      [
        {
          id: 'base-contract',
          project_id: 'project-1',
          organization_id: 'org-1',
          title: 'MVSU Draft Contract',
          name: 'mvsu-draft-contract.pdf',
          document_type: 'contract',
          created_at: '2026-04-01T12:00:00Z',
        },
        {
          id: 'exhibit-a',
          project_id: 'project-1',
          organization_id: 'org-1',
          title: 'Exhibit A',
          name: 'exhibit-a.pdf',
          document_type: 'Attachment',
          created_at: '2026-04-02T12:00:00Z',
        },
        {
          id: 'federal-guidance',
          project_id: 'project-1',
          organization_id: 'org-1',
          title: 'Federal Guidance Requirements',
          name: 'federal-guidance-requirements.pdf',
          document_type: 'Specification',
          created_at: '2026-04-03T12:00:00Z',
        },
        {
          id: 'contract-amendment-1',
          project_id: 'project-1',
          organization_id: 'org-1',
          title: 'Amendment 1',
          name: 'amendment-1.pdf',
          document_type: 'contract',
          created_at: '2026-04-04T12:00:00Z',
        },
      ],
      precedenceFamilies,
      [
        {
          id: 'rel-1',
          project_id: 'project-1',
          source_document_id: 'exhibit-a',
          target_document_id: 'base-contract',
          relationship_type: 'attached_to',
        },
        {
          id: 'rel-2',
          project_id: 'project-1',
          source_document_id: 'federal-guidance',
          target_document_id: 'base-contract',
          relationship_type: 'supplements',
        },
        {
          id: 'rel-3',
          project_id: 'project-1',
          source_document_id: 'contract-amendment-1',
          target_document_id: 'base-contract',
          relationship_type: 'amends',
        },
      ],
    );

    assert.deepEqual(ids.truthCategoryDocumentIds.contract_identity, ['base-contract']);
    assert.deepEqual(ids.truthCategoryDocumentIds.pricing.slice(0, 2), ['exhibit-a', 'base-contract']);
    assert.deepEqual(ids.truthCategoryDocumentIds.compliance.slice(0, 2), ['federal-guidance', 'base-contract']);
    assert.deepEqual(ids.truthCategoryDocumentIds.amendments.slice(0, 2), ['contract-amendment-1', 'base-contract']);
  });
});
