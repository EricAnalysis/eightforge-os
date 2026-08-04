import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, it, vi } from 'vitest';

const { dualViewAssemblySpy, afterMock } = vi.hoisted(() => ({
  dualViewAssemblySpy: vi.fn(),
  afterMock: vi.fn(),
}));

vi.mock('next/server', () => ({ after: afterMock }));
vi.mock('@/lib/contracts/contractPricingAssembly', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/contracts/contractPricingAssembly')>();
  return {
    ...actual,
    assembleContractPricingRowsWithCandidates: (
      ...args: Parameters<typeof actual.assembleContractPricingRowsWithCandidates>
    ) => {
      const result = actual.assembleContractPricingRowsWithCandidates(...args);
      dualViewAssemblySpy(args, result);
      return result;
    },
  };
});

import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import { scheduleCanonicalProjectTruthShadowPublication } from '@/lib/canonical/publication/publishProjectTruthShadow';
import {
  buildContractValidationContext,
  buildRateScheduleItems,
  buildSourceArtifactSnapshot,
  retainAssembledContractPricingRows,
} from '@/lib/validator/projectValidator';
import type {
  ValidatorContractAnalysisContext,
  ValidatorDocumentRow,
  ValidatorFactRecord,
  ValidatorLegacyExtractionRow,
} from '@/lib/validator/shared';

function document(): ValidatorDocumentRow {
  return {
    id: 'document-1',
    project_id: 'project-1',
    organization_id: 'organization-1',
    title: 'Contract',
    name: 'contract.pdf',
    document_type: 'contract',
    document_role: 'base_contract',
    storage_path: 'organization-1/project-1/contract.pdf',
    created_at: '2026-08-01T00:00:00.000Z',
  };
}

function assembledRow(rate: number): ContractPricingAssemblyRow {
  return {
    id: 'retained-rate-row',
    category: 'hauling_transport',
    description: 'Retained hauling rate',
    route: null,
    distanceBand: null,
    unit: 'TON',
    rate,
    page: 4,
    sourceAnchor: 'anchor-1',
    confidence: 'high',
    sourceKind: 'rate_schedule',
    sourceQuality: 'clean',
    authoredValueCorrection: false,
    rawText: `Retained hauling rate $${rate}/TON`,
  };
}

function persistedContractDocument(
  rateScheduleRows: readonly Record<string, unknown>[],
): ValidatorDocumentRow {
  return {
    ...document(),
    intelligence_trace: {
      classification: { family: 'contract' },
      contract_analysis: {
        rate_schedule_rows: rateScheduleRows,
      },
    },
  };
}

const unresolvedPersistedRateRow = {
  row_id: 'unresolved-persisted-rate-row',
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
} as const;

function validatorFact(source: 'human_override' | 'human_review'): ValidatorFactRecord {
  return {
    id: `${source}-fact`,
    document_id: 'document-1',
    key: 'rate_schedule_present',
    value: true,
    source,
    field_type: null,
    evidence: [],
  };
}

function legacyContractRateTable(): ValidatorLegacyExtractionRow {
  return {
    document_id: 'document-1',
    created_at: '2026-08-01T00:00:00.000Z',
    data: {
      fields: {
        typed_fields: {
          rate_table: [{
            row_id: 'typed-rate-row',
            description: 'Vegetative debris removal',
            category: 'Vegetative Collect, Remove & Haul',
            unit: 'Cubic Yard',
            rate: 6.9,
            page: 8,
          }],
        },
      },
      extraction: {
        text_preview: 'Vegetative debris removal $6.90 per cubic yard.',
      },
    },
  };
}

const truthCategoryDocumentIds = {
  contract_identity: ['document-1'],
  pricing: [],
  compliance: [],
  amendments: [],
};

