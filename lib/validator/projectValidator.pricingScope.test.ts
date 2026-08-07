/**
 * C3 — canonical pricing assembly scope.
 *
 * Covers relationship-alias canonicalization, exclusion handling (including the
 * `voided` regression the alias change could have silently neutralized),
 * per-document anchored reading, document-scoped row identity, and the
 * unresolved duplicate-authority block.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'vitest';

import {
  buildContractPricingExecution,
  buildDocumentIdsByFamily,
  buildExcludedValidationDocumentIds,
  buildPersistedPricingSourceRateScheduleRows,
  buildRateScheduleItems,
} from '@/lib/validator/projectValidator';
import { contractPricingScopedRowId } from '@/lib/contracts/contractPricingAssembly';
import type {
  DocumentRelationshipRecord,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import type {
  ValidatorDocumentRow,
  ValidatorFactRecord,
  ValidatorLegacyExtractionRow,
} from '@/lib/validator/shared';

const CONTRACT_ID = 'contract-doc';
const SHEET_A = 'aaaa-price-sheet';
const SHEET_B = 'bbbb-price-sheet';

/**
 * One anchored rate row, in the shape price-sheet traces actually publish and
 * that the assembler actually emits (a thinner row is suppressed by the
 * operator-facing selection rules and would make these tests assert nothing).
 */
function rateScheduleRow(overrides: Record<string, unknown> = {}) {
  return {
    row_id: 'structural_table:pdf:table:p2:t3:r1',
    description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles',
    unit: 'Cubic Yard',
    rate: 27,
    category: 'Vegetative Collect, Remove & Haul',
    source_category: 'Vegetative Collect, Remove & Haul',
    canonical_category: 'vegetative',
    category_confidence: 0.92,
    page: 2,
    source_anchor_ids: ['anchor:p2:t3:r1'],
    rate_raw:
      'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 0 to 15 Miles | Cubic Yard | $27.00',
    material_type: 'Vegetative Collect, Remove & Haul',
    unit_type: 'Cubic Yard',
    rate_amount: 27,
    ...overrides,
  };
}

function priceSheet(
  id: string,
  overrides: Partial<ValidatorDocumentRow> = {},
  rows: readonly unknown[] = [rateScheduleRow()],
): ValidatorDocumentRow {
  return {
    id,
    project_id: 'project-1',
    title: 'Goodlettsville price sheet',
    name: 'price-sheet.pdf',
    document_type: 'price_sheet',
    created_at: '2026-06-16T00:00:00.000Z',
    intelligence_trace: {
      classification: { family: 'pricing' },
      contract_analysis: { rate_schedule_rows: rows },
    },
    ...overrides,
  } as unknown as ValidatorDocumentRow;
}

function contractDocument(): ValidatorDocumentRow {
  return {
    id: CONTRACT_ID,
    project_id: 'project-1',
    title: 'Base contract',
    name: 'contract.pdf',
    document_type: 'contract',
    created_at: '2026-05-01T00:00:00.000Z',
    intelligence_trace: {
      classification: { family: 'contract' },
      contract_analysis: { rate_schedule_rows: [] },
    },
  } as unknown as ValidatorDocumentRow;
}

function relationship(
  sourceDocumentId: string,
  relationshipType: string,
  targetDocumentId = CONTRACT_ID,
): DocumentRelationshipRecord {
  return {
    source_document_id: sourceDocumentId,
    target_document_id: targetDocumentId,
    relationship_type: relationshipType,
  } as DocumentRelationshipRecord;
}

function contractFamily(
  documentIds: readonly string[],
  overrides: Partial<ResolvedDocumentPrecedenceFamily> = {},
): ResolvedDocumentPrecedenceFamily {
  return {
    family: 'contract',
    label: 'Contract',
    governing_document_id: CONTRACT_ID,
    governing_reason: null,
    governing_reason_detail: null,
    has_operator_override: false,
    considered_document_ids: [...documentIds],
    documents: documentIds.map((id) => ({
      id,
      resolved_subtype: id === CONTRACT_ID ? 'base_contract' : 'pricing_schedule',
      document_type: id === CONTRACT_ID ? 'contract' : 'price sheet',
      authority_status: null,
      effective_date: null,
    })),
    ...overrides,
  } as unknown as ResolvedDocumentPrecedenceFamily;
}

