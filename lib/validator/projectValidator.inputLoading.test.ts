import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildContractValidationContext,
  buildRateScheduleItems,
  buildDocumentIdsByFamily,
  buildExcludedValidationDocumentIds,
  buildPersistedContractValidationContextFromProjectSummary,
  resolveValidationInvoiceScope,
  synthesizeInvoicesFromLegacyExtractions,
  VALIDATOR_DOCUMENT_SELECT,
} from '@/lib/validator/projectValidator';
import { buildEvidenceTarget } from '@/lib/validator/evidenceNavigation';
import {
  RATE_BASED_CONTRACT_VALIDATION_RULES,
  runRateBasedContractValidationRules,
} from '@/lib/validator/rulePacks/rateBasedContractValidation';
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

  it('reconstructs fallback contract rate evidence from persisted summary anchors', () => {
    const context = buildPersistedContractValidationContextFromProjectSummary({
      contract_validation_context: {
        document_id: 'contract-doc-1',
        analysis: {
          contract_identity: {},
          pricing_model: {
            rate_schedule_present: {
              value: true,
            },
            pricing_applicability: {
              value: 'requires_activation_scope_or_eligibility_resolution',
              state: 'conditional',
              evidence_anchors: ['pdf:table:p8:t1:r1'],
            },
          },
          activation_model: {},
          rate_schedule_rows: [
            {
              row_id: 'exhibit_a_table:pdf:table:p8:t1:r1',
              source_kind: 'exhibit_a_table',
              description: 'Vegetative debris haul and reduction',
              unit: 'Cubic Yard',
              rate: 6.9,
              category: 'Vegetative',
              page: 8,
              source_anchor_ids: ['pdf:table:p8:t1:r1'],
              rate_raw: '$6.90',
              material_type: 'Vegetative',
              unit_type: 'Cubic Yard',
              rate_amount: 6.9,
              confidence: 'high',
              raw_cells: ['Vegetative debris haul and reduction', 'Cubic Yard', '$6.90'],
              raw_text: 'Vegetative debris haul and reduction | Cubic Yard | $6.90',
            },
          ],
        },
      },
    });

    assert.ok(context);
    const evidence = context.evidence_by_id.get('pdf:table:p8:t1:r1');
    assert.ok(evidence);
    assert.equal(evidence.id, 'pdf:table:p8:t1:r1');
    assert.equal(evidence.source_document_id, 'contract-doc-1');
    assert.equal(evidence.location.page, 8);
    assert.equal(evidence.kind, 'table_row');
    assert.match(evidence.text ?? '', /Vegetative debris/);

    const findings = runRateBasedContractValidationRules({
      project: {
        id: 'project-1',
      },
      contractValidationContext: context,
      ruleStateByRuleId: new Map(),
      factLookups: {
        contractCeilingType: 'rate_based',
        contractDocumentId: 'contract-doc-1',
        rateSchedulePresent: true,
        rateRowCount: 8,
        rateSchedulePagesDisplay: '8',
        rateUnitsDetected: ['Cubic Yard'],
      },
      invoiceLines: [],
      invoiceLineToRateMap: new Map(),
      allFacts: [],
    } as never);
    const fallbackFinding = findings.find(
      (finding) =>
        finding.rule_id === RATE_BASED_CONTRACT_VALIDATION_RULES.pricing_applicability_unclear.ruleId,
    );
    const findingEvidence = fallbackFinding?.evidence[0] ?? null;

    assert.ok(findingEvidence);
    assert.equal(findingEvidence.source_document_id, 'contract-doc-1');
    assert.equal(findingEvidence.source_page, 8);
    assert.equal(findingEvidence.record_id, 'pdf:table:p8:t1:r1');

    const target = buildEvidenceTarget({
      projectId: 'project-1',
      evidence: findingEvidence,
      findingId: fallbackFinding?.id,
    });

    assert.equal(target.exactTarget, true);
    assert.ok(target.href);
    assert.match(target.href, /contract-doc-1/);
    assert.match(target.href, /page=8/);
    assert.match(target.href, /recordId=pdf%3Atable%3Ap8%3At1%3Ar1/);
  });

  it('prefers fresh persisted contract trace rows over stale project validation summary rows', () => {
    const context = buildContractValidationContext({
      projectValidationSummary: {
        contract_validation_context: {
          document_id: 'contract-doc-1',
          analysis: {
            pricing_model: {
              rate_schedule_present: { value: true },
            },
            rate_schedule_rows: [
              {
                row_id: 'stale-rate-row',
                description: 'Stale row',
                unit: 'Cubic Yard',
                rate: 19.8,
                page: 8,
              },
            ],
          },
        },
      },
      documents: [
        {
          id: 'contract-doc-1',
          project_id: 'project-1',
          organization_id: 'org-1',
          title: 'Contract',
          name: 'contract.pdf',
          document_type: 'contract',
          created_at: '2026-05-27T17:08:00.000Z',
          intelligence_trace: {
            classification: { family: 'contract' },
            contract_analysis: {
              pricing_model: {
                rate_schedule_present: { value: true },
              },
              rate_schedule_rows: [
                {
                  row_id: 'exhibit_a_table:row-1a',
                  source_kind: 'exhibit_a_table',
                  description: 'from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
                  unit: 'Cubic Yard',
                  rate: 6.9,
                  page: 8,
                },
                {
                  row_id: 'exhibit_a_text_recovery:vegetative-rural-0-15-13-50',
                  source_kind: 'exhibit_a_text_recovery',
                  description: 'from Rural Areas ROW to DMS 0 to 15 Miles',
                  unit: 'Cubic Yard',
                  rate: 13.5,
                  page: 8,
                },
              ],
            },
          },
        },
      ],
      factsByDocumentId: new Map(),
      legacyRowsByDocumentId: new Map(),
      truthCategoryDocumentIds: {
        contract_identity: ['contract-doc-1'],
        pricing: [],
        compliance: [],
        amendments: [],
      },
    } as never);

    assert.ok(context);
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [],
      contractValidationContext: context,
    });

    assert.equal(items.some((item) => item.rate_amount === 6.9), true);
    assert.equal(items.some((item) => item.rate_amount === 13.5), true);
    assert.equal(items.some((item) => item.record_id === 'exhibit_a_text_recovery:vegetative-rural-0-15-13-50'), true);
    assert.equal(items.some((item) => item.record_id === 'stale-rate-row'), false);
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

  it('excludes only superseded invoices and explicit supersedes targets from validation scope', () => {
    const precedenceFamilies: ResolvedDocumentPrecedenceFamily[] = [
      {
        family: 'invoice',
        label: 'Invoice',
        governing_document_id: 'invoice-doc-003',
        governing_reason: 'upload_recency_fallback',
        governing_reason_detail: 'Latest upload',
        has_operator_override: false,
        considered_document_ids: ['invoice-doc-002', 'invoice-doc-003'],
        documents: [
          {
            id: 'invoice-doc-002',
            project_id: 'project-1',
            title: 'Invoice 002',
            name: 'invoice-002.pdf',
            document_type: 'invoice',
            created_at: '2026-04-03T12:00:00Z',
            document_role: 'invoice',
            authority_status: 'active',
            effective_date: null,
            precedence_rank: 0,
            operator_override_precedence: false,
            family: 'invoice',
            resolved_role: 'invoice',
            resolved_subtype: 'invoice',
            resolved_order: 0,
            is_governing: false,
            governing_document_id: 'invoice-doc-003',
            governing_reason: 'upload_recency_fallback',
            governing_reason_detail: 'Latest upload',
            considered_document_ids: ['invoice-doc-002', 'invoice-doc-003'],
            relationship_summary: [],
          },
          {
            id: 'invoice-doc-003',
            project_id: 'project-1',
            title: 'Invoice 003',
            name: 'invoice-003.pdf',
            document_type: 'invoice',
            created_at: '2026-04-04T12:00:00Z',
            document_role: 'invoice',
            authority_status: 'active',
            effective_date: null,
            precedence_rank: 1,
            operator_override_precedence: false,
            family: 'invoice',
            resolved_role: 'invoice',
            resolved_subtype: 'invoice',
            resolved_order: 1,
            is_governing: true,
            governing_document_id: 'invoice-doc-003',
            governing_reason: 'upload_recency_fallback',
            governing_reason_detail: 'Latest upload',
            considered_document_ids: ['invoice-doc-002', 'invoice-doc-003'],
            relationship_summary: [],
          },
        ],
      },
    ];

    const excluded = buildExcludedValidationDocumentIds({
      precedenceFamilies,
      documentRelationships: [],
    });
    assert.equal(excluded.has('invoice-doc-002'), false);
    assert.equal(excluded.has('invoice-doc-003'), false);

    const scoped = resolveValidationInvoiceScope({
      invoices: [
        { id: 'inv-002', source_document_id: 'invoice-doc-002', invoice_number: '2026-002' },
        { id: 'inv-003', source_document_id: 'invoice-doc-003', invoice_number: '2026-003' },
      ],
      invoiceLines: [
        { id: 'line-002', source_document_id: 'invoice-doc-002', invoice_number: '2026-002' },
        { id: 'line-003', source_document_id: 'invoice-doc-003', invoice_number: '2026-003' },
      ],
      excludedDocumentIds: excluded,
    });

    assert.equal(scoped.invoices.length, 2);
    assert.equal(scoped.invoiceLines.length, 2);
  });

  it('excludes invoices explicitly superseded by relationship edges', () => {
    const excluded = buildExcludedValidationDocumentIds({
      precedenceFamilies: [],
      documentRelationships: [{
        id: 'rel-supersedes',
        project_id: 'project-1',
        source_document_id: 'invoice-doc-003',
        target_document_id: 'invoice-doc-002',
        relationship_type: 'supersedes',
      }],
    });

    assert.deepEqual([...excluded], ['invoice-doc-002']);

    const scoped = resolveValidationInvoiceScope({
      invoices: [
        { id: 'inv-002', source_document_id: 'invoice-doc-002' },
        { id: 'inv-003', source_document_id: 'invoice-doc-003' },
      ],
      invoiceLines: [
        { id: 'line-002', source_document_id: 'invoice-doc-002' },
        { id: 'line-003', source_document_id: 'invoice-doc-003' },
      ],
      excludedDocumentIds: excluded,
    });

    assert.equal(scoped.invoices.length, 1);
    assert.equal(scoped.invoices[0]?.source_document_id, 'invoice-doc-003');
  });
});
