/**
 * Canonical truth actually governs exposure and clearance.
 *
 * The claim under test is behavioral, not structural: when the projected
 * canonical input differs from the legacy input, the exposure numbers and the
 * approval decision differ with it — and when canonical authority cannot
 * establish itself, nothing legacy rescues the result.
 *
 * No business algorithm moved. `evaluateProjectExposure` and
 * `evaluateApprovalGate` are the shipping implementations, called unchanged.
 * Only the transaction rows they read come from a different authority.
 */

import { describe, expect, it } from 'vitest';

import { assembleCanonicalTransactions } from '@/lib/canonical/authority/canonicalTransactionAuthority';
import { projectCanonicalTransactionRows } from '@/lib/canonical/authority/canonicalValidatorProjection';
import type { PersistedCanonicalTransactionRowInput } from '@/lib/canonical/transaction/transactionAdapter';
import { evaluateApprovalGate } from '@/lib/validator/approvalGate';
import { deriveBillingKeysForTransactionRecord } from '@/lib/validator/billingKeys';
import { evaluateProjectExposure } from '@/lib/validator/exposure';
import {
  RULE_TRANSACTION_GRAIN_CONFLICT,
  runTransactionGrainConflictRules,
} from '@/lib/validator/rulePacks/transactionGrainConflict';
import {
  buildValidationSummary,
  type ProjectTotals,
  type ProjectValidatorInput,
  type RateScheduleItem,
  type ValidatorDocumentIdsByFamily,
  type ValidatorFactLookups,
  type ValidatorTransactionDataRow,
} from '@/lib/validator/shared';
import type { ValidatorResult } from '@/types/validator';

const PROJECT_ID = 'project-1';
const CONTRACT_DOCUMENT_ID = 'contract-1';
const INVOICE_DOCUMENT_ID = 'invoice-doc-1';
const RATE_CODE = 'HAUL-4';
const RATE = 10;

const KEYS = deriveBillingKeysForTransactionRecord({
  invoice_number: 'INV-1001',
  rate_code: RATE_CODE,
  rate_description: null,
  service_item: null,
  material: null,
  site_type: null,
});

function rateItem(): RateScheduleItem {
  return {
    source_document_id: CONTRACT_DOCUMENT_ID,
    record_id: `schedule:${RATE_CODE}`,
    rate_code: RATE_CODE,
    unit_type: 'cubic yard',
    rate_amount: RATE,
    material_type: null,
    description: 'Haul class 4',
    raw_value: null,
  } as unknown as RateScheduleItem;
}

/** One persisted ticket row, the shape canonical assembly consumes. */
function ticketRow(
  overrides: Partial<PersistedCanonicalTransactionRowInput> = {},
): PersistedCanonicalTransactionRowInput {
  return {
    id: 'txn-1',
    document_id: 'transaction-doc-1',
    invoice_number: 'INV-1001',
    transaction_number: 'TKT-1',
    rate_code: RATE_CODE,
    billing_rate_key: KEYS.billing_rate_key,
    invoice_rate_key: KEYS.invoice_rate_key,
    site_material_key: KEYS.site_material_key,
    transaction_quantity: 100,
    extended_cost: 1000,
    invoice_date: '2026-03-15',
    source_sheet_name: 'Tickets',
    source_row_number: 4,
    record_json: {},
    raw_row_json: {},
    ...overrides,
  };
}