function executionFor(params: {
  documents: readonly ValidatorDocumentRow[];
  relationships: readonly DocumentRelationshipRecord[];
  families: readonly ResolvedDocumentPrecedenceFamily[];
  excluded?: ReadonlySet<string>;
  storeState?: 'read' | 'unreadable';
  storeReadError?: string | null;
}) {
  const { truthCategoryDocumentIds } = buildDocumentIdsByFamily(
    params.documents,
    params.families,
    params.relationships,
  );
  return buildContractPricingExecution({
    documents: params.documents,
    factsByDocumentId: new Map<string, ValidatorFactRecord[]>(),
    legacyRowsByDocumentId: new Map<string, ValidatorLegacyExtractionRow>(),
    truthCategoryDocumentIds,
    precedenceFamilies: params.families,
    documentRelationships: params.relationships,
    excludedValidationDocumentIds: params.excluded ?? new Set<string>(),
    sourceIdentityStoreState: params.storeState ?? 'read',
    sourceIdentityReadError: params.storeReadError ?? null,
  });
}

// ── Relationship scope ───────────────────────────────────────────────────────
describe('C3 pricing relationship scope', () => {
  for (const alias of ['attached_to', 'governs', 'applies_to'] as const) {
    it(`includes a price sheet linked as ${alias}`, () => {
      const documents = [contractDocument(), priceSheet(SHEET_A)];
      const { truthCategoryDocumentIds } = buildDocumentIdsByFamily(
        documents,
        [contractFamily([CONTRACT_ID])],
        [relationship(SHEET_A, alias)],
      );

      assert.ok(
        truthCategoryDocumentIds.pricing.includes(SHEET_A),
        `${alias} must canonicalize to attached_to`,
      );
    });
  }

  it('excludes a relationship that is not a pricing attachment', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A)];
    const { truthCategoryDocumentIds } = buildDocumentIdsByFamily(
      documents,
      [contractFamily([CONTRACT_ID])],
      [relationship(SHEET_A, 'supplements')],
    );

    assert.equal(truthCategoryDocumentIds.pricing.includes(SHEET_A), false);
  });

  it('does not treat an unknown relationship string as an attachment', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A)];
    const { truthCategoryDocumentIds } = buildDocumentIdsByFamily(
      documents,
      [contractFamily([CONTRACT_ID])],
      [relationship(SHEET_A, 'loosely_related')],
    );

    assert.equal(truthCategoryDocumentIds.pricing.includes(SHEET_A), false);
  });
});

// ── Exclusion state stays separate from relationship meaning ─────────────────
describe('C3 exclusion state after alias canonicalization', () => {
  it('still excludes a voided target — voided is not relationship vocabulary', () => {
    const excluded = buildExcludedValidationDocumentIds({
      precedenceFamilies: [],
      documentRelationships: [relationship('actor-doc', 'voided', SHEET_A)],
    });

    assert.ok(
      excluded.has(SHEET_A),
      'routing voided through canonicalizeRelationshipType would return null and drop the exclusion',
    );
  });

  it('still excludes supersedes and replaces targets', () => {
    const excluded = buildExcludedValidationDocumentIds({
      precedenceFamilies: [],
      documentRelationships: [
        relationship('newer', 'supersedes', SHEET_A),
        relationship('newer', 'replaces', SHEET_B),
      ],
    });

    assert.ok(excluded.has(SHEET_A));
    assert.ok(excluded.has(SHEET_B));
  });

  it('keeps an excluded price sheet out of row loading entirely', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A), priceSheet(SHEET_B)];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to'), relationship(SHEET_B, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A, SHEET_B])],
      excluded: new Set([SHEET_B]),
    });

    const sourceDocuments = new Set(
      execution.assembly.selectedRows.map((row) => row.sourceDocumentId),
    );
    assert.equal(sourceDocuments.has(SHEET_B), false);
    assert.ok(sourceDocuments.has(SHEET_A));
  });

  it('an excluded source cannot trigger duplicate authority', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A), priceSheet(SHEET_B)];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to'), relationship(SHEET_B, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A, SHEET_B])],
      excluded: new Set([SHEET_B]),
    });

    assert.deepEqual(execution.duplicateAuthorityFindings, []);
  });
});

