/**
 * Repository-owned comparison fixtures.
 *
 * Deliberately under `__fixtures__` so the architecture boundary test rejects any
 * production import of this file: fixtures exist to exercise the comparator, never
 * to feed it in production. Every profile below is constructed from checked-in
 * data — the Golden pricing rows come from
 * `lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json`, real
 * Golden-derived contract pricing pinned to the Williamson corpus PDF — so the
 * acceptance gate reproduces on any checkout with no external corpus and no
 * production project ids.
 *
 * The five profiles mirror the required initial cohort: Golden, a cross-document
 * project, a clean project, a project with missing or conflicting source truth, and
 * a project with ticket-grain complexity.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import { resolveProjectTruthAuthority } from '@/lib/canonical/authority/resolveProjectTruthAuthority';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import { deriveBillingKeysForTransactionRecord } from '@/lib/validator/billingKeys';
import type { ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';
import type {
  InvoiceLineRow,
  InvoiceRow,
  RateScheduleItem,
  ValidatorFactLookups,
  ValidatorSourceArtifactSnapshotEntry,
  ValidatorTransactionDataRow,
} from '@/lib/validator/shared';

const TIMESTAMP = '1970-01-01T00:00:00.000Z';

export const CONTRACT_DOCUMENT_ID = 'fixture-contract';
export const RATE_EXHIBIT_DOCUMENT_ID = 'fixture-rate-exhibit';
export const INVOICE_DOCUMENT_ID = 'fixture-invoice';
export const TICKET_DOCUMENT_ID = 'fixture-tickets';

const GOLDEN_FIXTURE_PATH = join(
  process.cwd(),
  'lib/evaluation/fixtures/goldenAuthoredTransportPricingRows.json',
);

type GoldenFixture = {
  readonly schemaVersion: string;
  readonly sourcePdfSha256: string;
  readonly rows: readonly ContractPricingAssemblyRow[];
};

export function loadGoldenPricingFixture(): GoldenFixture {
  return JSON.parse(readFileSync(GOLDEN_FIXTURE_PATH, 'utf8')) as GoldenFixture;
}

// ---------------------------------------------------------------------------
// Row builders
// ---------------------------------------------------------------------------

export function rateItem(params: {
  readonly documentId?: string;
  readonly recordId: string;
  readonly rateCode: string | null;
  readonly description: string;
  readonly unit: string;
  readonly rate: number | null;
  readonly category?: string | null;
  readonly page?: number;
}): RateScheduleItem {
  return {
    source_document_id: params.documentId ?? CONTRACT_DOCUMENT_ID,
    record_id: params.recordId,
    rate_code: params.rateCode,
    unit_type: params.unit,
    rate_amount: params.rate,
    material_type: params.category ?? null,
    // Real legacy rate items carry BOTH the raw source category and the resolved
    // taxonomy slug. The fixture mirrors that so alignment is exercised against the
    // shape production actually produces.
    source_category: params.category ?? null,
    description: params.description,
    canonical_category: params.category ?? null,
    raw_value: {
      rate_code: params.rateCode,
      rate_amount: params.rate,
      description: params.description,
      source_page: params.page ?? 8,
    },
  };
}

/**
 * A contract pricing assembly row in the shape canonical adaptation expects.
 *
 * Modeled on the Golden fixture rows so canonical resolution treats these
 * identically to real assembled pricing.
 */
export function pricingAssemblyRow(params: {
  readonly rowId: string;
  readonly description: string;
  readonly unit: string;
  readonly rate: number;
  readonly category: string;
  readonly page?: number;
}): ContractPricingAssemblyRow {
  const golden = loadGoldenPricingFixture().rows[0];
  return {
    ...(golden as unknown as Record<string, unknown>),
    row_id: params.rowId,
    description: params.description,
    unit: params.unit,
    unit_type: params.unit,
    rate_amount: params.rate,
    rate: params.rate,
    category: params.category,
    source_category: params.category,
    page: params.page ?? 8,
    source_page: params.page ?? 8,
  } as unknown as ContractPricingAssemblyRow;
}

export function invoiceRow(overrides: Record<string, unknown> = {}): InvoiceRow {
  return {
    id: 'invoice-row-1',
    source_document_id: INVOICE_DOCUMENT_ID,
    invoice_number: 'INV-1001',
    invoice_date: '2026-05-01',
    vendor_name: 'Fixture Hauling',
    billed_amount: 5000,
    total_amount: 5000,
    ...overrides,
  };
}

