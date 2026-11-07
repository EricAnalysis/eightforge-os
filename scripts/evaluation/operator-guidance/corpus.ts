import { type ValidatorSourceSnapshot } from '@/lib/validator/projectValidator';
import {
  buildComparisonSourceSnapshot,
  invoiceLineRow,
  invoiceRow,
  rateItem,
  ticketGrainConflictProfile,
  ticketGrainProfile,
  transactionRow,
} from '@/lib/canonical/comparison/__fixtures__/authorityComparisonFixtures';
import type { ContractPricingAssemblyRow } from '@/lib/contracts/contractPricingAssembly';
import type { OperatorIntent } from '@/lib/projectIntelligence/contextPlan';

/**
 * The pre-registered operator guidance cases. All synthetic: no customer data, so nothing
 * here is a new data exposure. Some project fixtures are the repository's existing
 * Validator cohort profiles; the others are plain document and fact rows run through the
 * real Validator. Findings are never written by hand.
 *
 * `HELDOUT_CASES` are what v3 qualifies on, and they are wholly synthetic: their cohort
 * snapshots are built here and carry nothing derived from a real corpus, which preflight
 * checks. `V2_REGRESSION_CASES` are v1 and v2's 24, kept because v3's corrections were
 * derived from their answers: they can only show regression, so they are never called in a
 * run and never count towards a result. Their cohort profiles spread a Golden-derived row.
 *
 * This module holds what a case IS. What a correct answer looks like lives in
 * labels.ts, which nothing that builds a request may import.
 */

export const QUALIFICATION_AT = '2026-01-01T00:00:00.000Z';
/** When validation last ran. A document read after this has not been validated yet. */
export const VALIDATION_RUN_AT = '2026-01-02T00:00:00.000Z';
export const READ_AFTER_VALIDATION_AT = '2026-01-03T00:00:00.000Z';

export type DocumentSpec = Readonly<{
  key: string;
  title: string;
  documentType: string;
  authorityStatus?: string;
  processingStatus?: string;
  /** Null means it has not been read. Defaults to before the validation run. */
  processedAt?: string | null;
}>;

export type FactSpec = Readonly<{ documentKey: string; fieldKey: string; value: string | number | boolean }>;
export type RelationshipSpec = Readonly<{ key: string; sourceKey: string; targetKey: string; type: string }>;

export type RowsState = Readonly<{
  kind: 'rows';
  phase: 'contract_setup' | 'billing_review';
  documents: readonly DocumentSpec[];
  facts: readonly FactSpec[];
  relationships: readonly RelationshipSpec[];
}>;

export type CohortState = Readonly<{
  kind: 'cohort';
  build: () => ValidatorSourceSnapshot;
  authorityMode: 'legacy' | 'canonical';
  titles: Readonly<Record<string, string>>;
  /** What each document is, where the cohort's own record does not say. */
  documentTypes?: Readonly<Record<string, string>>;
}>;

export const PROJECT_FIXTURES = Object.freeze({
  north_setup: 'Sample Project North',
  east_pricing: 'Sample Project East',
  south_billing: 'Sample Project South',
  west_cleared: 'Sample Project West',
  ticket_conflict: 'Sample Project Conflict',
  ticket_grain: 'Sample Project Tickets',
});
/** Held-out cases are other projects, with other documents. No v1 or v2 fixture is reused. */
export const HELDOUT_PROJECT_FIXTURES = Object.freeze({
  harbor_setup: 'Sample Project Harbor',
  harbor_pricing: 'Sample Project Inlet',
  harbor_billing: 'Sample Project Marina',
  harbor_cleared: 'Sample Project Pier',
  harbor_conflict: 'Sample Project Dock',
  harbor_tickets: 'Sample Project Wharf',
});
export type ProjectFixture = keyof typeof PROJECT_FIXTURES | keyof typeof HELDOUT_PROJECT_FIXTURES;

