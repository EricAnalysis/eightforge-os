import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

import {
  buildInvoiceLineToRateMap,
  buildManualRateLinkOverrides,
  buildContractValidationContext,
  buildRateScheduleItems,
  buildDocumentIdsByFamily,
  buildExcludedValidationDocumentIds,
  buildPersistedContractValidationContextFromProjectSummary,
  loadProject,
  resolveValidationInvoiceScope,
  synthesizeInvoicesFromLegacyExtractions,
  VALIDATOR_DOCUMENT_SELECT,
  type InvoiceLineRateLinkRow,
} from '@/lib/validator/projectValidator';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { deriveBillingKeysForRateScheduleItem } from '@/lib/validator/billingKeys';
import { buildEvidenceTarget } from '@/lib/validator/evidenceNavigation';
import {
  RATE_BASED_CONTRACT_VALIDATION_RULES,
  runRateBasedContractValidationRules,
} from '@/lib/validator/rulePacks/rateBasedContractValidation';
import { DOCUMENT_PRECEDENCE_SELECT } from '@/lib/server/documentPrecedence';
import type { RateScheduleItem, ValidatorLegacyExtractionRow } from '@/lib/validator/shared';
import type { ResolvedDocumentPrecedenceFamily } from '@/lib/documentPrecedence';

function makeRateScheduleItem(overrides: Partial<RateScheduleItem> = {}): RateScheduleItem {
  const description = overrides.description ?? 'Manual vegetative debris haul';
  const keys = deriveBillingKeysForRateScheduleItem({
    rate_code: overrides.rate_code ?? '1F',
    description,
    material_type: overrides.material_type ?? 'Vegetative',
    unit_type: overrides.unit_type ?? 'CYD',
  });

  return {
    source_document_id: overrides.source_document_id ?? 'contract-doc-1',
    record_id: overrides.record_id ?? 'rate-row-1',
    rate_code: overrides.rate_code ?? '1F',
    unit_type: overrides.unit_type ?? 'CYD',
    rate_amount: overrides.rate_amount ?? 14.5,
    material_type: overrides.material_type ?? 'Vegetative',
    description,
    source_category: overrides.source_category ?? 'Vegetative',
    canonical_category: overrides.canonical_category ?? 'hauling_transport',
    category_confidence: overrides.category_confidence ?? 0.95,
    raw_value: overrides.raw_value ?? {},
    ...keys,
    ...overrides,
  };
}

function makeManualRateLinkRow(overrides: Partial<InvoiceLineRateLinkRow> = {}): InvoiceLineRateLinkRow {
  const valueOrDefault = <K extends keyof InvoiceLineRateLinkRow>(
    key: K,
    fallback: InvoiceLineRateLinkRow[K],
  ): InvoiceLineRateLinkRow[K] => (
    Object.hasOwn(overrides, key) ? overrides[key] as InvoiceLineRateLinkRow[K] : fallback
  );

  return {
    id: valueOrDefault('id', 'manual-link-1'),
    organization_id: valueOrDefault('organization_id', 'org-1'),
    project_id: valueOrDefault('project_id', 'project-1'),
    invoice_document_id: valueOrDefault('invoice_document_id', 'invoice-doc-1'),
    invoice_line_subject_id: valueOrDefault('invoice_line_subject_id', 'fact:invoice-doc-1:line:6'),
    contract_document_id: valueOrDefault('contract_document_id', 'contract-doc-1'),
    contract_rate_row_id: valueOrDefault('contract_rate_row_id', 'rate-row-1'),
    rate_row_description: valueOrDefault('rate_row_description', 'Operator supplied vegetative debris haul'),
    rate_row_unit_type: valueOrDefault('rate_row_unit_type', 'CYD'),
    rate_row_rate_amount: valueOrDefault('rate_row_rate_amount', 14.5),
    reason: valueOrDefault('reason', 'Operator confirmed the governing rate row.'),
    created_at: valueOrDefault('created_at', '2026-06-30T00:00:00.000Z'),
    is_active: valueOrDefault('is_active', true),
    superseded_by: valueOrDefault('superseded_by', null),
  };
}