export function invoiceLineRow(overrides: Record<string, unknown> = {}): InvoiceLineRow {
  return {
    id: 'invoice-line-1',
    invoice_id: 'invoice-row-1',
    source_document_id: INVOICE_DOCUMENT_ID,
    invoice_number: 'INV-1001',
    description: 'HAUL 0-15 MILES',
    rate_code: 'HAUL-0-15',
    unit_type: 'cubic yard',
    quantity: 400,
    unit_price: 12.5,
    line_total: 5000,
    source_page: 2,
    source_row_number: 11,
    ...overrides,
  };
}

export function transactionRow(params: {
  readonly id: string;
  readonly transactionNumber: string | null;
  readonly invoiceNumber?: string | null;
  readonly rateCode?: string | null;
  readonly quantity: number | null;
  readonly cost: number | null;
  readonly sourceRowNumber?: number;
}): ValidatorTransactionDataRow {
  const keys = deriveBillingKeysForTransactionRecord({
    invoice_number: params.invoiceNumber ?? 'INV-1001',
    rate_code: params.rateCode ?? 'HAUL-0-15',
    rate_description: 'HAUL 0-15 MILES',
    service_item: 'Haul',
    material: 'Vegetative',
    site_type: null,
  });
  return {
    id: params.id,
    document_id: TICKET_DOCUMENT_ID,
    project_id: 'fixture-project',
    invoice_number: params.invoiceNumber ?? 'INV-1001',
    transaction_number: params.transactionNumber,
    rate_code: params.rateCode ?? 'HAUL-0-15',
    billing_rate_key: keys.billing_rate_key,
    site_material_key: keys.site_material_key,
    transaction_quantity: params.quantity,
    extended_cost: params.cost,
    invoice_date: '2026-04-15',
    source_sheet_name: 'Tickets',
    source_row_number: params.sourceRowNumber ?? 4,
    record_json: {},
    raw_row_json: {},
    created_at: TIMESTAMP,
  };
}

function factLookups(rateScheduleItems: readonly RateScheduleItem[]): ValidatorFactLookups {
  return {
    contractProjectCodeFacts: [],
    invoiceProjectCodeFacts: [],
    contractPartyNameFacts: [],
    contractIdentityDocumentIds: [CONTRACT_DOCUMENT_ID],
    pricingContextDocumentIds: [CONTRACT_DOCUMENT_ID],
    complianceContextDocumentIds: [],
    amendmentContextDocumentIds: [],
    nteFact: null,
    contractDocumentId: CONTRACT_DOCUMENT_ID,
    contractCeilingTypeFact: null,
    contractCeilingType: 'rate_based',
    rateSchedulePresentFact: null,
    rateSchedulePresent: rateScheduleItems.length > 0,
    rateRowCountFact: null,
    rateRowCount: rateScheduleItems.length,
    rateSchedulePagesFact: null,
    rateSchedulePagesDisplay: 'pages 8-11',
    rateUnitsDetectedFact: null,
    rateUnitsDetected: ['cubic yard'],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [],
    rateScheduleItems: [...rateScheduleItems],
    hasRateScheduleFacts: rateScheduleItems.length > 0,
  };
}

function artifactSnapshot(
  documentIds: readonly string[],
): readonly ValidatorSourceArtifactSnapshotEntry[] {
  return documentIds.map((documentId) => ({
    documentId,
    documentType: documentId === INVOICE_DOCUMENT_ID ? 'invoice' : 'contract',
    documentRole: null,
    storagePath: `fixtures/${documentId}.pdf`,
    sourceArtifactId: `artifact-${documentId}`,
    sourceSha256: `sha-${documentId}`,
    storageObjectVersion: 'v1',
    mediaTypeSniffed: 'application/pdf',
    byteLength: 1024,
    artifactCreatedAt: TIMESTAMP,
    exactSourceIdentity: `sha-${documentId}:v1`,
  }));
}

// ---------------------------------------------------------------------------
// Snapshot builder
// ---------------------------------------------------------------------------