// ── Per-document reading ─────────────────────────────────────────────────────
describe('C3 per-document anchored reading', () => {
  it('reads anchored rows from a pricing-eligible document', () => {
    const rows = buildPersistedPricingSourceRateScheduleRows(priceSheet(SHEET_A));

    assert.equal(rows?.length, 1);
    assert.deepEqual(rows?.[0]?.source_anchor_ids, ['anchor:p2:t3:r1']);
  });

  it('returns null for a document that is not a rate authority', () => {
    const unrelated = priceSheet(SHEET_A, {
      document_type: 'invoice',
      intelligence_trace: {
        classification: { family: 'invoice' },
        contract_analysis: { rate_schedule_rows: [rateScheduleRow()] },
      },
    } as Partial<ValidatorDocumentRow>);

    assert.equal(buildPersistedPricingSourceRateScheduleRows(unrelated), null);
  });

  it('keeps each row anchored to the document it was read from', () => {
    const documents = [
      contractDocument(),
      priceSheet(SHEET_A),
      priceSheet(SHEET_B, {}, [rateScheduleRow({
        row_id: 'other:row',
        rate: 31,
        rate_amount: 31,
        description: 'Vegetative Collect, Remove & Haul from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles',
        rate_raw:
          'Vegetative Collect, Remove & Haul | from Unincorporated Neighborhood ROW to DMS 16 to 30 Miles | Cubic Yard | $31.00',
        source_anchor_ids: ['anchor:p2:t3:r2'],
      })]),
    ];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to'), relationship(SHEET_B, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A, SHEET_B])],
    });

    const bySource = new Map(
      execution.assembly.selectedRows.map((row) => [row.sourceDocumentId, row]),
    );
    assert.equal(bySource.get(SHEET_A)?.rate, 27);
    assert.equal(bySource.get(SHEET_B)?.rate, 31);
  });
});

// ── Row identity ─────────────────────────────────────────────────────────────
describe('C3 document-scoped row identity', () => {
  it('keeps identical physical row ids from different documents distinct', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A), priceSheet(SHEET_B)];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to'), relationship(SHEET_B, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A, SHEET_B])],
    });

    const physical = execution.assembly.selectedRows.map((row) => row.id);
    const scoped = execution.assembly.selectedRows.map(contractPricingScopedRowId);

    assert.equal(new Set(physical).size, 1, 'the physical ids genuinely collide');
    assert.equal(new Set(scoped).size, 2, 'scoped identity must separate them');
  });

  it('preserves the original row id rather than rewriting it', () => {
    const scoped = contractPricingScopedRowId({
      id: 'structural_table:pdf:table:p2:t3:r1',
      sourceDocumentId: SHEET_A,
    });

    assert.equal(scoped, `${SHEET_A}:structural_table:pdf:table:p2:t3:r1`);
    assert.ok(scoped.endsWith('structural_table:pdf:table:p2:t3:r1'));
  });

  it('is deterministic and falls back to the bare id without a source document', () => {
    const row = { id: 'row-1', sourceDocumentId: null };
    assert.equal(contractPricingScopedRowId(row), 'row-1');
    assert.equal(contractPricingScopedRowId(row), contractPricingScopedRowId(row));
  });
});