export type QualificationCase = Readonly<{
  caseId: string;
  fixture: ProjectFixture;
  intent: OperatorIntent;
  question: string;
  /** Asked from this finding, as the Validator's link does. Null is a project-level question. */
  focusRule: string | null;
  /** What the Validator saw. */
  validated: RowsState | CohortState;
  /** What the project holds now, when it changed after validation. Defaults to `validated`. */
  current?: RowsState;
}>;

const CONTRACT: DocumentSpec = { key: 'contract', title: 'Sample Debris Removal Contract', documentType: 'contract' };
const PRICE_SHEET: DocumentSpec = { key: 'sheet', title: 'Sample Unit Price Sheet', documentType: 'price sheet' };
const INVOICE: DocumentSpec = { key: 'invoice', title: 'Sample Invoice 7', documentType: 'invoice' };

const RATE_BASED: FactSpec = { documentKey: 'contract', fieldKey: 'contract_ceiling_type', value: 'rate_based' };
const SHEET_LINK: RelationshipSpec = { key: 'sheet-link', sourceKey: 'sheet', targetKey: 'contract', type: 'attached_to' };

function rows(phase: RowsState['phase'], documents: readonly DocumentSpec[], facts: readonly FactSpec[] = [], relationships: readonly RelationshipSpec[] = []): RowsState {
  return { kind: 'rows', phase, documents, facts, relationships };
}

// Rate-based contract, no schedule anywhere.
const NO_SCHEDULE = rows('contract_setup', [CONTRACT], [RATE_BASED]);
// The schedule is in the project but not tied to the contract.
const SCHEDULE_UNLINKED = rows('contract_setup', [CONTRACT, PRICE_SHEET], [RATE_BASED]);
// Linked and read, and validation is current, yet its rates never reached the facts.
const SCHEDULE_LINKED = rows('contract_setup', [CONTRACT, PRICE_SHEET], [RATE_BASED], [SHEET_LINK]);
// Linked, and read only after the latest validation.
const SCHEDULE_READ_AFTER_VALIDATION = rows('contract_setup',
  [CONTRACT, { ...PRICE_SHEET, processedAt: READ_AFTER_VALIDATION_AT }], [RATE_BASED], [SHEET_LINK]);
// In the project, but reading it failed.
const SCHEDULE_READ_FAILED = rows('contract_setup',
  [CONTRACT, { ...PRICE_SHEET, processingStatus: 'failed', processedAt: null }], [RATE_BASED]);
// Linked, but marked as reference only: whether it applies is a person's call.
const SCHEDULE_REFERENCE_ONLY = rows('contract_setup',
  [CONTRACT, { ...PRICE_SHEET, authorityStatus: 'reference_only' }], [RATE_BASED], [SHEET_LINK]);
// The contract says it holds a schedule, but no rows were read from it.
const SCHEDULE_IN_CONTRACT_UNREAD = rows('contract_setup', [CONTRACT],
  [RATE_BASED, { documentKey: 'contract', fieldKey: 'rate_schedule_present', value: true }]);
// Fully read schedule, but whether it applies to the billed work is unresolved.
const SCHEDULE_COMPLETE = rows('contract_setup', [CONTRACT], [
  RATE_BASED,
  { documentKey: 'contract', fieldKey: 'rate_schedule_present', value: true },
  { documentKey: 'contract', fieldKey: 'rate_row_count', value: 5 },
  { documentKey: 'contract', fieldKey: 'rate_schedule_pages', value: '7' },
]);

const NO_DOCUMENTS = rows('contract_setup', []);
const CONTRACT_ONLY_BILLING = rows('billing_review', [CONTRACT]);
const INVOICE_READ_AFTER_VALIDATION = rows('billing_review', [CONTRACT, { ...INVOICE, processedAt: READ_AFTER_VALIDATION_AT }]);

