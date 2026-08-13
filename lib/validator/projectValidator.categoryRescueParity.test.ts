import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  dualViewAssemblySpy: vi.fn(),
  getSupabaseAdmin: vi.fn(),
  getCanonicalTransactionDataForProject: vi.fn(),
  loadProjectDocumentPrecedenceSnapshot: vi.fn(),
  loadContractUploadGuidanceForDocument: vi.fn(),
  persistValidationRun: vi.fn(),
  reportValidatorFreshnessShadow: vi.fn(),
  scheduleCanonicalProjectTruthShadowPublication: vi.fn(),
  structuralRowsOverride: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: mocks.getSupabaseAdmin,
}));
vi.mock('@/lib/server/transactionDataPersistence', () => ({
  getCanonicalTransactionDataForProject: mocks.getCanonicalTransactionDataForProject,
}));
vi.mock('@/lib/server/documentPrecedence', () => ({
  loadProjectDocumentPrecedenceSnapshot: mocks.loadProjectDocumentPrecedenceSnapshot,
}));
vi.mock('@/lib/contracts/contractUploadGuidance', () => ({
  loadContractUploadGuidanceForDocument: mocks.loadContractUploadGuidanceForDocument,
}));
vi.mock('@/lib/validator/persistValidationRun', () => ({
  persistValidationRun: mocks.persistValidationRun,
}));
vi.mock('@/lib/validator/validatorFreshnessAudit', () => ({
  reportValidatorFreshnessShadow: mocks.reportValidatorFreshnessShadow,
}));
vi.mock('@/lib/canonical/publication/publishProjectTruthShadow', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/canonical/publication/publishProjectTruthShadow')>();
  return {
    ...actual,
    scheduleCanonicalProjectTruthShadowPublication: (
      input: Parameters<typeof actual.scheduleCanonicalProjectTruthShadowPublication>[0],
    ) => {
      mocks.scheduleCanonicalProjectTruthShadowPublication(input);
      return actual.scheduleCanonicalProjectTruthShadowPublication(input);
    },
  };
});
vi.mock('@/lib/contracts/analyzeContractIntelligence', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/contracts/analyzeContractIntelligence')>();
  return {
    ...actual,
    buildContractIntelligenceRateScheduleRows: (
      ...args: Parameters<typeof actual.buildContractIntelligenceRateScheduleRows>
    ) => {
      const rows = actual.buildContractIntelligenceRateScheduleRows(...args);
      return mocks.structuralRowsOverride(rows) ?? rows;
    },
    // The validator now takes the preparation entry point so it retains the
    // eligibility record alongside the rows; the override has to ride along or
    // this suite silently stops exercising the rescue path it is named for.
    buildContractIntelligencePricingSourcePreparation: (
      ...args: Parameters<typeof actual.buildContractIntelligencePricingSourcePreparation>
    ) => {
      const prepared = actual.buildContractIntelligencePricingSourcePreparation(...args);
      const overridden = mocks.structuralRowsOverride(prepared.rows);
      return overridden == null ? prepared : { ...prepared, rows: overridden };
    },
  };
});
vi.mock('@/lib/contracts/contractPricingAssembly', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/contracts/contractPricingAssembly')>();
  return {
    ...actual,
    assembleContractPricingRowsWithCandidates: (
      ...args: Parameters<typeof actual.assembleContractPricingRowsWithCandidates>
    ) => {
      const result = actual.assembleContractPricingRowsWithCandidates(...args);
      mocks.dualViewAssemblySpy(args, result);
      return result;
    },
  };
});

import { deriveBillingKeysForTransactionRecord } from '@/lib/validator/billingKeys';
import { resolveDocumentPrecedence } from '@/lib/documentPrecedence';
import { runProjectValidation } from '@/lib/validator/projectValidator';
import { runValidationFlow } from '@/lib/validator/triggerProjectValidation';
import type { ValidatorTransactionDataRow } from '@/lib/validator/shared';

const PROJECT_ID = 'project-category-rescue';
const ORGANIZATION_ID = 'organization-category-rescue';
const CONTRACT_DOCUMENT_ID = 'contract-category-rescue';
const INVOICE_DOCUMENT_ID = 'invoice-category-rescue';
const TRANSACTION_DOCUMENT_ID = 'transaction-category-rescue';
const INVOICE_NUMBER = 'INV-CATEGORY-RESCUE';
const INVOICE_LINE_ID = `fact:${INVOICE_DOCUMENT_ID}:line:1`;
const VALIDATION_RUN_ID = 'validation-run-category-rescue';
const INPUTS_SNAPSHOT_HASH = 'category-rescue-inputs-snapshot';

type OperatorScenario = 'human_override' | 'human_review';
type PricingBranch = 'structural_wins' | 'persisted_wins';

type FixtureState = {
  scenario: OperatorScenario;
  pricingBranch: PricingBranch;
  categoryAliases: Readonly<{
    category?: unknown;
    source_category?: unknown;
    material_type?: unknown;
    canonical_category?: unknown;
  }> | null;
};

const fixtureState: FixtureState = {
  scenario: 'human_override',
  pricingBranch: 'persisted_wins',
  categoryAliases: null,
};