export type ComparisonFixtureOptions = {
  readonly projectId: string;
  /** Legacy pricing truth. What the legacy authority governs with. */
  readonly legacyRateScheduleItems: readonly RateScheduleItem[];
  /** Canonical pricing source. Empty means canonical cannot establish pricing. */
  readonly assembledContractPricingRows: readonly ContractPricingAssemblyRow[];
  readonly invoices?: readonly InvoiceRow[];
  readonly invoiceLines?: readonly InvoiceLineRow[];
  readonly transactionRows?: readonly ValidatorTransactionDataRow[];
  readonly governingDocumentIds?: Readonly<Record<string, readonly string[]>>;
  readonly documentRelationships?: readonly {
    readonly source_document_id: string;
    readonly target_document_id: string;
    readonly relationship_type: string;
  }[];
  /** Governing contract document for canonical pricing context. */
  readonly contractDocumentId?: string;
};

/**
 * Builds a frozen source snapshot for one fixture profile.
 *
 * The snapshot carries BOTH authorities' source material simultaneously —
 * `legacyRateScheduleItems` and `assembledContractPricingRows` — which is exactly
 * the production situation: one loaded input from which either authority can be
 * projected. That is why a single snapshot can drive both runs.
 */
export function buildComparisonSourceSnapshot(
  options: ComparisonFixtureOptions,
): ValidatorSourceSnapshot {
  const contractDocumentId = options.contractDocumentId ?? CONTRACT_DOCUMENT_ID;
  const invoices = options.invoices ?? [invoiceRow()];
  const invoiceLines = options.invoiceLines ?? [invoiceLineRow()];
  const transactionRows = options.transactionRows ?? [
    transactionRow({ id: 'txn-1', transactionNumber: 'TKT-1', quantity: 400, cost: 5000 }),
  ];
  const documentIds = [
    contractDocumentId,
    RATE_EXHIBIT_DOCUMENT_ID,
    INVOICE_DOCUMENT_ID,
    TICKET_DOCUMENT_ID,
  ];

  return {
    project: {
      id: options.projectId,
      organization_id: 'fixture-org',
      name: `Fixture ${options.projectId}`,
      code: options.projectId,
      validation_status: 'PENDING',
      validation_summary_json: null,
      validation_phase: 'billing_review',
    } as ValidatorSourceSnapshot['project'],
    validationPhase: 'billing_review',
    documents: documentIds.map((documentId) => ({
      id: documentId,
      project_id: options.projectId,
      organization_id: 'fixture-org',
      title: documentId,
      name: documentId,
      document_type: documentId === INVOICE_DOCUMENT_ID ? 'invoice' : 'contract',
      document_role: null,
      storage_path: `fixtures/${documentId}.pdf`,
      created_at: TIMESTAMP,
      processing_status: 'complete',
      operational_status: 'active',
      processed_at: TIMESTAMP,
      intelligence_trace: null,
    })) as ValidatorSourceSnapshot['documents'],
    ruleStateByRuleId: new Map(),
    mobileTickets: [],
    loadTickets: [],
    transactionData: {
      datasets: [{
        id: 'dataset-1',
        document_id: TICKET_DOCUMENT_ID,
        project_id: options.projectId,
        row_count: transactionRows.length,
        total_extended_cost: transactionRows.reduce(
          (total, row) => total + (row.extended_cost ?? 0),
          0,
        ),
        total_transaction_quantity: transactionRows.reduce(
          (total, row) => total + (row.transaction_quantity ?? 0),
          0,
        ),
        // Ticket-grain dataset rollups are left at zero: the comparator derives
        // ticket-grain totals from the rows themselves, so a fixture that pre-filled
        // these would be asserting the answer instead of exercising the collapse.
        total_cyd_ticket_grain: 0,
        total_cyd_ticket_grain_full: 0,
        total_mileage_ticket_grain: 0,
        total_mileage_ticket_grain_full: 0,
        total_diameter: 0,
        total_diameter_full: 0,
        total_net_tonnage: 0,
        total_net_tonnage_full: 0,
        date_range_start: '2026-04-01',
        date_range_end: '2026-04-30',
        summary_json: {},
        created_at: TIMESTAMP,
      }],
      rows: transactionRows.map((row) => ({
        ...row,
        description_match_key: row.description_match_key ?? null,
        invoice_rate_key: row.invoice_rate_key ?? null,
      })),
    } as ValidatorSourceSnapshot['transactionData'],
    sourceArtifactSnapshot: artifactSnapshot(documentIds),
    sourceIdentityStoreState: 'read',
    sourceIdentityReadError: null,
    contractPricingDuplicateAuthority: [],
    pricingScheduleGovernance: null,
    precedenceFamilies: [],
    documentRelationships: [...(options.documentRelationships ?? [])] as
      ValidatorSourceSnapshot['documentRelationships'],
    familyDocumentIds: {
      contract: [contractDocumentId],
      rate_sheet: [RATE_EXHIBIT_DOCUMENT_ID],
      permit: [],
      invoice: [INVOICE_DOCUMENT_ID],
      ticket_support: [TICKET_DOCUMENT_ID],
    },
    governingDocumentIds: {
      contract: options.governingDocumentIds?.contract
        ? [...options.governingDocumentIds.contract]
        : [contractDocumentId],
      rate_sheet: options.governingDocumentIds?.rate_sheet
        ? [...options.governingDocumentIds.rate_sheet]
        : [],
      permit: [],
      invoice: [INVOICE_DOCUMENT_ID],
      ticket_support: [TICKET_DOCUMENT_ID],
    },
    truthCategoryDocumentIds: {
      contract_identity: [contractDocumentId],
      pricing: [contractDocumentId],
      compliance: [],
      amendments: [],
    },
    factsByDocumentId: new Map(),
    allFacts: [],
    invoices: [...invoices],
    invoiceLines: [...invoiceLines],
    assembledContractPricingRows: [...options.assembledContractPricingRows],
    contractValidationContext: {
      document_id: contractDocumentId,
      analysis: {} as never,
      evidence_by_id: new Map(),
    },
    baseFactLookups: factLookups(options.legacyRateScheduleItems),
    contractUploadGuidanceRateScheduleIncluded: 'yes',
    invoiceLineRateLinkRows: [],
    sourceArtifactSnapshotDigest: 'fixture-source-snapshot-digest',
  };
}