// ── Duplicate authority, end to end ──────────────────────────────────────────
describe('C3 duplicate authority through the assembly path', () => {
  const twoIdenticalSheets = () => ({
    documents: [contractDocument(), priceSheet(SHEET_A), priceSheet(SHEET_B)],
    relationships: [relationship(SHEET_A, 'attached_to'), relationship(SHEET_B, 'attached_to')],
    families: [contractFamily([CONTRACT_ID, SHEET_A, SHEET_B])],
  });

  it('emits one blocking finding naming both documents', () => {
    const execution = executionFor(twoIdenticalSheets());

    assert.equal(execution.duplicateAuthorityFindings.length, 1);
    assert.deepEqual(
      [...execution.duplicateAuthorityFindings[0]!.documentIds].sort(),
      [SHEET_A, SHEET_B].sort(),
    );
  });

  it('names the missing source-hash discriminator when identity is absent', () => {
    const execution = executionFor(twoIdenticalSheets());
    const [finding] = execution.duplicateAuthorityFindings;

    assert.equal(finding!.sourceIdentityStatus, 'absent');
    assert.equal(finding!.missingDiscriminator, 'extraction_source_artifacts.source_sha256');
  });

  it('distinguishes an unreadable identity store from an absent identity', () => {
    const execution = executionFor({ ...twoIdenticalSheets(), storeState: 'unreadable' });

    assert.equal(execution.duplicateAuthorityFindings[0]?.sourceIdentityStatus, 'unreadable');
  });

  it('carries a realistic Postgrest read error through to the diagnostic', () => {
    const execution = executionFor({
      ...twoIdenticalSheets(),
      storeState: 'unreadable',
      storeReadError: 'relation "extraction_source_artifacts" does not exist',
    });

    const finding = execution.duplicateAuthorityFindings[0];
    assert.equal(finding?.sourceIdentityReadError, 'relation "extraction_source_artifacts" does not exist');
  });

  it('does not attach an error message when the identity store was read successfully', () => {
    const execution = executionFor({
      ...twoIdenticalSheets(),
      storeState: 'read',
      // Even if a caller mistakenly supplies leftover error text on a
      // successful read, the finding must not surface it as a store failure.
      storeReadError: 'stale error from a previous unrelated call',
    });

    assert.equal(execution.duplicateAuthorityFindings[0]?.sourceIdentityReadError, null);
  });

  it('never surfaces credential- or connection-string-shaped substrings in the diagnostic', () => {
    // A generic PostgREST error is safe to surface verbatim; this guards
    // against a future caller passing something richer (a raw driver error,
    // a stringified exception with a DSN) straight through unsanitized.
    const suspiciousPatterns = [/postgres(?:ql)?:\/\//i, /service_role/i, /apikey/i, /:\/\/.*@/i];
    const execution = executionFor({
      ...twoIdenticalSheets(),
      storeState: 'unreadable',
      storeReadError: 'permission denied for table extraction_source_artifacts',
    });

    const finding = execution.duplicateAuthorityFindings[0];
    const serialized = JSON.stringify(finding);
    for (const pattern of suspiciousPatterns) {
      assert.equal(pattern.test(serialized), false, `diagnostic must not match ${pattern}`);
    }
  });

  it('produces a byte-identical unreadable-state diagnostic across repeated runs', () => {
    const params = {
      ...twoIdenticalSheets(),
      storeState: 'unreadable' as const,
      storeReadError: 'relation "extraction_source_artifacts" does not exist',
    };
    const first = executionFor(params);
    const second = executionFor(params);

    assert.equal(
      JSON.stringify(first.duplicateAuthorityFindings),
      JSON.stringify(second.duplicateAuthorityFindings),
    );
  });

  it('records the attached_to relationship basis', () => {
    const execution = executionFor(twoIdenticalSheets());

    assert.deepEqual(execution.duplicateAuthorityFindings[0]?.relationshipBasis, ['attached_to']);
  });

  it('produces byte-identical output across repeated runs', () => {
    const first = executionFor(twoIdenticalSheets());
    const second = executionFor(twoIdenticalSheets());

    assert.equal(
      JSON.stringify(first.duplicateAuthorityFindings),
      JSON.stringify(second.duplicateAuthorityFindings),
    );
    assert.equal(
      JSON.stringify(first.assembly.selectedRows.map(contractPricingScopedRowId)),
      JSON.stringify(second.assembly.selectedRows.map(contractPricingScopedRowId)),
    );
  });

  it('does not block when a single price sheet is attached', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A)];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A])],
    });

    assert.deepEqual(execution.duplicateAuthorityFindings, []);
    assert.equal(execution.assembly.selectedRows.length, 1);
  });
});