const initialPublicationFlag = process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH;
const initialPublicationProjectIds = process.env.EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS;
const uploadedPublicationBodies = new Map<string, Uint8Array>();

const project = {
  id: PROJECT_ID,
  organization_id: ORGANIZATION_ID,
  name: 'Category rescue validator fixture',
  code: 'CATEGORY-RESCUE',
  validation_status: null,
  validation_summary_json: null,
  validation_phase: 'billing_review',
};

const contractDocument = {
  id: CONTRACT_DOCUMENT_ID,
  project_id: PROJECT_ID,
  organization_id: ORGANIZATION_ID,
  title: 'Synthetic category rescue contract',
  name: 'synthetic-category-rescue-contract.pdf',
  document_type: 'contract',
  document_role: 'base_contract',
  storage_path: `${ORGANIZATION_ID}/${PROJECT_ID}/synthetic-category-rescue-contract.pdf`,
  created_at: '2026-08-03T00:00:00.000Z',
  intelligence_trace: {
    classification: { family: 'contract' },
    contract_analysis: {
      pricing_model: {
        contract_ceiling_type: { value: 'rate_based' },
        rate_schedule_present: { value: true },
      },
      rate_schedule_rows: [{
        row_id: 'rate_row:1',
        description: 'Vegetative debris removal',
        category: '',
        source_category: 'Vegetative',
        material_type: 'Vegetative',
        canonical_category: null,
        category_confidence: null,
        unit: 'cubic yard',
        unit_type: 'cubic yard',
        rate: 6.9,
        rate_amount: 6.9,
        page: 8,
        source_anchor_ids: ['synthetic:category-rescue:rate-row-1'],
        rate_raw: 'Vegetative debris removal | cubic yard | $6.90',
      }],
    },
    evidence: [],
  },
};

function contractDocumentForFixture() {
  const rateRow = {
    ...contractDocument.intelligence_trace.contract_analysis.rate_schedule_rows[0],
  } as Record<string, unknown>;
  if (fixtureState.categoryAliases) {
    for (const alias of [
      'category',
      'source_category',
      'material_type',
      'canonical_category',
    ]) {
      delete rateRow[alias];
    }
    Object.assign(rateRow, fixtureState.categoryAliases);
  }
  return {
    ...contractDocument,
    intelligence_trace: {
      ...contractDocument.intelligence_trace,
      contract_analysis: {
        ...contractDocument.intelligence_trace.contract_analysis,
        rate_schedule_rows: [rateRow],
      },
    },
  };
}

const invoiceDocument = {
  id: INVOICE_DOCUMENT_ID,
  project_id: PROJECT_ID,
  organization_id: ORGANIZATION_ID,
  title: 'Synthetic category rescue invoice',
  name: 'synthetic-category-rescue-invoice.pdf',
  document_type: 'invoice',
  document_role: 'invoice',
  storage_path: `${ORGANIZATION_ID}/${PROJECT_ID}/synthetic-category-rescue-invoice.pdf`,
  created_at: '2026-08-03T00:01:00.000Z',
};

const invoiceLegacyExtraction = {
  document_id: INVOICE_DOCUMENT_ID,
  created_at: '2026-08-03T00:02:00.000Z',
  data: {
    fields: {
      typed_fields: {
        schema_type: 'invoice',
        invoice_number: INVOICE_NUMBER,
        invoice_date: '2026-08-03',
        period_start: '2026-08-01',
        period_end: '2026-08-03',
        vendor_name: 'Synthetic Debris LLC',
        client_name: 'Synthetic County',
        total_amount: 69,
        line_items: [{
          line_code: 'VEG-RESCUE',
          description: 'Vegetative debris removal',
          material: 'Vegetative',
          quantity: 10,
          unit: 'cubic yard',
          unit_price: 6.9,
          line_total: 69,
        }],
      },
    },
  },
};

const contractStructuralExtraction = {
  document_id: CONTRACT_DOCUMENT_ID,
  created_at: '2026-08-03T00:02:00.000Z',
  data: {
    fields: {
      typed_fields: {},
    },
    extraction: {
      text_preview: 'Vegetative debris removal | cubic yard | $6.90',
    },
  },
};

const humanOverride = {
  id: 'category-rescue-override',
  organization_id: ORGANIZATION_ID,
  document_id: CONTRACT_DOCUMENT_ID,
  field_key: 'rate_schedule_present',
  value_json: true,
  raw_value: 'true',
  action_type: 'correct',
  reason: 'Synthetic operator confirmation for category-rescue regression coverage.',
  created_by: 'test-operator',
  created_at: '2026-08-03T00:03:00.000Z',
  is_active: true,
  supersedes_override_id: null,
};

const humanReview = {
  id: 'category-rescue-review',
  organization_id: ORGANIZATION_ID,
  document_id: CONTRACT_DOCUMENT_ID,
  field_key: 'rate_schedule_present',
  review_status: 'confirmed',
  reviewed_value_json: true,
  reviewed_by: 'test-reviewer',
  reviewed_at: '2026-08-03T00:03:00.000Z',
  notes: 'Synthetic reviewer confirmation for category-rescue regression coverage.',
};