// ---------------------------------------------------------------------------
// The five cohort profiles
// ---------------------------------------------------------------------------

const HAUL_LEGACY_ITEM = rateItem({
  recordId: 'legacy:HAUL-0-15',
  rateCode: 'HAUL-0-15',
  description: 'HAUL 0-15 MILES',
  unit: 'cubic yard',
  rate: 12.5,
  category: 'transport',
});

/**
 * Profile 1 — Golden. Real in-repo Golden contract pricing under canonical, with
 * legacy pricing derived from the same source rows so the profile exercises the
 * full chain rather than an artificial divergence.
 */
export function goldenProfile(): ValidatorSourceSnapshot {
  const fixture = loadGoldenPricingFixture();
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-golden',
    legacyRateScheduleItems: [HAUL_LEGACY_ITEM],
    assembledContractPricingRows: fixture.rows,
  });
}

/**
 * Profile 2 — cross-document. Legacy prices from a non-governing document while
 * canonical resolves the governing rate exhibit, the strongest cross-document
 * equivalent available from repository data.
 */
export function crossDocumentProfile(): ValidatorSourceSnapshot {
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-cross-document',
    legacyRateScheduleItems: [
      rateItem({
        documentId: INVOICE_DOCUMENT_ID,
        recordId: 'legacy:non-governing',
        rateCode: 'HAUL-0-15',
        description: 'HAUL 0-15 MILES',
        unit: 'cubic yard',
        rate: 19.75,
        category: 'transport',
      }),
    ],
    assembledContractPricingRows: [
      pricingAssemblyRow({
        rowId: 'exhibit:HAUL-0-15',
        description: 'HAUL 0-15 MILES',
        unit: 'cubic yard',
        rate: 12.5,
        category: 'transport',
      }),
    ],
    documentRelationships: [{
      source_document_id: RATE_EXHIBIT_DOCUMENT_ID,
      target_document_id: CONTRACT_DOCUMENT_ID,
      relationship_type: 'amends',
    }],
  });
}

/** Profile 3 — clean and simple. One invoice, one ticket, one matching rate. */
export function cleanProfile(): ValidatorSourceSnapshot {
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-clean',
    legacyRateScheduleItems: [HAUL_LEGACY_ITEM],
    assembledContractPricingRows: [
      pricingAssemblyRow({
        rowId: 'clean:HAUL-0-15',
        description: 'HAUL 0-15 MILES',
        unit: 'cubic yard',
        rate: 12.5,
        category: 'transport',
      }),
    ],
  });
}

/**
 * Profile 4 — missing or conflicting source truth. No assembled pricing rows, so
 * canonical cannot establish governing pricing and blocks, while legacy falls back
 * to its own rate items.
 */
export function sourceGapProfile(): ValidatorSourceSnapshot {
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-source-gap',
    legacyRateScheduleItems: [HAUL_LEGACY_ITEM],
    assembledContractPricingRows: [],
  });
}