// ── Schedule governance ──────────────────────────────────────────────────────
describe('C3 schedule governance resolution', () => {
  it('carries the precedence family governing document rather than re-deriving it', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A)];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A], {
        governing_document_id: SHEET_A,
        governing_reason: 'role_priority',
      } as Partial<ResolvedDocumentPrecedenceFamily>)],
    });

    assert.equal(execution.scheduleGovernance?.documentId, SHEET_A);
    assert.equal(execution.scheduleGovernance?.reason, 'role_priority');
  });

  it('leaves governance unresolved when no family governs an eligible source', () => {
    const documents = [contractDocument(), priceSheet(SHEET_A), priceSheet(SHEET_B)];
    const execution = executionFor({
      documents,
      relationships: [relationship(SHEET_A, 'attached_to'), relationship(SHEET_B, 'attached_to')],
      families: [contractFamily([CONTRACT_ID, SHEET_A, SHEET_B], {
        governing_document_id: null,
      } as Partial<ResolvedDocumentPrecedenceFamily>)],
    });

    assert.equal(execution.scheduleGovernance, null);
  });
});

// ── Legacy multiplicity through buildRateScheduleItems (re-review finding) ───
describe('C3 legacy rate-schedule-item lineage (buildRateScheduleItems)', () => {
  // `buildRateScheduleItems` is the shared builder behind `factLookups.rateScheduleItems`
  // — the legacy-facing item list that must retain a duplicate-authority pair as
  // TWO distinct items so the design's "legacy: ten rows because both uploads
  // were counted" outcome is possible at all. Before C3, `assembledContractPricingRows`
  // was empty for a Goodlettsville-shaped project (assembly was scoped to the
  // single contract document, which carries no rate table), so this function's
  // `assembledRateRows` branch was dormant and the correct per-document
  // fact-based branch ran instead. C3 makes `assembledContractPricingRows`
  // non-empty for exactly this shape, which activates a branch that — before
  // this fix — stamped every row with ONE fixed contract document id regardless
  // of `row.sourceDocumentId`, silently colliding two distinct documents'
  // identical-content rows in the dedupe key and dropping one of them.
  function goodlettsvilleRow(sourceDocumentId: string, overrides: Record<string, unknown> = {}) {
    return {
      id: 'structural_table:pdf:table:p2:t3:r1',
      sourceDocumentId,
      category: 'Vegetative Collect, Remove & Haul',
      description: 'Loading and Hauling Vegetative Debris From Right of Way (ROW)',
      route: null,
      distanceBand: null,
      unit: 'Cubic Yard',
      rate: 27,
      page: 2,
      sourceAnchor: 'pdf:table:p2:t3:r1',
      confidence: 'high',
      sourceKind: 'rate_schedule',
      sourceQuality: 'clean',
      authoredValueCorrection: false,
      ...overrides,
    };
  }

  it('keeps two documents duplicate rows as two distinct rate schedule items', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [SHEET_A, SHEET_B],
      contractValidationContext: { document_id: CONTRACT_ID } as never,
      assembledContractPricingRows: [
        goodlettsvilleRow(SHEET_A) as never,
        goodlettsvilleRow(SHEET_B) as never,
      ],
    });

    assert.equal(items.length, 2, 'two distinct documents must not collapse to one item');
    assert.deepEqual(
      [...items.map((item) => item.source_document_id)].sort(),
      [SHEET_A, SHEET_B].sort(),
    );
  });

  it('attributes each item to the document it actually came from, not the contract', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [SHEET_A, SHEET_B],
      contractValidationContext: { document_id: CONTRACT_ID } as never,
      assembledContractPricingRows: [
        goodlettsvilleRow(SHEET_A) as never,
        goodlettsvilleRow(SHEET_B) as never,
      ],
    });

    for (const item of items) {
      assert.notEqual(
        item.source_document_id,
        CONTRACT_ID,
        'a price-sheet-sourced row must not be attributed to the contract document',
      );
    }
  });

  it('still falls back to the contract document id for rows with no source document', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [CONTRACT_ID],
      contractValidationContext: { document_id: CONTRACT_ID } as never,
      assembledContractPricingRows: [
        goodlettsvilleRow(null as unknown as string) as never,
      ],
    });

    assert.equal(items[0]?.source_document_id, CONTRACT_ID);
  });

  it('preserves distinct rows genuinely from the same document', () => {
    const items = buildRateScheduleItems({
      factsByDocumentId: new Map(),
      rateDocumentIds: [SHEET_A],
      contractValidationContext: { document_id: CONTRACT_ID } as never,
      assembledContractPricingRows: [
        goodlettsvilleRow(SHEET_A, { id: 'row-1', rate: 27 }) as never,
        goodlettsvilleRow(SHEET_A, { id: 'row-2', rate: 5, description: 'Debris Mgmt. Site Management' }) as never,
      ],
    });

    assert.equal(items.length, 2);
  });
});