function transactionRow(): ValidatorTransactionDataRow {
  const keys = deriveBillingKeysForTransactionRecord({
    invoice_number: INVOICE_NUMBER,
    rate_code: 'VEG-RESCUE',
    rate_description: 'Vegetative debris removal',
    service_item: null,
    material: 'Vegetative',
  });

  return {
    id: 'transaction-category-rescue:1',
    document_id: TRANSACTION_DOCUMENT_ID,
    project_id: PROJECT_ID,
    invoice_number: INVOICE_NUMBER,
    transaction_number: 'TX-CATEGORY-RESCUE-1',
    rate_code: 'VEG-RESCUE',
    billing_rate_key: keys.billing_rate_key,
    invoice_rate_key: keys.invoice_rate_key,
    site_material_key: keys.site_material_key,
    transaction_quantity: 10,
    extended_cost: 69,
    invoice_date: '2026-08-03',
    source_sheet_name: 'Synthetic Transactions',
    source_row_number: 2,
    record_json: {
      invoice_number: INVOICE_NUMBER,
      transaction_number: 'TX-CATEGORY-RESCUE-1',
      rate_code: 'VEG-RESCUE',
      rate_description: 'Vegetative debris removal',
      material: 'Vegetative',
      transaction_quantity: 10,
      extended_cost: 69,
      billing_rate_key: keys.billing_rate_key,
      invoice_rate_key: keys.invoice_rate_key,
      site_material_key: keys.site_material_key,
    },
    raw_row_json: {},
    created_at: '2026-08-03T00:04:00.000Z',
  };
}

function rowsForTable(table: string, selectedColumns: string | null): unknown[] {
  switch (table) {
    case 'documents':
      return [contractDocumentForFixture(), invoiceDocument];
    case 'document_extractions':
      return selectedColumns === 'document_id, created_at, data'
        ? [
          invoiceLegacyExtraction,
          ...(fixtureState.pricingBranch === 'structural_wins'
            ? [contractStructuralExtraction]
            : []),
        ]
        : [];
    case 'document_fact_overrides':
      return fixtureState.scenario === 'human_override' ? [humanOverride] : [];
    case 'document_fact_reviews':
      return fixtureState.scenario === 'human_review' ? [humanReview] : [];
    case 'extraction_source_artifacts':
    case 'project_validation_rule_state':
    case 'mobile_tickets':
    case 'load_tickets':
    case 'invoice_line_rate_links':
      return [];
    default:
      throw new Error(`Unexpected fixture table query: ${table}`);
  }
}

class FixtureQuery implements PromiseLike<{ data: unknown; error: null }> {
  private selectedColumns: string | null = null;

  constructor(private readonly table: string) {}

  select(columns: string): this {
    this.selectedColumns = columns;
    return this;
  }

  eq(): this { return this; }
  in(): this { return this; }
  is(): this { return this; }
  not(): this { return this; }
  order(): this { return this; }

  maybeSingle(): Promise<{ data: unknown; error: null }> {
    if (this.table === 'projects') {
      return Promise.resolve({ data: project, error: null });
    }
    if (this.table === 'project_validation_runs') {
      return Promise.resolve({
        data: {
          id: VALIDATION_RUN_ID,
          status: 'complete',
          run_at: '2026-08-03T00:05:00.000Z',
          completed_at: '2026-08-03T00:05:01.000Z',
          triggered_by: 'manual',
          triggered_by_user_id: null,
          rule_version: 'category-rescue-test',
          inputs_snapshot_hash: INPUTS_SNAPSHOT_HASH,
        },
        error: null,
      });
    }
    throw new Error(`Unexpected maybeSingle fixture query: ${this.table}`);
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({
      data: rowsForTable(this.table, this.selectedColumns),
      error: null,
    }).then(onfulfilled, onrejected);
  }
}

async function uploadedBytes(body: Uint8Array | NodeJS.ReadableStream): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

const admin = {
  from: (table: string) => new FixtureQuery(table),
  storage: {
    from: vi.fn(() => ({
      list: vi.fn(async () => ({ data: [], error: null })),
      upload: vi.fn(async (
        path: string,
        body: Uint8Array | NodeJS.ReadableStream,
      ): Promise<{ error: { statusCode: number; message: string } | null }> => {
        uploadedPublicationBodies.set(path, await uploadedBytes(body));
        return { error: null };
      }),
      info: vi.fn(async () => ({ data: null, error: null })),
    })),
  },
};

function configureFixture(scenario: OperatorScenario, pricingBranch: PricingBranch): void {
  fixtureState.scenario = scenario;
  fixtureState.pricingBranch = pricingBranch;
  if (pricingBranch !== 'structural_wins') return;
  // The reachable legacy synthetic inputs eagerly canonicalize typed/fallback
  // rows. Preserve a controlled raw structural row at this boundary so the
  // real validator exercises category rescue without bypassing assembly/rules.
  mocks.structuralRowsOverride.mockImplementation((rows: readonly Record<string, unknown>[]) =>
    rows.map((row) => ({
      ...row,
      row_id: 'rate_row:1',
      description: 'Vegetative debris removal',
      category: 'Vegetative',
      source_category: 'Vegetative',
      material_type: 'Vegetative',
      canonical_category: null,
      category_confidence: null,
      unit: 'cubic yard',
      unit_type: 'cubic yard',
      rate: 6.9,
      rate_amount: 6.9,
      page: 8,
      rate_raw: 'Vegetative debris removal | cubic yard | $6.90',
    })),
  );
}