function buildInput(transactionRows: readonly ValidatorTransactionDataRow[]): ProjectValidatorInput {
  const invoiceRows = [{
    id: 'invoice-1',
    source_document_id: INVOICE_DOCUMENT_ID,
    invoice_number: 'INV-1001',
    invoice_date: '2026-03-31',
    billed_amount: 1000,
  }];
  const invoiceLines = [{
    id: 'invoice-line-1',
    invoice_id: 'invoice-1',
    source_document_id: INVOICE_DOCUMENT_ID,
    invoice_number: 'INV-1001',
    rate_code: RATE_CODE,
    line_description: 'Haul class 4',
    quantity: 100,
    unit_price: RATE,
    line_total: 1000,
    billing_rate_key: KEYS.billing_rate_key,
    invoice_rate_key: KEYS.invoice_rate_key,
    site_material_key: KEYS.site_material_key,
  }];

  const familyDocumentIds: ValidatorDocumentIdsByFamily = {
    contract: [CONTRACT_DOCUMENT_ID],
    rate_sheet: [],
    permit: [],
    invoice: [INVOICE_DOCUMENT_ID],
    ticket_support: [],
  };
  const rateScheduleItems = [rateItem()];
  const factLookups = {
    contractProjectCodeFacts: [],
    invoiceProjectCodeFacts: [],
    contractPartyNameFacts: [],
    contractIdentityDocumentIds: [CONTRACT_DOCUMENT_ID],
    pricingContextDocumentIds: [],
    complianceContextDocumentIds: [],
    amendmentContextDocumentIds: [],
    nteFact: null,
    contractDocumentId: CONTRACT_DOCUMENT_ID,
    contractCeilingTypeFact: null,
    contractCeilingType: 'rate_based',
    rateSchedulePresentFact: null,
    rateSchedulePresent: true,
    rateRowCountFact: null,
    rateRowCount: 1,
    rateSchedulePagesFact: null,
    rateSchedulePagesDisplay: null,
    rateUnitsDetectedFact: null,
    rateUnitsDetected: ['cubic yard'],
    timeAndMaterialsPresentFact: null,
    timeAndMaterialsPresent: false,
    rateScheduleFacts: [],
    rateScheduleItems,
    hasRateScheduleFacts: true,
  } as unknown as ValidatorFactLookups;

  const projectTotals: ProjectTotals = {
    billed_total: 1000,
    invoice_count: 1,
    invoice_line_count: 1,
    mobile_ticket_count: 0,
    load_ticket_count: 0,
  };

  return {
    project: { id: PROJECT_ID, organization_id: 'org-1', name: 'P', code: 'P-1' },
    validationPhase: 'billing_review',
    documents: [],
    assembledContractPricingRows: [],
    sourceArtifactSnapshot: [],
    documentRelationships: [],
    precedenceFamilies: [],
    familyDocumentIds,
    governingDocumentIds: familyDocumentIds,
    truthCategoryDocumentIds: {
      contract_identity: [CONTRACT_DOCUMENT_ID],
      pricing: [CONTRACT_DOCUMENT_ID],
      compliance: [],
      amendments: [],
    },
    ruleStateByRuleId: new Map(),
    factsByDocumentId: new Map(),
    allFacts: [],
    mobileTickets: [],
    loadTickets: [],
    invoices: invoiceRows,
    invoiceLines,
    mobileToLoadsMap: new Map(),
    invoiceLineToRateMap: new Map([['invoice-line-1', rateItem()]]),
    projectTotals,
    factLookups,
    contractValidationContext: null,
    transactionData: {
      datasets: [],
      rows: [...transactionRows],
      rollups: {
        grouped_by_rate_code: [],
        grouped_by_invoice: [],
        grouped_by_site_material: [],
      },
    },
    reconciliationContext: null,
  } as unknown as ProjectValidatorInput;
}

/** The canonical seam: persisted rows → canonical assembly → validator rows. */
function canonicalRows(
  rows: readonly PersistedCanonicalTransactionRowInput[],
): readonly ValidatorTransactionDataRow[] {
  const assembly = assembleCanonicalTransactions({ rows });
  return projectCanonicalTransactionRows(assembly.transactions, PROJECT_ID);
}

function clearance(assessmentFindings: ValidatorResult['findings'], summary: unknown) {
  return evaluateApprovalGate({
    status: 'FINDINGS_OPEN',
    blocked_reasons: [],
    findings: assessmentFindings,
    summary: buildValidationSummary(assessmentFindings as never, 'FINDINGS_OPEN', {
      exposure: summary as never,
    }),
    rulesApplied: [],
    validator_status: 'NEEDS_REVIEW',
    validator_open_items: assessmentFindings.length,
    validator_blockers: assessmentFindings.filter((finding) => finding.blocked_reason != null).length,
    exposure: summary as never,
  } as unknown as ValidatorResult);
}