describe('project validator input loading', () => {
  it('does not select deprecated document_subtype from documents', () => {
    assert.equal(VALIDATOR_DOCUMENT_SELECT.includes('document_subtype'), false);
    assert.equal(DOCUMENT_PRECEDENCE_SELECT.includes('document_subtype'), false);
  });

  it('reads the persisted projects.validation_phase value', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: {
        id: 'project-1',
        organization_id: 'org-1',
        name: 'Billing Review Project',
        code: 'BRP',
        validation_status: null,
        validation_summary_json: null,
        validation_phase: 'billing_review',
      },
      error: null,
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn((_columns: string) => ({ eq }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);

    const project = await loadProject('project-1');

    assert.equal(project.validation_phase, 'billing_review');
    assert.equal(from.mock.calls.length, 1);
    assert.match(String(select.mock.calls[0]?.[0] ?? ''), /validation_phase/);
  });

  it('surfaces a project query error without retrying a legacy select', async () => {
    const maybeSingle = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: '42703',
        message: 'column projects.validation_phase does not exist',
      },
    });
    const eq = vi.fn(() => ({ maybeSingle }));
    const select = vi.fn((_columns: string) => ({ eq }));
    const from = vi.fn(() => ({ select }));
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as never);

    await assert.rejects(
      () => loadProject('project-1'),
      /column projects\.validation_phase does not exist/,
    );
    assert.equal(from.mock.calls.length, 1);
    assert.equal(select.mock.calls.length, 1);
  });

  it('resolves active manual invoice-line rate links by contract rate row id', () => {
    const rateItem = makeRateScheduleItem({ record_id: 'exhibit_a_table:row:5' });

    const overrides = buildManualRateLinkOverrides({
      rows: [makeManualRateLinkRow({
        id: 'link-1',
        contract_rate_row_id: 'exhibit_a_table:row:5',
      })],
      rateScheduleItems: [rateItem],
    });

    const resolved = overrides.get('fact:invoice-doc-1:line:6');
    assert.ok(resolved);
    assert.equal(resolved.record_id, 'exhibit_a_table:row:5');
    assert.equal(resolved.match_source_kind, 'manual_link');
    assert.equal(resolved.manual_link_resolution, 'record_id_match');
    assert.equal(resolved.manual_rate_link_id, 'link-1');
  });

  it('constructs a manual rate link override from operator-supplied rate fields when the row id is not assembled', () => {
    const overrides = buildManualRateLinkOverrides({
      rows: [makeManualRateLinkRow({
        id: 'link-operator',
        contract_document_id: 'contract-doc-operator',
        contract_rate_row_id: 'exhibit_a_table:pdf:table:p9:t33:r8',
        rate_row_description: 'Trees with Hazardous Limbs Hanging Removal >2" per Tree',
        rate_row_unit_type: 'Tree',
        rate_row_rate_amount: 80,
      })],
      rateScheduleItems: [],
    });

    const resolved = overrides.get('fact:invoice-doc-1:line:6');

    assert.ok(resolved);
    assert.equal(resolved.source_document_id, 'contract-doc-operator');
    assert.equal(resolved.record_id, 'exhibit_a_table:pdf:table:p9:t33:r8');
    assert.equal(resolved.description, 'Trees with Hazardous Limbs Hanging Removal >2" per Tree');
    assert.equal(resolved.unit_type, 'Tree');
    assert.equal(resolved.rate_amount, 80);
    assert.equal(resolved.rate_code, null);
    assert.equal(resolved.material_type, null);
    assert.equal(resolved.match_source_kind, 'manual_link');
    assert.equal(resolved.manual_link_resolution, 'operator_supplied');
    assert.equal(resolved.manual_rate_link_id, 'link-operator');
  });

  it('logs and skips a manual link with no assembled row and incomplete operator-supplied rate fields', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const overrides = buildManualRateLinkOverrides({
        rows: [makeManualRateLinkRow({
          id: 'link-incomplete',
          contract_rate_row_id: 'missing-rate-row',
          rate_row_description: null,
          rate_row_unit_type: 'Tree',
          rate_row_rate_amount: 80,
        })],
        rateScheduleItems: [],
      });

      assert.equal(overrides.has('fact:invoice-doc-1:line:6'), false);
      assert.equal(error.mock.calls.length, 1);
      assert.match(String(error.mock.calls[0]?.[0] ?? ''), /insufficient operator-supplied rate data/);
      assert.deepEqual((error.mock.calls[0]?.[1] as { missingFields?: string[] } | undefined)?.missingFields, [
        'rate_row_description',
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it('uses a manual rate link in the invoice-line rate map when no automated match is available', () => {
    const lineId = 'fact:invoice-doc-1:line:6';
    const manualRateItem = makeRateScheduleItem({
      record_id: 'manual-rate-row',
      rate_code: null,
      description: 'Human confirmed disposal row',
      match_source_kind: 'manual_link',
      manual_rate_link_id: 'link-1',
    });

    const map = buildInvoiceLineToRateMap(
      [{
        id: lineId,
        source_document_id: 'invoice-doc-1',
        rate_code: 'UNMATCHABLE',
        description: 'No automated schedule row can match this line',
        unit_price: 12,
      }],
      [],
      new Map([[lineId, manualRateItem]]),
    );

    assert.equal(map.get(lineId)?.record_id, 'manual-rate-row');
    assert.equal(map.get(lineId)?.match_source_kind, 'manual_link');
  });

  it('uses a legacy fact-subject manual rate link for synthesized typed invoice lines', () => {
    const documentId = '53d74340-4d00-4d55-a937-4d0eca9c1573';
    const typedLineId = `typed:${documentId}:invoice:line:6`;
    const factSubjectLineId = `fact:${documentId}:line:6`;
    const manualRateItem = makeRateScheduleItem({
      record_id: 'exhibit_a_table:pdf:table:p9:t33:r8',
      rate_code: null,
      description: 'Trees with Hazardous Limbs Hanging Removal >2" per Tree',
      unit_type: 'Tree',
      rate_amount: 80,
      match_source_kind: 'manual_link',
      manual_link_resolution: 'operator_supplied',
      manual_rate_link_id: '2a976e57-b648-4343-8b51-dde452b8e285',
    });

    const map = buildInvoiceLineToRateMap(
      [{
        id: typedLineId,
        source_document_id: documentId,
        invoice_number: '2026-002',
        rate_code: '6A',
        description: 'Tree Operations Hazardous Hanging Limb Removal>2"per tree',
        quantity: 994,
        unit_price: 80,
        line_total: 79520,
      }],
      [],
      new Map([[factSubjectLineId, manualRateItem]]),
    );

    assert.equal(map.get(typedLineId)?.record_id, 'exhibit_a_table:pdf:table:p9:t33:r8');
    assert.equal(map.get(typedLineId)?.match_source_kind, 'manual_link');
    assert.equal(map.has(factSubjectLineId), false);
  });

  it('keeps invoice-line rate map behavior unchanged when no manual link exists', () => {
    const line = {
      id: 'fact:invoice-doc-1:line:1',
      source_document_id: 'invoice-doc-1',
      rate_code: '1F',
      description: 'Manual vegetative debris haul',
      material: 'Vegetative',
      unit_price: 14.5,
    };
    const rateItem = makeRateScheduleItem();

    const baseline = buildInvoiceLineToRateMap([line], [rateItem]);
    const withEmptyOverrides = buildInvoiceLineToRateMap([line], [rateItem], new Map());

    assert.equal(withEmptyOverrides.get(line.id)?.record_id, baseline.get(line.id)?.record_id);
    assert.equal(withEmptyOverrides.get(line.id)?.match_source_kind ?? null, null);
  });

  it('logs and skips duplicate active manual links for the same invoice line', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const overrides = buildManualRateLinkOverrides({
        rows: [
          makeManualRateLinkRow({ id: 'link-1' }),
          makeManualRateLinkRow({ id: 'link-2' }),
        ],
        rateScheduleItems: [makeRateScheduleItem()],
      });

      assert.equal(overrides.has('fact:invoice-doc-1:line:6'), false);
      assert.equal(error.mock.calls.length, 1);
      assert.match(String(error.mock.calls[0]?.[0] ?? ''), /multiple active invoice_line_rate_links/);
    } finally {
      error.mockRestore();
    }
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