describe('project validator rescued-category parity', () => {
  beforeEach(() => {
    fixtureState.categoryAliases = null;
    mocks.after.mockReset();
    mocks.dualViewAssemblySpy.mockClear();
    mocks.getSupabaseAdmin.mockReset();
    mocks.getCanonicalTransactionDataForProject.mockReset();
    mocks.loadProjectDocumentPrecedenceSnapshot.mockReset();
    mocks.loadContractUploadGuidanceForDocument.mockReset();
    mocks.persistValidationRun.mockReset();
    mocks.reportValidatorFreshnessShadow.mockReset();
    mocks.scheduleCanonicalProjectTruthShadowPublication.mockReset();
    mocks.structuralRowsOverride.mockReset();
    mocks.structuralRowsOverride.mockReturnValue(undefined);
    mocks.getSupabaseAdmin.mockReturnValue(admin);
    mocks.getCanonicalTransactionDataForProject.mockResolvedValue({
      datasets: [],
      rows: [transactionRow()],
    });
    mocks.loadProjectDocumentPrecedenceSnapshot.mockResolvedValue({
      families: resolveDocumentPrecedence({
        documents: [contractDocument, invoiceDocument],
      }),
      relationships: [],
    });
    mocks.loadContractUploadGuidanceForDocument.mockResolvedValue(null);
    mocks.persistValidationRun.mockImplementation(async (
      _projectId: string,
      result: Awaited<ReturnType<typeof runProjectValidation>>['result'],
    ) => ({
      runId: VALIDATION_RUN_ID,
      effectiveResult: result,
      persistedFindings: result.findings,
    }));
    mocks.reportValidatorFreshnessShadow.mockResolvedValue(undefined);
    uploadedPublicationBodies.clear();
    delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH;
    delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS;
  });

  afterEach(() => {
    if (initialPublicationFlag === undefined) {
      delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH;
    } else {
      process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH = initialPublicationFlag;
    }
    if (initialPublicationProjectIds === undefined) {
      delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS;
    } else {
      process.env.EIGHTFORGE_CANONICAL_SHADOW_PROJECT_IDS = initialPublicationProjectIds;
    }
  });

  it.each([
    { scenario: 'human_override' as const, pricingBranch: 'structural_wins' as const },
    { scenario: 'human_review' as const, pricingBranch: 'structural_wins' as const },
    { scenario: 'human_override' as const, pricingBranch: 'persisted_wins' as const },
    { scenario: 'human_review' as const, pricingBranch: 'persisted_wins' as const },
  ])('preserves governing pricing for the $scenario $pricingBranch branch', async ({
    scenario,
    pricingBranch,
  }) => {
    configureFixture(scenario, pricingBranch);
    const { input, result } = await runProjectValidation(PROJECT_ID);

    assert.equal(mocks.dualViewAssemblySpy.mock.calls.length, 1);
    const [assemblyArgs, assemblyResult] = mocks.dualViewAssemblySpy.mock.calls[0] as [
      [
        readonly Record<string, unknown>[],
        Record<string, unknown>,
        { selectedCategoryBySourceRow?: ReadonlyMap<string, string> },
        readonly Record<string, unknown>[],
      ],
      {
        selectedRows: readonly unknown[];
        candidatesBySourceRow: ReadonlyMap<string, readonly unknown[]>;
      },
    ];
    assert.deepEqual({
      category: assemblyArgs[0][0]?.category,
      canonicalCategory: assemblyArgs[0][0]?.canonical_category,
      sourceCategory: assemblyArgs[0][0]?.source_category,
    }, {
      category: pricingBranch === 'persisted_wins' ? '' : 'Vegetative',
      canonicalCategory: null,
      sourceCategory: 'Vegetative',
    });
    assert.deepEqual(
      [...(assemblyArgs[2].selectedCategoryBySourceRow?.values() ?? [])],
      pricingBranch === 'structural_wins'
        ? ['Vegetative Collect, Remove & Haul']
        : [],
    );
    assert.deepEqual([...assemblyResult.candidatesBySourceRow.values()], [[]]);

    if (pricingBranch === 'persisted_wins') {
      assert.deepEqual(input.assembledContractPricingRows, []);
      assert.deepEqual(input.contractValidationContext?.analysis.rate_schedule_rows, [
        contractDocument.intelligence_trace.contract_analysis.rate_schedule_rows[0],
      ]);
      assert.deepEqual(input.factLookups.rateScheduleItems, []);
      assert.equal(input.invoiceLineToRateMap.get(INVOICE_LINE_ID), null);

      const validationUnit = result.cross_document_rate_verification?.validation_units[0];
      assert.deepEqual({
        invoiceLineId: validationUnit?.invoice_line_id,
        contractRateFound: validationUnit?.contract_rate_found,
        contractRate: validationUnit?.contract_rate,
        contractSourceCategory: validationUnit?.contract_source_category,
        contractRecordIds: validationUnit?.source_rows.contract_record_ids,
        comparisonStatus: validationUnit?.comparison_status,
      }, {
        invoiceLineId: INVOICE_LINE_ID,
        contractRateFound: false,
        contractRate: null,
        contractSourceCategory: null,
        contractRecordIds: [],
        comparisonStatus: 'missing_contract_rate',
      });

      assert.deepEqual(result.findings.map((finding) => ({
        ruleId: finding.rule_id,
        severity: finding.severity,
        actual: finding.actual,
      })), [
        {
          ruleId: 'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
          severity: 'critical',
          actual: 'No confident contract rate-row match found',
        },
        {
          ruleId: 'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
          severity: 'critical',
          actual: 'VEG-RESCUE',
        },
        {
          ruleId: 'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
          severity: 'warning',
          actual: '69',
        },
        {
          ruleId: 'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
          severity: 'warning',
          actual: '0',
        },
        {
          ruleId: 'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO',
          severity: 'warning',
          actual: '69',
        },
        {
          ruleId: 'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
          severity: 'warning',
          actual: '0',
        },
        {
          ruleId: 'FINANCIAL_NTE_FACT_MISSING',
          severity: 'info',
          actual: 'missing',
        },
      ]);
      assert.deepEqual(result.findings.map((finding) => ({
        ruleId: finding.rule_id,
        status: finding.status,
        lifecycleState: finding.lifecycle_state,
        disposition: finding.finding_disposition,
        approvalGateEffect: finding.approval_gate_effect,
      })), [
        'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
        'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
        'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
        'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
        'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO',
        'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
      ].map((ruleId) => ({
        ruleId,
        status: 'open',
        lifecycleState: undefined,
        disposition: 'blocker',
        approvalGateEffect: 'blocks_approval',
      })).concat([{
        ruleId: 'FINANCIAL_NTE_FACT_MISSING',
        status: 'open',
        lifecycleState: undefined,
        disposition: 'info',
        approvalGateEffect: 'informational',
      }]));
      assert.deepEqual(result.exposure, {
        total_billed_amount: 69,
        total_contract_supported_amount: 0,
        total_transaction_supported_amount: 69,
        total_fully_reconciled_amount: 0,
        total_unreconciled_amount: 69,
        total_at_risk_amount: 69,
        total_requires_verification_amount: 69,
        support_gap_tolerance_amount: 0.01,
        at_risk_tolerance_amount: 0.01,
        moderate_severity: 'warning',
        invoices: [{
          invoice_number: INVOICE_NUMBER,
          billed_amount: 69,
          billed_amount_source: 'invoice_total',
          contract_supported_amount: 0,
          transaction_supported_amount: 69,
          fully_reconciled_amount: 0,
          supported_amount: 0,
          unreconciled_amount: 69,
          at_risk_amount: 69,
          requires_verification_amount: 69,
          reconciliation_status: 'MISMATCH',
        }],
      });
      assert.equal(result.status, 'BLOCKED');
      return;
    }

    assert.deepEqual(input.assembledContractPricingRows.map((row, index) => ({
      index,
      id: row.id,
      category: row.category,
      description: row.description,
      unit: row.unit,
      rate: row.rate,
      page: row.page,
      sourceAnchor: row.sourceAnchor,
      sourceKind: row.sourceKind,
      sourceQuality: row.sourceQuality,
    })), [{
      index: 0,
      id: 'rate_row:1',
      category: 'Vegetative Collect, Remove & Haul',
      description: 'Vegetative debris removal',
      unit: 'Cubic Yard',
      rate: 6.9,
      page: 8,
      sourceAnchor: `${CONTRACT_DOCUMENT_ID}:text_preview`,
      sourceKind: 'rate_schedule',
      sourceQuality: 'clean',
    }]);

    const analysisRow = input.contractValidationContext?.analysis.rate_schedule_rows?.[0];
    assert.deepEqual({
      rowId: analysisRow?.row_id,
      category: analysisRow?.category,
      canonicalCategory: analysisRow?.canonical_category,
      unit: analysisRow?.unit,
      rate: analysisRow?.rate,
    }, {
      rowId: 'rate_row:1',
      category: 'Vegetative Collect, Remove & Haul',
      canonicalCategory: 'vegetative_removal',
      unit: 'cubic yard',
      rate: 6.9,
    });

    const scheduleItem = input.factLookups.rateScheduleItems[0];
    assert.deepEqual({
      sourceDocumentId: scheduleItem?.source_document_id,
      recordId: scheduleItem?.record_id,
      sourceCategory: scheduleItem?.source_category,
      canonicalCategory: scheduleItem?.canonical_category,
      unit: scheduleItem?.unit_type,
      rate: scheduleItem?.rate_amount,
      description: scheduleItem?.description,
      billingRateKey: scheduleItem?.billing_rate_key,
      descriptionMatchKey: scheduleItem?.description_match_key,
    }, {
      sourceDocumentId: CONTRACT_DOCUMENT_ID,
      recordId: 'rate_row:1',
      sourceCategory: 'Vegetative Collect, Remove & Haul',
      canonicalCategory: 'vegetative_removal',
      unit: 'Cubic Yard',
      rate: 6.9,
      description: 'Vegetative debris removal',
      billingRateKey: 'desc:vegetative debris removal',
      descriptionMatchKey: 'vegetative debris removal',
    });

    const governingRate = input.invoiceLineToRateMap.get(INVOICE_LINE_ID);
    assert.deepEqual({
      sourceDocumentId: governingRate?.source_document_id,
      recordId: governingRate?.record_id,
      sourceCategory: governingRate?.source_category,
      canonicalCategory: governingRate?.canonical_category,
      unit: governingRate?.unit_type,
      rate: governingRate?.rate_amount,
    }, {
      sourceDocumentId: CONTRACT_DOCUMENT_ID,
      recordId: 'rate_row:1',
      sourceCategory: 'Vegetative Collect, Remove & Haul',
      canonicalCategory: 'vegetative_removal',
      unit: 'Cubic Yard',
      rate: 6.9,
    });

    const validationUnit = result.cross_document_rate_verification?.validation_units[0];
    assert.deepEqual({
      invoiceLineId: validationUnit?.invoice_line_id,
      contractRateFound: validationUnit?.contract_rate_found,
      contractRate: validationUnit?.contract_rate,
      contractSourceCategory: validationUnit?.contract_source_category,
      contractRecordIds: validationUnit?.source_rows.contract_record_ids,
      comparisonStatus: validationUnit?.comparison_status,
    }, {
      invoiceLineId: INVOICE_LINE_ID,
      contractRateFound: true,
      contractRate: 6.9,
      contractSourceCategory: 'Vegetative Collect, Remove & Haul',
      contractRecordIds: ['rate_row:1'],
      comparisonStatus: 'match',
    });

    const findingRuleIds = result.findings.map((finding) => finding.rule_id);
    assert.equal(findingRuleIds.includes('CROSS_DOCUMENT_CONTRACT_RATE_EXISTS'), false);
    assert.equal(findingRuleIds.includes('CROSS_DOCUMENT_CATEGORY_NEEDS_REVIEW'), false);
    assert.deepEqual(result.findings.map((finding) => ({
      id: finding.id,
      ruleId: finding.rule_id,
      checkKey: finding.check_key,
      severity: finding.severity,
      subjectId: finding.subject_id,
      actual: finding.actual,
    })), [{
      id: 'FINANCIAL_NTE_FACT_MISSING:project-category-rescue:nte_amount',
      ruleId: 'FINANCIAL_NTE_FACT_MISSING',
      checkKey: 'FINANCIAL_NTE_FACT_MISSING:project-category-rescue',
      severity: 'info',
      subjectId: PROJECT_ID,
      actual: 'missing',
    }]);
    assert.deepEqual(result.findings.map((finding) => ({
      ruleId: finding.rule_id,
      status: finding.status,
      lifecycleState: finding.lifecycle_state,
      disposition: finding.finding_disposition,
      approvalGateEffect: finding.approval_gate_effect,
    })), [{
      ruleId: 'FINANCIAL_NTE_FACT_MISSING',
      status: 'open',
      lifecycleState: undefined,
      disposition: 'info',
      approvalGateEffect: 'informational',
    }]);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.exposure, {
      total_billed_amount: 69,
      total_contract_supported_amount: 69,
      total_transaction_supported_amount: 69,
      total_fully_reconciled_amount: 69,
      total_unreconciled_amount: 0,
      total_at_risk_amount: 0,
      total_requires_verification_amount: 0,
      support_gap_tolerance_amount: 0.01,
      at_risk_tolerance_amount: 0.01,
      moderate_severity: 'warning',
      invoices: [{
        invoice_number: INVOICE_NUMBER,
        billed_amount: 69,
        billed_amount_source: 'invoice_total',
        contract_supported_amount: 69,
        transaction_supported_amount: 69,
        fully_reconciled_amount: 69,
        supported_amount: 69,
        unreconciled_amount: 0,
        at_risk_amount: 0,
        requires_verification_amount: 0,
        reconciliation_status: 'MATCH',
      }],
    });
    assert.equal(result.status, 'FINDINGS_OPEN');
  });

  it('retains the pre-A11 compatibility row only when every category alias is absent, null, or blank', async () => {
    fixtureState.scenario = 'human_override';
    fixtureState.pricingBranch = 'persisted_wins';
    fixtureState.categoryAliases = {
      category: null,
      material_type: '   ',
      canonical_category: null,
    };

    const { input, result } = await runProjectValidation(PROJECT_ID);

    assert.equal(mocks.dualViewAssemblySpy.mock.calls.length, 1);
    const [assemblyArgs, assemblyResult] = mocks.dualViewAssemblySpy.mock.calls[0] as [
      [readonly Record<string, unknown>[], Record<string, unknown>, { selectedCategoryBySourceRow?: ReadonlyMap<string, string> }],
      { selectedRows: readonly unknown[] },
    ];
    assert.deepEqual(assemblyResult.selectedRows, []);
    assert.deepEqual([...(assemblyArgs[2].selectedCategoryBySourceRow?.values() ?? [])], []);
    assert.deepEqual(input.assembledContractPricingRows, []);
    assert.deepEqual(input.factLookups.rateScheduleItems.map((row) => ({
      recordId: row.record_id,
      sourceCategory: row.source_category,
      canonicalCategory: row.canonical_category,
      rate: row.rate_amount,
      unit: row.unit_type,
      billingRateKey: row.billing_rate_key,
      descriptionMatchKey: row.description_match_key,
    })), [{
      recordId: 'rate_row:1',
      sourceCategory: null,
      canonicalCategory: 'vegetative_removal',
      rate: 6.9,
      unit: 'cubic yard',
      billingRateKey: 'desc:vegetative debris removal',
      descriptionMatchKey: 'vegetative debris removal',
    }]);
    assert.equal(input.invoiceLineToRateMap.get(INVOICE_LINE_ID)?.rate_amount, 6.9);
    assert.equal(
      result.cross_document_rate_verification?.validation_units[0]?.contract_rate_found,
      true,
    );
    assert.deepEqual(result.findings.map((finding) => finding.rule_id), [
      'FINANCIAL_NTE_FACT_MISSING',
    ]);
    assert.equal(result.exposure?.total_contract_supported_amount, 69);
    assert.equal(result.exposure?.total_at_risk_amount, 0);
    assert.equal(result.status, 'FINDINGS_OPEN');
  });

  it.each([
    {
      name: 'whitespace category before a non-allowed source category',
      aliases: { category: '   ', source_category: 'Vegetative', material_type: null, canonical_category: null },
    },
    {
      name: 'non-allowed material type after blank earlier aliases',
      aliases: { category: '', source_category: ' ', material_type: 'Vegetative', canonical_category: null },
    },
    {
      name: 'nonblank canonical category after blank earlier aliases',
      aliases: { category: '', source_category: ' ', material_type: '', canonical_category: 'Unsupported Category' },
    },
  ])('does not apply categoryless compatibility for $name', async ({ aliases }) => {
    fixtureState.scenario = 'human_override';
    fixtureState.pricingBranch = 'persisted_wins';
    fixtureState.categoryAliases = aliases;

    const { input, result } = await runProjectValidation(PROJECT_ID);

    assert.equal(mocks.dualViewAssemblySpy.mock.calls.length, 1);
    assert.deepEqual(input.assembledContractPricingRows, []);
    assert.deepEqual(input.factLookups.rateScheduleItems, []);
    assert.equal(input.invoiceLineToRateMap.get(INVOICE_LINE_ID), null);
    assert.equal(
      result.cross_document_rate_verification?.validation_units[0]?.contract_rate_found,
      false,
    );
    assert.deepEqual(result.findings.map((finding) => finding.rule_id), [
      'CROSS_DOCUMENT_CONTRACT_RATE_EXISTS',
      'FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT',
      'INVOICE_EXPOSURE_AT_RISK_AMOUNT_ZERO',
      'INVOICE_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
      'PROJECT_EXPOSURE_AT_RISK_AMOUNT_ZERO',
      'PROJECT_EXPOSURE_SUPPORTED_AMOUNT_MATCHES_BILLED',
      'FINANCIAL_NTE_FACT_MISSING',
    ]);
    assert.equal(result.exposure?.total_contract_supported_amount, 0);
    assert.equal(result.exposure?.total_at_risk_amount, 69);
    assert.equal(result.status, 'BLOCKED');
  });

  it.each([
    { scenario: 'human_override' as const, pricingBranch: 'structural_wins' as const },
    { scenario: 'human_review' as const, pricingBranch: 'structural_wins' as const },
    { scenario: 'human_override' as const, pricingBranch: 'persisted_wins' as const },
    { scenario: 'human_review' as const, pricingBranch: 'persisted_wins' as const },
  ])('publishes through the real validation flow without changing $scenario $pricingBranch authority', async ({
    scenario,
    pricingBranch,
  }) => {
    configureFixture(scenario, pricingBranch);

    await runValidationFlow({
      projectId: PROJECT_ID,
      source: 'manual',
      inputsSnapshotHash: INPUTS_SNAPSHOT_HASH,
    });

    assert.equal(mocks.persistValidationRun.mock.calls.length, 1);
    assert.equal(mocks.dualViewAssemblySpy.mock.calls.length, 1);
    assert.equal(mocks.scheduleCanonicalProjectTruthShadowPublication.mock.calls.length, 1);
    assert.ok(
      mocks.persistValidationRun.mock.invocationCallOrder[0]
        < mocks.scheduleCanonicalProjectTruthShadowPublication.mock.invocationCallOrder[0],
    );
    assert.equal(
      mocks.after.mock.calls.filter(([task]) => typeof task === 'function').length,
      0,
    );
    const publicationOffResult = mocks.persistValidationRun.mock.calls[0][1];
    const publicationOffSelectedRows = mocks.dualViewAssemblySpy.mock.calls[0][1].selectedRows;

    mocks.after.mockClear();
    mocks.dualViewAssemblySpy.mockClear();
    mocks.persistValidationRun.mockClear();
    mocks.scheduleCanonicalProjectTruthShadowPublication.mockClear();
    mocks.structuralRowsOverride.mockReset();
    mocks.structuralRowsOverride.mockReturnValue(undefined);
    admin.storage.from.mockClear();
    uploadedPublicationBodies.clear();
    configureFixture(scenario, pricingBranch);
    process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH = 'all';

    await runValidationFlow({
      projectId: PROJECT_ID,
      source: 'manual',
      inputsSnapshotHash: INPUTS_SNAPSHOT_HASH,
    });

    assert.equal(mocks.persistValidationRun.mock.calls.length, 1);
    assert.equal(mocks.dualViewAssemblySpy.mock.calls.length, 1);
    assert.equal(mocks.scheduleCanonicalProjectTruthShadowPublication.mock.calls.length, 1);
    assert.ok(
      mocks.persistValidationRun.mock.invocationCallOrder[0]
        < mocks.scheduleCanonicalProjectTruthShadowPublication.mock.invocationCallOrder[0],
    );
    const publicationCallbacks = mocks.after.mock.calls
      .map(([task]) => task)
      .filter((task): task is () => Promise<void> => typeof task === 'function');
    assert.equal(publicationCallbacks.length, 1);

    const publicationOnResult = mocks.persistValidationRun.mock.calls[0][1];
    const publicationOnSelectedRows = mocks.dualViewAssemblySpy.mock.calls[0][1].selectedRows;
    const schedulerInput = mocks.scheduleCanonicalProjectTruthShadowPublication.mock.calls[0][0];
    assert.deepEqual(publicationOnResult, publicationOffResult);
    assert.deepEqual(publicationOnResult.findings, publicationOffResult.findings);
    assert.deepEqual(publicationOnResult.exposure, publicationOffResult.exposure);
    assert.deepEqual(publicationOnSelectedRows, publicationOffSelectedRows);
    assert.equal(schedulerInput.projectId, PROJECT_ID);
    assert.equal(schedulerInput.runId, VALIDATION_RUN_ID);
    assert.equal(schedulerInput.inputsSnapshotHash, INPUTS_SNAPSHOT_HASH);
    assert.equal(schedulerInput.effectiveResult, publicationOnResult);
    assert.deepEqual(
      schedulerInput.validatorInput.assembledContractPricingRows,
      publicationOnSelectedRows,
    );
    assert.equal(schedulerInput.persistedFindings, publicationOnResult.findings);

    const resultBeforePublication = structuredClone(publicationOnResult);
    await publicationCallbacks[0]();
    assert.deepEqual(publicationOnResult, resultBeforePublication);
    assert.equal(admin.storage.from.mock.calls.length, 1);
    assert.equal(
      [...uploadedPublicationBodies.keys()].filter((path) => path.endsWith('/manifest.json')).length,
      1,
    );
    const manifestEntry = [...uploadedPublicationBodies.entries()]
      .find(([path]) => path.endsWith('/manifest.json'));
    assert.ok(manifestEntry);
    const manifest = JSON.parse(new TextDecoder().decode(manifestEntry[1])) as {
      sourceRun: { runId: string; inputsSnapshotHash: string };
      inputCounts: { assembledPricingRows: number };
    };
    assert.equal(manifest.sourceRun.runId, VALIDATION_RUN_ID);
    assert.equal(manifest.sourceRun.inputsSnapshotHash, INPUTS_SNAPSHOT_HASH);
    assert.equal(
      manifest.inputCounts.assembledPricingRows,
      publicationOnSelectedRows.length,
    );

    const coreEntry = [...uploadedPublicationBodies.entries()]
      .find(([path]) => path.endsWith('/registry.core.json.gz'));
    assert.ok(coreEntry);
    const core = JSON.parse(gunzipSync(coreEntry[1]).toString('utf8')) as {
      contractPricing: readonly unknown[];
    };
    assert.equal(core.contractPricing.length, publicationOnSelectedRows.length);
  });

  it('contains a real publisher destination failure after persistence without changing authority', async () => {
    configureFixture('human_override', 'persisted_wins');
    process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH = 'all';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    admin.storage.from.mockImplementationOnce(() => ({
      list: vi.fn(async () => ({ data: [], error: null })),
      upload: vi.fn(async () => ({ error: { statusCode: 500, message: 'injected upload failure' } })),
      info: vi.fn(async () => ({ data: null, error: null })),
    }));

    await runValidationFlow({
      projectId: PROJECT_ID,
      source: 'manual',
      inputsSnapshotHash: INPUTS_SNAPSHOT_HASH,
    });
    const persistedResult = mocks.persistValidationRun.mock.calls[0][1];
    const resultBeforePublication = structuredClone(persistedResult);
    const publicationCallback = mocks.after.mock.calls
      .map(([task]) => task)
      .find((task): task is () => Promise<void> => typeof task === 'function');
    assert.ok(publicationCallback);
    await publicationCallback();

    assert.equal(mocks.persistValidationRun.mock.calls.length, 1);
    assert.equal(mocks.dualViewAssemblySpy.mock.calls.length, 1);
    assert.equal(mocks.scheduleCanonicalProjectTruthShadowPublication.mock.calls.length, 1);
    assert.deepEqual(persistedResult, resultBeforePublication);
    assert.equal(
      consoleError.mock.calls.filter(([message]) => (
        message === '[canonicalProjectTruthShadow] publication failed'
      )).length,
      1,
    );
    consoleError.mockRestore();
  });
});
