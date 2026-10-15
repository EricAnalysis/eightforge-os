/**
 * Deterministic conflict-class fixtures for the Case Investigation
 * qualification (contract v2).
 *
 * Production holds no finding for the three conflict rules: they fire only in
 * canonical truth-authority mode. These fixtures make the EXISTING rules fire
 * through their real path. Each fixture project is a set of persisted-shape
 * source rows (transaction rows, invoice rows, governing-document candidates)
 * resolved by `resolveProjectTruthAuthority` in canonical mode. The real rule
 * packs then turn the resulting conflicts into findings, and those findings
 * become the project's open finding and evidence rows. Nothing about a
 * conflict, its evidence, or the provider context is hand-written: the context
 * is later built by the live `readInvestigationContext` over these tables.
 *
 * The fixtures carry no customer content. Names are invented.
 */

import { resolveProjectTruthAuthority } from '@/lib/canonical/authority/resolveProjectTruthAuthority';
import { PROJECT_TRUTH_AUTHORITY_ENV_VAR } from '@/lib/canonical/authority/projectTruthAuthorityMode';
import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import {
  RULE_CANONICAL_INVOICE_IDENTITY_CONFLICT,
  RULE_CANONICAL_RELATIONSHIP_CONFLICTING,
  runCanonicalTruthIntegrityRules,
} from '@/lib/validator/rulePacks/canonicalTruthIntegrity';
import { RULE_TRANSACTION_GRAIN_CONFLICT, runTransactionGrainConflictRules } from '@/lib/validator/rulePacks/transactionGrainConflict';
import type { ProjectValidatorInput, ValidatorFindingResult } from '@/lib/validator/shared';

export const CONFLICT_FIXTURE_VERSION = 'case_investigation_conflict_fixtures_v1';
export const CONFLICT_RULES = [
  RULE_TRANSACTION_GRAIN_CONFLICT,
  RULE_CANONICAL_INVOICE_IDENTITY_CONFLICT,
  RULE_CANONICAL_RELATIONSHIP_CONFLICTING,
] as const;

export const FIXTURE_ORGANIZATION_ID = '0c1f0000-0000-4000-8000-000000000001';
const FIXTURE_CREATED_AT = '2026-10-15T00:00:00.000Z';

type FixtureDocument = Readonly<{ key: string; title: string; type: 'contract' | 'invoice' | 'transaction_data' }>;
type TransactionSource = Readonly<{
  document: string; ticket: string; invoice: string; rateCode: string; unit: string;
  quantity: number; cost: number; sheet: string; row: number;
}>;
type InvoiceSource = Readonly<{ document: string; number: string; date: string; vendor: string; amount: number }>;

export type ConflictFixtureProject = Readonly<{
  key: string;
  name: string;
  documents: readonly FixtureDocument[];
  transactions?: readonly TransactionSource[];
  invoices?: readonly InvoiceSource[];
  /** Governing contract candidates. More than one is a governing-relationship conflict. */
  contractCandidates: readonly string[];
}>;

const tx = (document: string, ticket: string, quantity: number, cost: number, row: number,
  extra: Partial<TransactionSource> = {}): TransactionSource =>
  ({ document, ticket, invoice: 'INV-100', rateCode: 'HAUL-1', unit: 'CYD', quantity, cost, sheet: 'Tickets', row, ...extra });