// A ceiling contract with its amount on file: nothing for validation to raise.
const CLEARED = rows('contract_setup', [CONTRACT], [
  { documentKey: 'contract', fieldKey: 'contract_ceiling_type', value: 'nte' },
  { documentKey: 'contract', fieldKey: 'nte_amount', value: 250000 },
]);

const COHORT_TITLES = Object.freeze({
  'fixture-contract': 'Sample Debris Removal Contract',
  'fixture-rate-exhibit': 'Sample Rate Exhibit',
  'fixture-invoice': 'Sample Invoice 7',
  'fixture-tickets': 'Sample Ticket Export',
});
const TICKET_CONFLICT: CohortState = { kind: 'cohort', build: ticketGrainConflictProfile, authorityMode: 'canonical', titles: COHORT_TITLES };
const TICKET_GRAIN: CohortState = { kind: 'cohort', build: ticketGrainProfile, authorityMode: 'legacy', titles: COHORT_TITLES };

const CONFLICT_RULE = 'TRANSACTION_TICKET_GRAIN_CONFLICT';

export const V2_REGRESSION_CASES: readonly QualificationCase[] = Object.freeze([
  // What am I missing?
  { caseId: 'missing-01', fixture: 'north_setup', intent: 'whats_missing', question: 'What am I missing?', focusRule: null, validated: NO_SCHEDULE },
  { caseId: 'missing-02', fixture: 'north_setup', intent: 'whats_missing', question: 'What else is missing on this project?', focusRule: null, validated: SCHEDULE_UNLINKED },
  { caseId: 'missing-03', fixture: 'south_billing', intent: 'whats_missing', question: 'What am I missing before billing review?', focusRule: null, validated: CONTRACT_ONLY_BILLING },
  { caseId: 'missing-04', fixture: 'west_cleared', intent: 'whats_missing', question: 'Am I missing anything?', focusRule: null, validated: CLEARED },
  { caseId: 'missing-05', fixture: 'ticket_conflict', intent: 'whats_missing', question: 'What is missing here?', focusRule: CONFLICT_RULE, validated: TICKET_CONFLICT },
  { caseId: 'missing-06', fixture: 'east_pricing', intent: 'whats_missing', question: 'What are we missing for pricing?', focusRule: null, validated: SCHEDULE_LINKED },

  // Do I need another document?
  { caseId: 'document-01', fixture: 'north_setup', intent: 'need_document', question: 'Do I need another document?', focusRule: null, validated: SCHEDULE_UNLINKED },
  { caseId: 'document-02', fixture: 'north_setup', intent: 'need_document', question: 'Do we need to upload a rate schedule?', focusRule: null, validated: NO_SCHEDULE },
  { caseId: 'document-03', fixture: 'east_pricing', intent: 'need_document', question: 'Should I request another pricing document?', focusRule: null, validated: SCHEDULE_READ_AFTER_VALIDATION },
  { caseId: 'document-04', fixture: 'south_billing', intent: 'need_document', question: 'Do I need another invoice document?', focusRule: 'SOURCES_NO_INVOICE_DATA', validated: CONTRACT_ONLY_BILLING, current: INVOICE_READ_AFTER_VALIDATION },
  { caseId: 'document-05', fixture: 'east_pricing', intent: 'need_document', question: 'Do I need to upload the price sheet again?', focusRule: null, validated: SCHEDULE_READ_FAILED },
  { caseId: 'document-06', fixture: 'west_cleared', intent: 'need_document', question: 'Do I need any other documents?', focusRule: null, validated: CLEARED },

  // Why is this flagged?
  { caseId: 'flagged-01', fixture: 'ticket_conflict', intent: 'why_flagged', question: 'Why is this flagged?', focusRule: CONFLICT_RULE, validated: TICKET_CONFLICT },
  { caseId: 'flagged-02', fixture: 'ticket_grain', intent: 'why_flagged', question: 'Why is this flagged?', focusRule: 'TRANSACTION_QUANTITY_MATCHES_INVOICE', validated: TICKET_GRAIN },
  { caseId: 'flagged-03', fixture: 'east_pricing', intent: 'why_flagged', question: 'Why is this flagged?', focusRule: 'FINANCIAL_RATE_BASED_ROWS_REQUIRED', validated: SCHEDULE_IN_CONTRACT_UNREAD },
  { caseId: 'flagged-04', fixture: 'north_setup', intent: 'why_flagged', question: 'Why is this still flagged?', focusRule: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED', validated: SCHEDULE_REFERENCE_ONLY },
  { caseId: 'flagged-05', fixture: 'south_billing', intent: 'why_flagged', question: 'Why is this project blocked?', focusRule: 'SOURCES_NO_CONTRACT', validated: NO_DOCUMENTS },
  { caseId: 'flagged-06', fixture: 'east_pricing', intent: 'why_flagged', question: 'Why is pricing flagged?', focusRule: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR', validated: SCHEDULE_COMPLETE },

  // What should I do?
  { caseId: 'action-01', fixture: 'north_setup', intent: 'what_to_do', question: 'What should I do?', focusRule: null, validated: NO_SCHEDULE },
  { caseId: 'action-02', fixture: 'north_setup', intent: 'what_to_do', question: 'What should I do next?', focusRule: null, validated: SCHEDULE_UNLINKED },
  { caseId: 'action-03', fixture: 'east_pricing', intent: 'what_to_do', question: 'What is the next step?', focusRule: null, validated: SCHEDULE_LINKED },
  { caseId: 'action-04', fixture: 'ticket_conflict', intent: 'what_to_do', question: 'What should we do about this?', focusRule: CONFLICT_RULE, validated: TICKET_CONFLICT },
  { caseId: 'action-05', fixture: 'ticket_grain', intent: 'what_to_do', question: 'What should I do?', focusRule: 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE', validated: TICKET_GRAIN },
  { caseId: 'action-06', fixture: 'west_cleared', intent: 'what_to_do', question: 'What should I do next?', focusRule: null, validated: CLEARED },
] satisfies readonly QualificationCase[]);

const AGREEMENT: DocumentSpec = { key: 'contract', title: 'Harbor Dredging Services Agreement', documentType: 'contract' };
const EXHIBIT: DocumentSpec = { key: 'sheet', title: 'Exhibit B Unit Rates', documentType: 'price sheet' };
const PAY_APPLICATION: DocumentSpec = { key: 'invoice', title: 'Pay Application 3', documentType: 'invoice' };
const FIELD_EXPORT: DocumentSpec = { key: 'tickets', title: 'Harbor Field Export', documentType: 'ticket' };
const EXHIBIT_LINK: RelationshipSpec = { key: 'sheet-link', sourceKey: 'sheet', targetKey: 'contract', type: 'attached_to' };

const HARBOR_TITLES = Object.freeze({
  'fixture-contract': 'Harbor Dredging Services Agreement',
  'fixture-rate-exhibit': 'Exhibit B Unit Rates',
  'fixture-invoice': 'Pay Application 3',
  'fixture-tickets': 'Harbor Field Export',
});
const HARBOR_TYPES = Object.freeze({ 'fixture-rate-exhibit': 'price sheet', 'fixture-tickets': 'ticket' });

const HARBOR_CODE = 'DREDGE-01';
const HARBOR_ITEM = 'Dredge and place within 12 miles';

/** The shape assembly produces, with nothing taken from a real contract. */
function harborRateRow(rowId: string, rate: number, sourceKind: 'exhibit_a_table' | 'exhibit_a_text_recovery'): ContractPricingAssemblyRow {
  return {
    id: rowId, row_id: rowId, category: 'transport', source_category: 'transport', description: HARBOR_ITEM, sourceDescription: HARBOR_ITEM,
    route: 'Channel to placement site', distanceBand: 'within 12 miles',
    pricingDimensions: { routeKind: 'row_to_dms', routeRawSpan: 'Channel to placement site',
      distanceBand: { minMiles: 0, maxMiles: 12, openEnded: false, exactMiles: null, rawExpression: 'within 12 miles' },
      distanceRawSpan: 'within 12 miles', confidence: null, parseState: 'explicit' },
    pricingDimensionSources: { route: 'source_text', distance: 'source_text' },
    unit: 'cubic yard', unit_type: 'cubic yard', rate, rate_amount: rate, page: 4, source_page: 4, sourceAnchor: 'pdf:table:p4:t1:r2', confidence: 'high',
    sourceKind, sourceQuality: 'clean', authoredValueCorrection: false, rawText: `${HARBOR_ITEM} cubic yard ${rate}`, evidenceRefs: ['pdf:table:p4:t1:r2:cell:0'],
  } as unknown as ContractPricingAssemblyRow;
}

const harborTicket = (id: string, quantity: number, cost: number, overrides: Readonly<{ rateCode?: string; sourceRowNumber?: number }> = {}) =>
  transactionRow({ id, transactionNumber: 'LOAD-884', invoiceNumber: 'PA-3', rateCode: HARBOR_CODE, quantity, cost, ...overrides });

/** A billed line of 300 cubic yards at 14.25, with whatever pricing rows and tickets the case needs. */
const harborSnapshot = (projectId: string, tickets: Parameters<typeof buildComparisonSourceSnapshot>[0]['transactionRows'], rows_: readonly ContractPricingAssemblyRow[] = []) => () => buildComparisonSourceSnapshot({
  projectId, assembledContractPricingRows: rows_,
  legacyRateScheduleItems: [rateItem({ recordId: 'item:dredge-01', rateCode: HARBOR_CODE, description: HARBOR_ITEM, unit: 'cubic yard', rate: 14.25, category: 'transport' })],
  invoices: [invoiceRow({ invoice_number: 'PA-3', billed_amount: 4275, total_amount: 4275, vendor_name: 'Harbor Marine' })],
  invoiceLines: [invoiceLineRow({ invoice_number: 'PA-3', description: HARBOR_ITEM, rate_code: HARBOR_CODE, quantity: 300, unit_price: 14.25, line_total: 4275 })],
  transactionRows: tickets,
});

const harborCohort = (build: CohortState['build'], authorityMode: CohortState['authorityMode'] = 'legacy'): CohortState =>
  ({ kind: 'cohort', build, authorityMode, titles: HARBOR_TITLES, documentTypes: HARBOR_TYPES });

const ceiling = (amount: number) => [{ documentKey: 'contract', fieldKey: 'contract_ceiling_type', value: 'nte' }, { documentKey: 'contract', fieldKey: 'nte_amount', value: amount }] as const;
const BILLING_NO_TICKETS = rows('billing_review', [AGREEMENT, PAY_APPLICATION]);
const BILLING_CONTRACT_ONLY = rows('billing_review', [AGREEMENT]);
const NO_RATE_SOURCE = rows('contract_setup', [AGREEMENT], [RATE_BASED]);

export const HELDOUT_CASES: readonly QualificationCase[] = Object.freeze([
  // What am I missing?
  { caseId: 'heldout-missing-01', fixture: 'harbor_billing', intent: 'whats_missing', question: 'What is still missing for billing review?', focusRule: null, validated: BILLING_NO_TICKETS },
  // A ticket is on file, but under another billing code, so the billed line has no group.
  { caseId: 'heldout-missing-02', fixture: 'harbor_setup', intent: 'whats_missing', question: 'What is missing from this project?', focusRule: null,
    validated: harborCohort(harborSnapshot('harbor-grouping', [harborTicket('t1', 300, 4275, { rateCode: 'DREDGE-02' })])) },
  { caseId: 'heldout-missing-03', fixture: 'harbor_cleared', intent: 'whats_missing', question: 'Is anything missing?', focusRule: null, validated: rows('contract_setup', [AGREEMENT], ceiling(480000)) },
  { caseId: 'heldout-missing-04', fixture: 'harbor_pricing', intent: 'whats_missing', question: 'What is missing before we can check pricing?', focusRule: null, validated: NO_RATE_SOURCE },
  { caseId: 'heldout-missing-05', fixture: 'harbor_setup', intent: 'whats_missing', question: 'What is missing before we can start?', focusRule: null, validated: rows('contract_setup', []) },
  { caseId: 'heldout-missing-06', fixture: 'harbor_billing', intent: 'whats_missing', question: 'What is missing from the project file?', focusRule: null, validated: BILLING_CONTRACT_ONLY },

  // Do I need another document?
  { caseId: 'heldout-document-01', fixture: 'harbor_pricing', intent: 'need_document', question: 'Do I need to upload the rate exhibit again?', focusRule: null,
    validated: rows('contract_setup', [AGREEMENT, { ...EXHIBIT, processingStatus: 'failed', processedAt: null }], [RATE_BASED]) },
  { caseId: 'heldout-document-02', fixture: 'harbor_billing', intent: 'need_document', question: 'Do I need another document for billing?', focusRule: null,
    validated: rows('billing_review', [AGREEMENT, PAY_APPLICATION, { ...FIELD_EXPORT, processingStatus: 'failed', processedAt: null }]) },
  { caseId: 'heldout-document-03', fixture: 'harbor_pricing', intent: 'need_document', question: 'Do we need a separate rate schedule?', focusRule: null,
    validated: rows('contract_setup', [AGREEMENT, { ...EXHIBIT, processedAt: READ_AFTER_VALIDATION_AT }], [RATE_BASED], [EXHIBIT_LINK]) },
  // Source-family ambiguity: its title suggests rates, but nothing classifies it as a schedule.
  { caseId: 'heldout-document-04', fixture: 'harbor_pricing', intent: 'need_document', question: 'Do we need another pricing document?', focusRule: null,
    validated: rows('contract_setup', [AGREEMENT, { key: 'sheet', title: 'Rate Information', documentType: 'other' }], [RATE_BASED]) },
  { caseId: 'heldout-document-05', fixture: 'harbor_cleared', intent: 'need_document', question: 'Do I need to upload anything else?', focusRule: null, validated: rows('contract_setup', [AGREEMENT], ceiling(125000)) },
  { caseId: 'heldout-document-06', fixture: 'harbor_setup', intent: 'need_document', question: 'Should I request the contract again?', focusRule: 'SOURCES_NO_CONTRACT', validated: rows('contract_setup', []),
    current: rows('contract_setup', [{ ...AGREEMENT, processingStatus: 'processing', processedAt: null }]) },

  // Why is this flagged?
  { caseId: 'heldout-flagged-01', fixture: 'harbor_setup', intent: 'why_flagged', question: 'Why has this not cleared?', focusRule: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED',
    validated: rows('contract_setup', [AGREEMENT, { ...EXHIBIT, authorityStatus: 'reference_only' }], [RATE_BASED], [EXHIBIT_LINK]) },
  { caseId: 'heldout-flagged-02', fixture: 'harbor_conflict', intent: 'why_flagged', question: 'Why is this flagged?', focusRule: CONFLICT_RULE,
    validated: harborCohort(harborSnapshot('harbor-conflict', [harborTicket('t1', 300, 4275), harborTicket('t2', 310, 4417.5, { sourceRowNumber: 5 })], [harborRateRow('exhibit_a_table:harbor:1', 14.25, 'exhibit_a_table')]), 'canonical') },
  { caseId: 'heldout-flagged-03', fixture: 'harbor_tickets', intent: 'why_flagged', question: 'Why is this project blocked?', focusRule: null,
    validated: harborCohort(harborSnapshot('harbor-recovered-rows', [harborTicket('t1', 300, 4275)], [1, 2, 3].map((row) => harborRateRow(`exhibit_a_text_recovery:harbor:${row}`, 14.25, 'exhibit_a_text_recovery'))), 'canonical') },
  { caseId: 'heldout-flagged-04', fixture: 'harbor_pricing', intent: 'why_flagged', question: 'Why is the rate exhibit still flagged?', focusRule: 'FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED',
    validated: rows('contract_setup', [AGREEMENT, EXHIBIT], [RATE_BASED], [EXHIBIT_LINK]) },
  { caseId: 'heldout-flagged-05', fixture: 'harbor_pricing', intent: 'why_flagged', question: 'Why is pricing still open?', focusRule: 'FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR',
    validated: rows('contract_setup', [AGREEMENT], [
      RATE_BASED,
      { documentKey: 'contract', fieldKey: 'rate_schedule_present', value: true },
      { documentKey: 'contract', fieldKey: 'rate_row_count', value: 9 },
      { documentKey: 'contract', fieldKey: 'rate_schedule_pages', value: '12' },
    ]) },
  { caseId: 'heldout-flagged-06', fixture: 'harbor_tickets', intent: 'why_flagged', question: 'Why is this line flagged?', focusRule: 'TRANSACTION_QUANTITY_MATCHES_INVOICE',
    validated: harborCohort(harborSnapshot('harbor-quantity', [harborTicket('t1', 260, 4275)])) },

  // What should I do?
  { caseId: 'heldout-action-01', fixture: 'harbor_setup', intent: 'what_to_do', question: 'What is my next step?', focusRule: null, validated: rows('contract_setup', [AGREEMENT, EXHIBIT], [RATE_BASED]) },
  { caseId: 'heldout-action-02', fixture: 'harbor_pricing', intent: 'what_to_do', question: 'What do I do now?', focusRule: 'FINANCIAL_RATE_BASED_ROWS_REQUIRED',
    validated: rows('contract_setup', [AGREEMENT], [RATE_BASED, { documentKey: 'contract', fieldKey: 'rate_schedule_present', value: true }]) },
  { caseId: 'heldout-action-03', fixture: 'harbor_tickets', intent: 'what_to_do', question: 'What should we do first?', focusRule: null,
    validated: harborCohort(harborSnapshot('harbor-recovered-row', [harborTicket('t1', 300, 4275)], [harborRateRow('exhibit_a_text_recovery:harbor:9', 14.25, 'exhibit_a_text_recovery')]), 'canonical') },
  { caseId: 'heldout-action-04', fixture: 'harbor_tickets', intent: 'what_to_do', question: 'What should I check on this line?', focusRule: 'TRANSACTION_TOTAL_MATCHES_INVOICE_LINE',
    validated: harborCohort(harborSnapshot('harbor-total', [harborTicket('t1', 300, 3990)])) },
  { caseId: 'heldout-action-05', fixture: 'harbor_cleared', intent: 'what_to_do', question: 'What should we do next on this project?', focusRule: null,
    validated: rows('contract_setup', [AGREEMENT, { key: 'amendment', title: 'Amendment 1', documentType: 'amendment' }], ceiling(310000)) },
  { caseId: 'heldout-action-06', fixture: 'harbor_billing', intent: 'what_to_do', question: 'What needs my attention?', focusRule: 'SOURCES_NO_INVOICE_DATA', validated: BILLING_CONTRACT_ONLY,
    current: rows('billing_review', [AGREEMENT, { ...PAY_APPLICATION, processingStatus: 'failed', processedAt: null }]) },
] satisfies readonly QualificationCase[]);

/** What a case's project holds. No two held-out cases may stand on one operational state. */
export function heldoutStateSignature(item: QualificationCase): string {
  const plain = (_key: string, value: unknown) => (value instanceof Map ? [...value] : value instanceof Set ? [...value] : value);
  const validated = item.validated.kind === 'cohort' ? { mode: item.validated.authorityMode, snapshot: { ...item.validated.build(), project: null } } : item.validated;
  return JSON.stringify({ validated, current: item.current ?? null }, plain);
}