describe('retained validator input state', () => {
  beforeEach(() => {
    dualViewAssemblySpy.mockClear();
    afterMock.mockClear();
    delete process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH;
  });

  it('has one authorized dual-view pricing call site and freezes the retained rows and array', () => {
    const source = readFileSync(new URL('./projectValidator.ts', import.meta.url), 'utf8');
    const invocations = source.match(/\bassembleContractPricingRowsWithCandidates\s*\(/g) ?? [];
    assert.equal(invocations.length, 1);
    assert.equal(/\bassembleContractPricingRows\s*\(/.test(source), false);

    const retained = retainAssembledContractPricingRows([assembledRow(99)]);
    assert.equal(Object.isFrozen(retained), true);
    assert.equal(Object.isFrozen(retained[0]), true);
  });

  it.each([
    {
      name: 'ordinary persisted contract intelligence',
      documents: [persistedContractDocument([{
        row_id: 'ordinary-rate-row',
        description: 'Vegetative debris removal',
        category: 'Vegetative Collect, Remove & Haul',
        unit: 'Cubic Yard',
        rate: 6.9,
        page: 8,
      }])],
      facts: [],
      legacyRows: [],
      expectedSelectedIds: ['ordinary-rate-row'],
      expectedContext: { rowId: 'ordinary-rate-row', category: 'Vegetative Collect, Remove & Haul', rate: 6.9, unit: 'Cubic Yard' },
    },
    {
      name: 'duplicate candidates and winner selection',
      documents: [persistedContractDocument([
        {
          row_id: 'duplicate-low',
          description: 'Vegetative debris removal',
          category: 'Vegetative Collect, Remove & Haul',
          unit: 'Cubic Yard',
          rate: 6.9,
          page: 8,
          confidence: 'needs_review',
        },
        {
          row_id: 'duplicate-high',
          description: 'Vegetative debris removal',
          category: 'Vegetative Collect, Remove & Haul',
          unit: 'Cubic Yard',
          rate: 6.9,
          page: 8,
          confidence: 'high',
        },
      ])],
      facts: [],
      legacyRows: [],
      expectedSelectedIds: ['duplicate-high'],
      expectedContext: { rowId: 'duplicate-low', category: 'Vegetative Collect, Remove & Haul', rate: 6.9, unit: 'Cubic Yard' },
    },
    {
      name: 'authored correction',
      documents: [persistedContractDocument([{
        row_id: 'authored-correction-row',
        description: 'Vegetative debris removal',
        category: 'Vegetative Collect, Remove & Haul',
        unit: 'Cubic Yard',
        rate: 6.9,
        page: 8,
        authoredValueCorrection: true,
      }])],
      facts: [],
      legacyRows: [],
      expectedSelectedIds: ['authored-correction-row'],
      expectedContext: { rowId: 'authored-correction-row', category: 'Vegetative Collect, Remove & Haul', rate: 6.9, unit: 'Cubic Yard' },
    },
    {
      name: 'synthetic contract-intelligence enrichment after a human override',
      documents: [document()],
      facts: [validatorFact('human_override')],
      legacyRows: [legacyContractRateTable()],
      expectedSelectedIds: ['rate_row:1'],
      expectedContext: { rowId: 'rate_row:1', category: 'Vegetative Collect, Remove & Haul', rate: 6.9, unit: 'cubic yard' },
    },
    {
      name: 'synthetic contract-intelligence enrichment after a human review',
      documents: [document()],
      facts: [validatorFact('human_review')],
      legacyRows: [legacyContractRateTable()],
      expectedSelectedIds: ['rate_row:1'],
      expectedContext: { rowId: 'rate_row:1', category: 'Vegetative Collect, Remove & Haul', rate: 6.9, unit: 'cubic yard' },
    },
    {
      name: 'validation with no contract context',
      documents: [],
      facts: [],
      legacyRows: [],
      expectedSelectedIds: [],
      expectedContext: null,
    },
  ])('executes one dual-view assembly with explicit semantic output for $name', ({
    documents,
    facts,
    legacyRows,
    expectedSelectedIds,
    expectedContext,
  }) => {
    const factsByDocumentId = facts.length > 0
      ? new Map([['document-1', facts]])
      : new Map<string, ValidatorFactRecord[]>();
    const legacyRowsByDocumentId = new Map(
      legacyRows.map((row) => [row.document_id, row] as const),
    );

    const context = buildContractValidationContext({
      documents,
      factsByDocumentId,
      legacyRowsByDocumentId,
      truthCategoryDocumentIds: documents.length > 0
        ? truthCategoryDocumentIds
        : { ...truthCategoryDocumentIds, contract_identity: [] },
    });

    assert.equal(dualViewAssemblySpy.mock.calls.length, 1);
    const assembly = dualViewAssemblySpy.mock.calls[0]?.[1] as {
      selectedRows: readonly ContractPricingAssemblyRow[];
    };
    assert.deepEqual(assembly.selectedRows.map((selected) => selected.id), expectedSelectedIds);
    const scheduleItems = buildRateScheduleItems({
      factsByDocumentId,
      rateDocumentIds: [],
      contractValidationContext: context,
      assembledContractPricingRows: assembly.selectedRows,
    });
    assert.deepEqual(scheduleItems.map((item) => ({
      sourceDocumentId: item.source_document_id,
      recordId: item.record_id,
      category: item.source_category,
      rate: item.rate_amount,
      unit: item.unit_type,
    })), expectedSelectedIds.map((recordId) => ({
      sourceDocumentId: 'document-1',
      recordId,
      category: 'Vegetative Collect, Remove & Haul',
      rate: 6.9,
      unit: 'Cubic Yard',
    })));
    if (!expectedContext) {
      assert.equal(context, null);
      return;
    }
    const contextRow = context?.analysis.rate_schedule_rows?.[0];
    assert.deepEqual({
      rowId: contextRow?.row_id,
      category: contextRow?.category,
      rate: contextRow?.rate_amount ?? contextRow?.rate,
      unit: contextRow?.unit ?? contextRow?.unit_type,
    }, expectedContext);
  });

  it('keeps rescue disabled for persisted context without an override', () => {
    const context = buildContractValidationContext({
      documents: [persistedContractDocument([unresolvedPersistedRateRow])],
      factsByDocumentId: new Map(),
      legacyRowsByDocumentId: new Map(),
      truthCategoryDocumentIds,
    });

    assert.equal(dualViewAssemblySpy.mock.calls.length, 1);
    const [args, assembly] = dualViewAssemblySpy.mock.calls[0] as [
      [unknown, unknown, { selectedCategoryBySourceRow?: ReadonlyMap<string, string> }],
      { selectedRows: readonly ContractPricingAssemblyRow[] },
    ];
    assert.equal(args[2].selectedCategoryBySourceRow, undefined);
    assert.deepEqual(assembly.selectedRows, []);
    assert.deepEqual(context?.analysis.rate_schedule_rows, [unresolvedPersistedRateRow]);
    assert.deepEqual(buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [],
      contractValidationContext: context,
      assembledContractPricingRows: assembly.selectedRows,
    }), []);
  });

  it('keeps rescue disabled for the project-summary persisted path', () => {
    const context = buildContractValidationContext({
      projectValidationSummary: {
        contract_validation_context: {
          document_id: 'project-summary-contract',
          analysis: {
            rate_schedule_rows: [unresolvedPersistedRateRow],
          },
        },
      },
      documents: [],
      factsByDocumentId: new Map(),
      legacyRowsByDocumentId: new Map(),
      truthCategoryDocumentIds: {
        contract_identity: [],
        pricing: [],
        compliance: [],
        amendments: [],
      },
    });

    assert.equal(dualViewAssemblySpy.mock.calls.length, 1);
    const [args, assembly] = dualViewAssemblySpy.mock.calls[0] as [
      [unknown, unknown, { selectedCategoryBySourceRow?: ReadonlyMap<string, string> }],
      { selectedRows: readonly ContractPricingAssemblyRow[] },
    ];
    assert.equal(args[2].selectedCategoryBySourceRow, undefined);
    assert.deepEqual(assembly.selectedRows, []);
    assert.deepEqual(context?.analysis.rate_schedule_rows, [unresolvedPersistedRateRow]);
    assert.deepEqual(buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [],
      contractValidationContext: context,
      assembledContractPricingRows: assembly.selectedRows,
    }), []);
  });

  it.each([
    { publication: 'disabled', flag: undefined, scheduled: 0 },
    { publication: 'enabled', flag: 'all', scheduled: 1 },
  ])('keeps one validation assembly when publication is $publication', ({ flag, scheduled }) => {
    if (flag) process.env.EIGHTFORGE_CANONICAL_SHADOW_PUBLISH = flag;
    const context = buildContractValidationContext({
      documents: [persistedContractDocument([])],
      factsByDocumentId: new Map(),
      legacyRowsByDocumentId: new Map(),
      truthCategoryDocumentIds,
    });
    scheduleCanonicalProjectTruthShadowPublication({
      projectId: 'project-1',
    } as Parameters<typeof scheduleCanonicalProjectTruthShadowPublication>[0]);

    assert.equal(dualViewAssemblySpy.mock.calls.length, 1);
    assert.equal(afterMock.mock.calls.length, scheduled);
    const assembly = dualViewAssemblySpy.mock.calls[0]?.[1] as {
      selectedRows: readonly ContractPricingAssemblyRow[];
    };
    assert.deepEqual(assembly.selectedRows, []);
    assert.deepEqual(context?.analysis.rate_schedule_rows, []);
  });
  it('normalizes the retained assembled pricing rows instead of assembling persisted rows again', () => {
    const retainedRows = Object.freeze([assembledRow(99)]);
    const contractValidationContext = {
      document_id: 'document-1',
      analysis: {
        rate_schedule_rows: [{
          row_id: 'persisted-rate-row',
          description: 'Persisted rate that must not be reassembled',
          rate_amount: 5,
          unit_type: 'TON',
        }],
      },
    } as ValidatorContractAnalysisContext;

    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: ['document-1'],
      contractValidationContext,
      assembledContractPricingRows: retainedRows,
    });

    assert.equal(items.length, 1);
    assert.equal(items[0]?.record_id, 'retained-rate-row');
    assert.equal(items[0]?.rate_amount, 99);
  });

  it('copies and freezes the exact source identity observed during input construction', () => {
    const mutableDocument = document();
    const mutableArtifact = {
      id: 'artifact-2',
      source_document_id: mutableDocument.id,
      source_sha256: 'b'.repeat(64),
      storage_object_version: 'version-2',
      media_type_sniffed: 'application/pdf',
      byte_length: 202,
      created_at: '2026-08-02T00:00:00.000Z',
    };
    const snapshot = buildSourceArtifactSnapshot({
      documents: [mutableDocument],
      sourceArtifacts: [
        {
          ...mutableArtifact,
          id: 'artifact-1',
          source_sha256: 'a'.repeat(64),
          storage_object_version: 'version-1',
          created_at: '2026-08-01T00:00:00.000Z',
        },
        mutableArtifact,
      ],
    });

    mutableDocument.storage_path = 'changed/after-input-construction.pdf';
    mutableArtifact.source_sha256 = 'c'.repeat(64);
    mutableArtifact.storage_object_version = 'version-3';

    assert.equal(Object.isFrozen(snapshot), true);
    assert.equal(Object.isFrozen(snapshot[0]), true);
    assert.equal(snapshot[0]?.storagePath, 'organization-1/project-1/contract.pdf');
    assert.equal(snapshot[0]?.sourceArtifactId, 'artifact-2');
    assert.equal(snapshot[0]?.sourceSha256, 'b'.repeat(64));
    assert.equal(snapshot[0]?.storageObjectVersion, 'version-2');
  });

  it('retains deterministic null gaps without inferring a replacement identity', () => {
    const [entry] = buildSourceArtifactSnapshot({
      documents: [document()],
      sourceArtifacts: [],
    });

    assert.equal(entry?.storagePath, 'organization-1/project-1/contract.pdf');
    assert.equal(entry?.sourceArtifactId, null);
    assert.equal(entry?.sourceSha256, null);
    assert.equal(entry?.storageObjectVersion, null);
    assert.equal(entry?.exactSourceIdentity, null);
  });

  it('does not collapse distinct immutable versions of the same logical document', () => {
    const identityFor = (sourceSha256: string, storageObjectVersion: string) => (
      buildSourceArtifactSnapshot({
        documents: [document()],
        sourceArtifacts: [{
          id: `artifact-${storageObjectVersion}`,
          source_document_id: 'document-1',
          source_sha256: sourceSha256,
          storage_object_version: storageObjectVersion,
          media_type_sniffed: 'application/pdf',
          byte_length: 100,
          created_at: '2026-08-01T00:00:00.000Z',
        }],
      })[0]?.exactSourceIdentity
    );

    assert.notEqual(identityFor('a'.repeat(64), 'version-1'), identityFor('b'.repeat(64), 'version-2'));
  });
});