/** The fixture set. Edit only by versioning CONFLICT_FIXTURE_VERSION. */
export const CONFLICT_FIXTURE_PROJECTS: readonly ConflictFixtureProject[] = [
  {
    key: 'ridgeview', name: 'Conflict fixture: Ridgeview Haul',
    documents: [
      { key: 'contract', title: 'Ridgeview Debris Removal Agreement', type: 'contract' },
      { key: 'tickets', title: 'Ridgeview Load Tickets - March', type: 'transaction_data' },
    ],
    transactions: [
      tx('tickets', 'TKT-1001', 10, 125, 5), tx('tickets', 'TKT-1001', 14, 125, 41),
      tx('tickets', 'TKT-1002', 18, 450, 6), tx('tickets', 'TKT-1002', 18, 480, 42),
      tx('tickets', 'TKT-1003', 8, 100, 7), tx('tickets', 'TKT-1003', 8, 100, 43), tx('tickets', 'TKT-1003', 12, 100, 77),
      tx('tickets', 'TKT-1004', 16, 200, 8), tx('tickets', 'TKT-1004', 20, 250, 44),
      tx('tickets', 'TKT-1005', 12, 150, 9), tx('tickets', 'TKT-1005', 12, 150, 45),
    ],
    contractCandidates: ['contract'],
  },
  {
    key: 'cedar', name: 'Conflict fixture: Cedar Creek Debris',
    documents: [
      { key: 'contract', title: 'Cedar Creek Monitoring Contract', type: 'contract' },
      { key: 'tickets', title: 'Cedar Creek Tickets Week 1', type: 'transaction_data' },
    ],
    transactions: [
      // Same workbook: a re-keyed block repeats tickets with different values.
      tx('tickets', 'CC-2001', 22.5, 281.25, 12, { unit: 'TON', rateCode: 'VEG-2' }),
      tx('tickets', 'CC-2001', 25, 312.5, 112, { unit: 'TON', rateCode: 'VEG-2' }),
      tx('tickets', 'CC-2002', 45, 1125, 13, { rateCode: 'C&D-1' }),
      tx('tickets', 'CC-2002', 45, 1250, 113, { rateCode: 'C&D-1' }),
      tx('tickets', 'CC-2003', 30, 375, 14), tx('tickets', 'CC-2003', 3, 375, 114),
      tx('tickets', 'CC-2004', 40, 500, 15), tx('tickets', 'CC-2004', 40, 500, 115),
    ],
    contractCandidates: ['contract'],
  },
  {
    key: 'lakeside', name: 'Conflict fixture: Lakeside Storm Cleanup',
    documents: [
      { key: 'contract', title: 'Lakeside Emergency Services Contract', type: 'contract' },
      { key: 'tickets', title: 'Lakeside Haul Log', type: 'transaction_data' },
    ],
    transactions: [
      tx('tickets', 'LK-3001', 6, 72, 20, { sheet: 'Day 1' }), tx('tickets', 'LK-3001', 9, 72, 3, { sheet: 'Day 2' }),
    ],
    contractCandidates: ['contract'],
  },
  {
    key: 'harbor', name: 'Conflict fixture: Harbor Point Invoices',
    documents: [
      { key: 'contract', title: 'Harbor Point Services Agreement', type: 'contract' },
      { key: 'inv-a', title: 'Invoice 3001', type: 'invoice' },
      { key: 'inv-a-copy', title: 'Invoice 3001 (copy)', type: 'invoice' },
      { key: 'inv-b', title: 'Invoice 3002', type: 'invoice' },
      { key: 'inv-b-revised', title: 'Invoice 3002 Revised', type: 'invoice' },
      { key: 'inv-c1', title: 'Invoice 3003 Part 1', type: 'invoice' },
      { key: 'inv-c2', title: 'Invoice 3003 Part 2', type: 'invoice' },
      { key: 'inv-c3', title: 'Invoice 3003 Part 3', type: 'invoice' },
    ],
    invoices: [
      { document: 'inv-a', number: 'INV-3001', date: '2026-04-01', vendor: 'Harbor Hauling LLC', amount: 12500 },
      { document: 'inv-a-copy', number: 'INV-3001', date: '2026-04-01', vendor: 'Harbor Hauling LLC', amount: 12500 },
      { document: 'inv-b', number: 'INV-3002', date: '2026-04-15', vendor: 'Harbor Hauling LLC', amount: 8400 },
      { document: 'inv-b-revised', number: 'INV-3002', date: '2026-04-20', vendor: 'Harbor Hauling LLC', amount: 7900 },
      { document: 'inv-c1', number: 'INV-3003', date: '2026-05-01', vendor: 'Harbor Hauling LLC', amount: 3000 },
      { document: 'inv-c2', number: 'INV-3003', date: '2026-05-01', vendor: 'Harbor Hauling LLC', amount: 4100 },
      { document: 'inv-c3', number: 'INV-3003', date: '2026-05-01', vendor: 'Harbor Hauling LLC', amount: 2600 },
    ],
    contractCandidates: ['contract'],
  },
  {
    key: 'millbrook', name: 'Conflict fixture: Millbrook Invoices',
    documents: [
      { key: 'contract', title: 'Millbrook Disaster Recovery Contract', type: 'contract' },
      { key: 'inv-1', title: 'Millbrook Invoice 4410', type: 'invoice' },
      { key: 'inv-1-dup', title: 'Millbrook Invoice 4410 (emailed)', type: 'invoice' },
      { key: 'inv-2', title: 'Millbrook Invoice 4411', type: 'invoice' },
      { key: 'inv-2-other', title: 'Subcontractor Invoice 4411', type: 'invoice' },
      { key: 'inv-3', title: 'Millbrook Invoice 4412 June', type: 'invoice' },
      { key: 'inv-3-july', title: 'Millbrook Invoice 4412 July', type: 'invoice' },
    ],
    invoices: [
      { document: 'inv-1', number: '4410', date: '2026-06-01', vendor: 'Millbrook Recovery Inc', amount: 22000 },
      { document: 'inv-1-dup', number: '4410', date: '2026-06-03', vendor: 'Millbrook Recovery Inc', amount: 22000 },
      { document: 'inv-2', number: '4411', date: '2026-06-10', vendor: 'Millbrook Recovery Inc', amount: 5600 },
      { document: 'inv-2-other', number: '4411', date: '2026-06-11', vendor: 'Stone Ridge Trucking', amount: 5600 },
      { document: 'inv-3', number: '4412', date: '2026-06-30', vendor: 'Millbrook Recovery Inc', amount: 9800 },
      { document: 'inv-3-july', number: '4412', date: '2026-07-31', vendor: 'Millbrook Recovery Inc', amount: 11200 },
    ],
    contractCandidates: ['contract'],
  },
  {
    key: 'pinecrest', name: 'Conflict fixture: Pinecrest Contracts',
    documents: [
      { key: 'contract-2025', title: 'Pinecrest Debris Contract 2025', type: 'contract' },
      { key: 'contract-2026', title: 'Pinecrest Debris Contract 2026', type: 'contract' },
      { key: 'invoice', title: 'Pinecrest Invoice 501', type: 'invoice' },
    ],
    invoices: [{ document: 'invoice', number: 'PC-501', date: '2026-03-10', vendor: 'Pinecrest Services', amount: 4300 }],
    contractCandidates: ['contract-2025', 'contract-2026'],
  },
  {
    key: 'willow', name: 'Conflict fixture: Willow Bend Contracts',
    documents: [
      { key: 'signed', title: 'Willow Bend Agreement (signed)', type: 'contract' },
      { key: 'draft', title: 'Willow Bend Agreement (draft)', type: 'contract' },
      { key: 'invoice', title: 'Willow Bend Invoice 77', type: 'invoice' },
    ],
    invoices: [{ document: 'invoice', number: 'WB-77', date: '2026-02-20', vendor: 'Willow Bend Contracting', amount: 6100 }],
    contractCandidates: ['signed', 'draft'],
  },
  {
    key: 'granite', name: 'Conflict fixture: Granite Falls Contracts',
    documents: [
      { key: 'county', title: 'Granite Falls County Contract', type: 'contract' },
      { key: 'city', title: 'Granite Falls City Contract', type: 'contract' },
      { key: 'piggyback', title: 'Granite Falls Piggyback Agreement', type: 'contract' },
      { key: 'invoice', title: 'Granite Falls Invoice 12', type: 'invoice' },
    ],
    invoices: [{ document: 'invoice', number: 'GF-12', date: '2026-05-05', vendor: 'Granite Haulers', amount: 15300 }],
    contractCandidates: ['county', 'city', 'piggyback'],
  },
  {
    key: 'oakmont', name: 'Conflict fixture: Oakmont Rebid',
    documents: [
      { key: 'original', title: 'Oakmont Original Award', type: 'contract' },
      { key: 'rebid', title: 'Oakmont Rebid Award', type: 'contract' },
      { key: 'tickets', title: 'Oakmont Ticket Export', type: 'transaction_data' },
    ],
    transactions: [tx('tickets', 'OK-5001', 11, 132, 4), tx('tickets', 'OK-5001', 11, 143, 9)],
    contractCandidates: ['original', 'rebid'],
  },
  {
    key: 'riverside', name: 'Conflict fixture: Riverside Amendment',
    documents: [
      { key: 'base', title: 'Riverside Base Contract', type: 'contract' },
      { key: 'restated', title: 'Riverside Restated Contract', type: 'contract' },
      { key: 'inv-1', title: 'Riverside Invoice 9', type: 'invoice' },
      { key: 'inv-2', title: 'Riverside Invoice 9 (portal copy)', type: 'invoice' },
    ],
    invoices: [
      { document: 'inv-1', number: 'RS-9', date: '2026-08-01', vendor: 'Riverside Environmental', amount: 18750 },
      { document: 'inv-2', number: 'RS-9', date: '2026-08-01', vendor: 'Riverside Environmental', amount: 18570 },
    ],
    contractCandidates: ['base', 'restated'],
  },
  {
    key: 'summit', name: 'Conflict fixture: Summit Ridge',
    documents: [
      { key: 'prime', title: 'Summit Ridge Prime Contract', type: 'contract' },
      { key: 'sub', title: 'Summit Ridge Subcontract', type: 'contract' },
      { key: 'invoice', title: 'Summit Ridge Invoice 3', type: 'invoice' },
    ],
    invoices: [{ document: 'invoice', number: 'SR-3', date: '2026-09-02', vendor: 'Summit Ridge Removal', amount: 2900 }],
    contractCandidates: ['prime', 'sub'],
  },
];