describe('exposure consumes canonical amounts and quantities', () => {
  it('supports the invoice when canonical ticket truth matches it', () => {
    const assessment = evaluateProjectExposure(buildInput(canonicalRows([ticketRow()])), []);

    expect(assessment.summary!.total_billed_amount).toBe(1000);
    expect(assessment.summary!.total_transaction_supported_amount).toBe(1000);
    expect(assessment.summary!.total_at_risk_amount).toBe(0);
  });

  it('changes exposure only because the projected canonical amount changed', () => {
    const supported = evaluateProjectExposure(buildInput(canonicalRows([ticketRow()])), []);
    // Same invoice, same rules, same code path — only the canonical extended
    // cost and quantity differ.
    const short = evaluateProjectExposure(
      buildInput(canonicalRows([ticketRow({ transaction_quantity: 40, extended_cost: 400 })])),
      [],
    );

    expect(supported.summary!.total_transaction_supported_amount).toBe(1000);
    expect(short.summary!.total_transaction_supported_amount).toBe(400);
    expect(short.summary!.total_at_risk_amount).toBeGreaterThan(
      supported.summary!.total_at_risk_amount,
    );
  });

  it('does not double-count a ticket that appears on repeated agreeing rows', () => {
    const repeated = canonicalRows([
      ticketRow({ id: 'txn-a', transaction_number: 'TKT-1', transaction_quantity: 100, extended_cost: 1000 }),
      ticketRow({ id: 'txn-b', transaction_number: 'TKT-1', transaction_quantity: 100, extended_cost: 1000 }),
    ]);
    const assessment = evaluateProjectExposure(buildInput(repeated), []);

    // Ticket-grain: one physical ticket cannot support twice its amount.
    expect(assessment.summary!.total_transaction_supported_amount)
      .toBeLessThanOrEqual(assessment.summary!.total_billed_amount);
  });
});

describe('unresolved ticket-grain conflict prevents false clearance', () => {
  const CONFLICTING = [
    ticketRow({ id: 'txn-a', transaction_number: 'TKT-9', transaction_quantity: 100, extended_cost: 1000 }),
    ticketRow({ id: 'txn-b', transaction_number: 'TKT-9', transaction_quantity: 140, extended_cost: 1400 }),
  ];

  it('keeps both observations and invents no reconciled amount', () => {
    const assembly = assembleCanonicalTransactions({ rows: CONFLICTING });

    expect(assembly.distinctIdentityCount).toBe(1);
    expect(assembly.transactions).toHaveLength(2);
    expect(assembly.grainConflicts).toHaveLength(2);
    const quantities = assembly.transactions.map((transaction) => transaction.quantity.value).sort();
    // Exactly the observed values — no average, no max, no sum.
    expect(quantities).toEqual([100, 140]);
  });

  it('blocks clearance through the shipping approval gate', () => {
    const input = buildInput(canonicalRows(CONFLICTING));
    const conflictFindings = runTransactionGrainConflictRules({
      ...input,
      projectTruthAuthority: {
        authorityMode: 'canonical',
        assemblyStatus: 'blocked',
        registry: null,
        registryDigest: 'digest',
        sourceArtifactSnapshotDigest: 'snapshot',
        validatorProjection: {
          rateScheduleItems: [],
          transactions: {
            rows: assembleCanonicalTransactions({ rows: CONFLICTING }).transactions,
            distinctIdentityCount: 1,
            grainConflicts: assembleCanonicalTransactions({ rows: CONFLICTING }).grainConflicts,
          },
        },
        blockReason: 'incomplete_domain_authority',
        block: null,
      },
    } as unknown as ProjectValidatorInput);
    const assessment = evaluateProjectExposure(input, conflictFindings);

    expect(conflictFindings.some((finding) => finding.rule_id === RULE_TRANSACTION_GRAIN_CONFLICT))
      .toBe(true);
    const gate = clearance(
      [...conflictFindings, ...assessment.findings] as never,
      assessment.summary,
    );
    expect(gate.project.approval_status).not.toBe('approved');
    expect(gate.project.approval_status).toBe('blocked');
  });
});

describe('no legacy rescue when canonical authority is unavailable', () => {
  it('produces no transaction support when canonical transaction truth is withheld', () => {
    // This is what the validator now does on a blocked canonical context: the
    // canonical rows are empty rather than silently reverting to legacy rows.
    const assessment = evaluateProjectExposure(buildInput([]), []);

    expect(assessment.summary!.total_transaction_supported_amount).toBe(0);
    expect(assessment.summary!.total_at_risk_amount).toBeGreaterThan(0);
  });

  it('does not clear a project whose canonical truth was withheld', () => {
    const assessment = evaluateProjectExposure(buildInput([]), []);
    const gate = clearance(assessment.findings as never, assessment.summary);

    expect(gate.project.approval_status).not.toBe('approved');
  });
});
