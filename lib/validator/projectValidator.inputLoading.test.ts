import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildDocumentIdsByFamily,
  buildPersistedContractValidationContextFromProjectSummary,
  synthesizeInvoicesFromLegacyExtractions,
} from '@/lib/validator/projectValidator';
import type { ValidatorLegacyExtractionRow } from '@/lib/validator/shared';
import type { ResolvedDocumentPrecedenceFamily } from '@/lib/documentPrecedence';

describe('project validator input loading', () => {
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
});