// ── Pricing truth grain: one document, one projection ────────────────────────
describe('C3 pricing truth grain (assembly vs facts.rate_table)', () => {
  // `facts.rate_table` and the assembled pricing rows are two projections of the
  // SAME extraction for a given document (design §5.4). Before C3, assembly was
  // scoped to the lone contract document, so a project whose rates live on
  // attached price sheets only ever ran the facts path. C3 widens assembly to
  // every eligible pricing source, activating both projections at once — measured
  // on the real Goodlettsville snapshot as legacy 10 → 20. Suppression is
  // document-scoped: covered documents use their assembled representation,
  // uncovered documents keep their facts.
  const FIVE_RATES = [
    { description: 'Loading and Hauling Vegetative Debris From Right of Way (ROW) to DMS', unit: 'Cubic Yard', rate: 27 },
    { description: 'Debris Mgmt. Site Management N/A', unit: 'Cubic Yard', rate: 5 },
    { description: 'Reduction of Vegetative Debris N/A', unit: 'Cubic Yard', rate: 9.24 },
    { description: 'Loading & Hauling to Final Disposal of Reduced Vegetative Debris', unit: 'Cubic Yard', rate: 1 },
    { description: 'Hazardous Limb (Hangers) Cutting (greater than 2" diameter) N/A', unit: 'Unit', rate: 135 },
  ];

  /** The `rate_table` fact projection of one document's five rates. */
  function rateTableFact(documentId: string): ValidatorFactRecord {
    return {
      id: `${documentId}:canonical_contract_intelligence:rate_table`,
      document_id: documentId,
      key: 'rate_table',
      value: FIVE_RATES.map((rate) => ({ ...rate, rate_amount: rate.rate, unit_type: rate.unit })),
      source: 'extraction',
      field_type: null,
      evidence: [],
    } as unknown as ValidatorFactRecord;
  }

  /** The assembled projection of the same five rates for one document. */
  function assembledRows(documentId: string) {
    return FIVE_RATES.map((rate, index) => ({
      id: `structural_table:pdf:table:p2:t3:r${index + 1}`,
      sourceDocumentId: documentId,
      category: 'Vegetative Collect, Remove & Haul',
      description: rate.description,
      route: null,
      distanceBand: null,
      unit: rate.unit,
      rate: rate.rate,
      page: 2,
      sourceAnchor: `pdf:table:p2:t3:r${index + 1}`,
      confidence: 'high',
      sourceKind: 'rate_schedule',
      sourceQuality: 'clean',
      authoredValueCorrection: false,
    })) as never[];
  }

  function itemsFor(params: {
    assembledDocumentIds: readonly string[];
    factDocumentIds: readonly string[];
  }) {
    const factsByDocumentId = new Map<string, ValidatorFactRecord[]>(
      params.factDocumentIds.map((id) => [id, [rateTableFact(id)]] as const),
    );
    return buildRateScheduleItems({
      factsByDocumentId,
      rateDocumentIds: [...new Set([...params.assembledDocumentIds, ...params.factDocumentIds])],
      contractValidationContext: {
        document_id: CONTRACT_ID,
        analysis: { rate_schedule_rows: [] },
      } as never,
      assembledContractPricingRows: params.assembledDocumentIds.flatMap(assembledRows),
    });
  }

  it('emits only the assembled representation when one document has both', () => {
    const items = itemsFor({ assembledDocumentIds: [SHEET_A], factDocumentIds: [SHEET_A] });

    assert.equal(items.length, 5, 'five rates, not ten');
    assert.ok(
      items.every((item) => item.record_id.startsWith('structural_table:')),
      'the assembled projection wins; the fact projection is suppressed',
    );
  });

  it('emits one set per document, not two sets per document', () => {
    const items = itemsFor({
      assembledDocumentIds: [SHEET_A, SHEET_B],
      factDocumentIds: [SHEET_A, SHEET_B],
    });

    assert.equal(items.length, 10, 'Goodlettsville baseline: 10, not 20');
    assert.equal(items.filter((item) => item.source_document_id === SHEET_A).length, 5);
    assert.equal(items.filter((item) => item.source_document_id === SHEET_B).length, 5);
  });

  it('retains a document represented only through facts', () => {
    const items = itemsFor({ assembledDocumentIds: [], factDocumentIds: [SHEET_A] });

    assert.equal(items.length, 5);
    assert.ok(items.every((item) => item.source_document_id === SHEET_A));
  });

  it('preserves facts from documents assembly did not cover (mixed sources)', () => {
    const items = itemsFor({ assembledDocumentIds: [SHEET_A], factDocumentIds: [SHEET_A, SHEET_B] });

    assert.equal(items.length, 10, 'A from assembly, B from facts — one set each');
    const fromA = items.filter((item) => item.source_document_id === SHEET_A);
    const fromB = items.filter((item) => item.source_document_id === SHEET_B);
    assert.ok(
      fromA.every((item) => item.record_id.startsWith('structural_table:')),
      'covered document uses assembly',
    );
    assert.ok(
      fromB.every((item) => item.record_id.includes('rate_table')),
      'uncovered document keeps its facts — assembly for A must not suppress B',
    );
  });

  it('does not globally disable the facts path just because some rows were assembled', () => {
    const items = itemsFor({ assembledDocumentIds: [SHEET_A], factDocumentIds: [SHEET_B] });

    assert.equal(items.length, 10);
    assert.equal(items.filter((item) => item.source_document_id === SHEET_B).length, 5);
  });

  it('keeps identical record ids from different documents distinct', () => {
    const items = itemsFor({
      assembledDocumentIds: [SHEET_A, SHEET_B],
      factDocumentIds: [SHEET_A, SHEET_B],
    });
    const firstRows = items.filter(
      (item) => item.record_id === 'structural_table:pdf:table:p2:t3:r1',
    );

    assert.equal(firstRows.length, 2, 'same physical row id, two documents, both retained');
    assert.deepEqual(
      firstRows.map((item) => item.source_document_id).sort(),
      [SHEET_A, SHEET_B].sort(),
    );
  });

  it('keeps assembled rows on their own source document, never the contract', () => {
    const items = itemsFor({
      assembledDocumentIds: [SHEET_A, SHEET_B],
      factDocumentIds: [SHEET_A, SHEET_B],
    });

    assert.equal(items.filter((item) => item.source_document_id === CONTRACT_ID).length, 0);
  });

  it('leaves a facts-only project unchanged from its pre-C3 behavior', () => {
    const preC3 = itemsFor({ assembledDocumentIds: [], factDocumentIds: [SHEET_A, SHEET_B] });

    assert.equal(preC3.length, 10);
    assert.ok(preC3.every((item) => item.record_id.includes('rate_table')));
  });

  it('suppresses by document identity alone, never by row content', () => {
    // SHEET_B's fact rows are byte-identical in content to SHEET_A's assembled
    // rows. Content similarity must not suppress them; only document identity may.
    const items = itemsFor({ assembledDocumentIds: [SHEET_A], factDocumentIds: [SHEET_B] });

    assert.equal(items.filter((item) => item.source_document_id === SHEET_B).length, 5);
  });

  it('is deterministic in count and ordering across repeated builds', () => {
    const first = itemsFor({
      assembledDocumentIds: [SHEET_A, SHEET_B],
      factDocumentIds: [SHEET_A, SHEET_B],
    });
    const second = itemsFor({
      assembledDocumentIds: [SHEET_A, SHEET_B],
      factDocumentIds: [SHEET_A, SHEET_B],
    });

    assert.deepEqual(
      first.map((item) => [item.source_document_id, item.record_id]),
      second.map((item) => [item.source_document_id, item.record_id]),
    );
  });
});