const GRAIN_PRICING_ROW = () => pricingAssemblyRow({
  rowId: 'grain:HAUL-0-15',
  description: 'HAUL 0-15 MILES',
  unit: 'cubic yard',
  rate: 12.5,
  category: 'transport',
});

/**
 * Profile 5 — ticket-grain complexity, duplicate physical rows.
 *
 * One physical ticket appears on two rows carrying the SAME values. Legacy's
 * across-rows sum double-counts it; canonical collapses to one ticket identity.
 * Because the values agree there is no conflict, so canonical stays assembled and
 * the divergence is a clean correction candidate rather than a block.
 */
export function ticketGrainProfile(): ValidatorSourceSnapshot {
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-ticket-grain',
    legacyRateScheduleItems: [HAUL_LEGACY_ITEM],
    assembledContractPricingRows: [GRAIN_PRICING_ROW()],
    transactionRows: [
      transactionRow({
        id: 'txn-1',
        transactionNumber: 'TKT-1',
        quantity: 400,
        cost: 5000,
        sourceRowNumber: 4,
      }),
      // The same physical ticket, repeated verbatim on a second row.
      transactionRow({
        id: 'txn-2',
        transactionNumber: 'TKT-1',
        quantity: 400,
        cost: 5000,
        sourceRowNumber: 5,
      }),
    ],
  });
}

/**
 * Profile 5b — ticket-grain conflict.
 *
 * The same physical ticket appears twice with DISAGREEING quantity and cost.
 * Canonical preserves both observations and blocks the transaction domain rather
 * than choosing a winner; legacy carries on.
 */
export function ticketGrainConflictProfile(): ValidatorSourceSnapshot {
  return buildComparisonSourceSnapshot({
    projectId: 'fixture-ticket-grain-conflict',
    legacyRateScheduleItems: [HAUL_LEGACY_ITEM],
    assembledContractPricingRows: [GRAIN_PRICING_ROW()],
    transactionRows: [
      transactionRow({
        id: 'txn-1',
        transactionNumber: 'TKT-1',
        quantity: 400,
        cost: 5000,
        sourceRowNumber: 4,
      }),
      transactionRow({
        id: 'txn-2',
        transactionNumber: 'TKT-1',
        quantity: 250,
        cost: 3125,
        sourceRowNumber: 5,
      }),
    ],
  });
}

/**
 * Profile 6 — exact parity.
 *
 * Legacy pricing truth IS what canonical resolves from the same assembled rows.
 * That is the real production condition for parity: the persisted legacy rate rows
 * already agree with canonical resolution, so both authorities govern with an
 * identical pricing set.
 *
 * The legacy items are produced by running the canonical resolver over the same
 * pricing input rather than being hand-transcribed. Hand-copying rates into a
 * fixture would make the parity case assert the fixture author's arithmetic instead
 * of actual agreement between the two authorities.
 */
export function exactParityProfile(): ValidatorSourceSnapshot {
  const assembledContractPricingRows = [
    pricingAssemblyRow({
      rowId: 'parity:HAUL-0-15',
      description: 'HAUL 0-15 MILES',
      unit: 'cubic yard',
      rate: 12.5,
      category: 'transport',
    }),
  ];
  const canonicalContext = resolveProjectTruthAuthority({
    projectId: 'fixture-exact-parity',
    assembledContractPricingRows,
    pricingContext: { documentId: CONTRACT_DOCUMENT_ID, scheduleId: null, scheduleName: null },
    legacyRateScheduleItems: [],
    sourceArtifactSnapshotDigest: 'fixture-source-snapshot-digest',
    env: { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' },
  });

  return buildComparisonSourceSnapshot({
    projectId: 'fixture-exact-parity',
    legacyRateScheduleItems: canonicalContext.validatorProjection?.rateScheduleItems ?? [],
    assembledContractPricingRows,
  });
}

export const COHORT_PROFILES: readonly {
  readonly name: string;
  readonly build: () => ValidatorSourceSnapshot;
}[] = [
  { name: 'golden', build: goldenProfile },
  { name: 'cross_document', build: crossDocumentProfile },
  { name: 'clean', build: cleanProfile },
  { name: 'source_gap', build: sourceGapProfile },
  { name: 'ticket_grain', build: ticketGrainProfile },
  { name: 'ticket_grain_conflict', build: ticketGrainConflictProfile },
  { name: 'exact_parity', build: exactParityProfile },
];