/** Deterministic UUID-shaped id from a fixture key (not random: re-runs are identical). */
export function fixtureUuid(key: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let index = 0; index < key.length; index += 1) {
    h1 = Math.imul(h1 ^ key.charCodeAt(index), 16777619) >>> 0;
    h2 = Math.imul(h2 ^ key.charCodeAt(index), 2246822519) >>> 0;
  }
  const hex = (h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')).repeat(2);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const PRICING_ROW = {
  id: 'pricing-row-1', category: 'transport', description: 'HAUL CLASS 4', route: null, distanceBand: null,
  unit: 'CYD', rate: 12.5, page: 3, sourceAnchor: 'anchor-1', confidence: 'high', authoredValueCorrection: false,
} as unknown as ContractPricingAssemblyRow;

export type ConflictFixtureTables = Readonly<{
  projectId: string;
  tables: Record<string, Record<string, unknown>[]>;
  findings: readonly ValidatorFindingResult[];
}>;

/** Runs one fixture project through the real canonical resolution and rule packs. */
export function buildConflictFixtureProject(project: ConflictFixtureProject): ConflictFixtureTables {
  const projectId = fixtureUuid(`${CONFLICT_FIXTURE_VERSION}:project:${project.key}`);
  const documentId = (key: string) => fixtureUuid(`${CONFLICT_FIXTURE_VERSION}:document:${project.key}:${key}`);
  const contractIds = project.contractCandidates.map(documentId);

  const transactionRows: PersistedCanonicalTransactionRowInput[] = (project.transactions ?? []).map((row, index) => ({
    id: fixtureUuid(`${CONFLICT_FIXTURE_VERSION}:transaction:${project.key}:${index}`),
    document_id: documentId(row.document),
    invoice_number: row.invoice,
    transaction_number: row.ticket,
    rate_code: row.rateCode,
    transaction_quantity: row.quantity,
    extended_cost: row.cost,
    invoice_date: '2026-03-01',
    source_sheet_name: row.sheet,
    source_row_number: row.row,
    record_json: { unit: row.unit },
    raw_row_json: {},
  }));
  const invoiceRows = (project.invoices ?? []).map((row, index) => ({
    id: fixtureUuid(`${CONFLICT_FIXTURE_VERSION}:invoice:${project.key}:${index}`),
    source_document_id: documentId(row.document),
    invoice_number: row.number,
    invoice_date: row.date,
    vendor_name: row.vendor,
    billed_amount: row.amount,
  }));

  const context = resolveProjectTruthAuthority({
    projectId,
    assembledContractPricingRows: [{ ...PRICING_ROW, sourceDocumentId: contractIds[0] } as ContractPricingAssemblyRow],
    pricingContext: { documentId: contractIds[0] ?? null, scheduleId: 'exhibit-a', scheduleName: 'Exhibit A' },
    legacyRateScheduleItems: [],
    transactionRows,
    invoiceRows: invoiceRows as never,
    governingDocumentIds: { contract: contractIds },
    familyDocumentIds: { contract: contractIds },
    sourceArtifactSnapshotDigest: `${CONFLICT_FIXTURE_VERSION}:${project.key}`,
    env: { [PROJECT_TRUTH_AUTHORITY_ENV_VAR]: 'canonical' },
  } as Parameters<typeof resolveProjectTruthAuthority>[0]);
  const input = { project: { id: projectId }, projectTruthAuthority: context } as unknown as ProjectValidatorInput;
  const findings = [...runTransactionGrainConflictRules(input), ...runCanonicalTruthIntegrityRules(input)];

  const documents = project.documents.map((document) => ({
    id: documentId(document.key),
    organization_id: FIXTURE_ORGANIZATION_ID,
    project_id: projectId,
    title: document.title,
    name: `${document.title}.${document.type === 'transaction_data' ? 'xlsx' : 'pdf'}`,
    document_type: document.type,
    document_role: null,
    document_subtype: null,
    authority_status: null,
    effective_date: null,
    precedence_rank: null,
    operator_override_precedence: false,
    created_at: FIXTURE_CREATED_AT,
  }));
  const findingRows = findings.map(({ evidence: _evidence, ...finding }) => ({
    ...finding, status: 'open', created_at: FIXTURE_CREATED_AT, updated_at: FIXTURE_CREATED_AT,
  }));
  const evidenceRows = findings.flatMap((finding) => finding.evidence.map((entry) => ({
    ...entry, finding_id: finding.id, created_at: FIXTURE_CREATED_AT,
  })));

  return {
    projectId,
    findings,
    tables: {
      projects: [{ id: projectId, organization_id: FIXTURE_ORGANIZATION_ID, name: project.name }],
      documents,
      project_validation_findings: findingRows as Record<string, unknown>[],
      project_validation_evidence: evidenceRows as Record<string, unknown>[],
      execution_items: [],
      decisions: [],
      document_extractions: [],
      document_relationships: [],
    },
  };
}
