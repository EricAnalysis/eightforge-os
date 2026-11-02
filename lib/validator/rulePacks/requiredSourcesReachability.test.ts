import { describe, expect, it } from 'vitest';

import { resolveDocumentPrecedence, type DocumentRelationshipRecord } from '@/lib/documentPrecedence';
import { getIssueDisplayLabel } from '@/lib/issueDisplayFormatter';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import { buildDocumentIdsByFamily } from '@/lib/validator/projectValidator';
import { validatorRuleExplanation } from '@/lib/validator/ruleExplanations';
import { runFinancialIntegrityRules } from '@/lib/validator/rulePacks/financialIntegrity';
import { runRequiredSourcesRules } from '@/lib/validator/rulePacks/requiredSources';
import type { ProjectValidatorInput, ValidatorDocumentRow, ValidatorFactLookups } from '@/lib/validator/shared';
import type { ValidationFinding } from '@/types/validator';

/**
 * Why SOURCES_NO_RATE_SCHEDULE was retired, and what retiring it must not disturb.
 *
 * The rule required a contract and an empty pricing list, and production always
 * puts the contract in the pricing list. Every truth category here comes from the
 * real precedence and family resolvers, never by hand, except the one case that
 * shows the retired branch no longer emits even on input production cannot build.
 */

const RETIRED_RULE = 'SOURCES_NO_RATE_SCHEDULE';
const PROJECT = 'project-1';
const AT = '2026-01-01T00:00:00.000Z';

type DocumentSpec = Readonly<{ id: string; title: string; document_type: string | null; document_role?: string; document_subtype?: string; authority_status?: string }>;

const CONTRACT: DocumentSpec = { id: 'contract', title: 'Debris Contract', document_type: 'contract' };
const SECOND_CONTRACT: DocumentSpec = { id: 'contract-2', title: 'Replacement Contract', document_type: 'contract', document_role: 'base_contract', document_subtype: 'replacement_contract' };
const COPY_OF_CONTRACT: DocumentSpec = { id: 'contract-copy', title: 'Debris Contract', document_type: 'contract' };
const AMENDMENT: DocumentSpec = { id: 'amendment', title: 'Contract Amendment 1', document_type: 'contract' };
const PRICE_SHEET: DocumentSpec = { id: 'sheet', title: 'Price Sheet', document_type: 'price sheet' };
const COPY_OF_SHEET: DocumentSpec = { id: 'sheet-copy', title: 'Price Sheet', document_type: 'price sheet' };
const INVOICE: DocumentSpec = { id: 'invoice', title: 'Invoice 7', document_type: 'invoice' };

const DOCUMENT_POOL = [CONTRACT, SECOND_CONTRACT, COPY_OF_CONTRACT, AMENDMENT, PRICE_SHEET, COPY_OF_SHEET, INVOICE];
const AUTHORITY_STATUSES = [undefined, 'active', 'superseded', 'draft', 'archived', 'reference_only'];

const RELATIONSHIP_SETS: readonly (readonly [string, string, string][])[] = [
  [],
  [['sheet', 'contract', 'attached_to']],
  [['sheet', 'contract', 'governs']],
  [['contract-copy', 'contract', 'duplicate_of']],
  [['contract', 'contract-copy', 'duplicate_of']],
  [['sheet-copy', 'sheet', 'duplicate_of'], ['sheet', 'contract', 'attached_to']],
  [['amendment', 'contract', 'amends']],
  [['contract-2', 'contract', 'supersedes']],
  // A contract attached as pricing: the one case that takes a document out of contract identity.
  [['contract-copy', 'contract', 'attached_to']],
  [['contract', 'contract-2', 'attached_to'], ['contract-2', 'contract', 'attached_to']],
];

function row(spec: DocumentSpec, authorityStatus?: string): ValidatorDocumentRow {
  return {
    id: spec.id, project_id: PROJECT, organization_id: 'org-1', title: spec.title, name: spec.title,
    document_type: spec.document_type, document_role: spec.document_role ?? null, document_subtype: spec.document_subtype ?? null,
    authority_status: authorityStatus ?? spec.authority_status ?? null, created_at: AT,
  } as unknown as ValidatorDocumentRow;
}

function relationshipRows(set: readonly (readonly [string, string, string])[], present: ReadonlySet<string>): DocumentRelationshipRecord[] {
  return set.filter(([source, target]) => present.has(source) && present.has(target)).map(([source, target, type], index) => ({
    id: `rel-${index}`, project_id: PROJECT, source_document_id: source, target_document_id: target, relationship_type: type, created_by: null, created_at: AT,
  }));
}

/** What the source read does, from the same two resolvers. */
function resolvedCategories(documents: readonly ValidatorDocumentRow[], relationships: readonly DocumentRelationshipRecord[]) {
  const families = resolveDocumentPrecedence({ documents: documents as never, relationships: relationships as never });
  return buildDocumentIdsByFamily(documents, families, relationships);
}

/** A rate-based contract with no schedule of any kind: the situation the rule described. */
const NO_SCHEDULE_FACTS = {
  contractProjectCodeFacts: [], invoiceProjectCodeFacts: [], contractPartyNameFacts: [],
  pricingContextDocumentIds: [], complianceContextDocumentIds: [], amendmentContextDocumentIds: [],
  nteFact: null, contractDocumentId: 'contract', contractCeilingTypeFact: null, contractCeilingType: 'rate_based',
  rateSchedulePresentFact: null, rateSchedulePresent: null, rateRowCountFact: null, rateRowCount: null,
  rateSchedulePagesFact: null, rateSchedulePagesDisplay: null, rateUnitsDetectedFact: null, rateUnitsDetected: [],
  timeAndMaterialsPresentFact: null, timeAndMaterialsPresent: false,
  rateScheduleFacts: [], rateScheduleItems: [], hasRateScheduleFacts: false,
} as unknown as ValidatorFactLookups;

function inputFor(categories: ReturnType<typeof buildDocumentIdsByFamily>): ProjectValidatorInput {
  return {
    project: { id: PROJECT, organization_id: 'org-1', name: 'Project', code: 'P1' },
    validationPhase: 'billing_review',
    documents: [], assembledContractPricingRows: [], sourceArtifactSnapshot: [], documentRelationships: [], precedenceFamilies: [],
    familyDocumentIds: categories.familyDocumentIds, governingDocumentIds: categories.governingDocumentIds,
    truthCategoryDocumentIds: categories.truthCategoryDocumentIds,
    ruleStateByRuleId: new Map(), factsByDocumentId: new Map(), allFacts: [], mobileTickets: [], loadTickets: [], invoices: [], invoiceLines: [],
    mobileToLoadsMap: new Map(), invoiceLineToRateMap: new Map(),
    projectTotals: { billed_total: null, invoice_count: 0, invoice_line_count: 0, mobile_ticket_count: 0, load_ticket_count: 0 },
    factLookups: { ...NO_SCHEDULE_FACTS, contractIdentityDocumentIds: categories.truthCategoryDocumentIds.contract_identity },
    contractValidationContext: null, transactionData: { datasets: [], rows: [], rollups: { grouped_by_rate_code: [], grouped_by_invoice: [], grouped_by_site_material: [] } },
    reconciliationContext: null,
  } as unknown as ProjectValidatorInput;
}

function emitsRetiredRule(input: ProjectValidatorInput): boolean {
  return runRequiredSourcesRules(input).some((finding) => finding.rule_id === RETIRED_RULE);
}

/** Every subset of the pool, under every relationship set, with the contract in every authority state. */
function* everyProjectShape() {
  for (let mask = 0; mask < 1 << DOCUMENT_POOL.length; mask += 1) {
    const specs = DOCUMENT_POOL.filter((_, index) => mask & (1 << index));
    const present = new Set(specs.map((spec) => spec.id));
    for (const set of RELATIONSHIP_SETS) {
      for (const status of AUTHORITY_STATUSES) {
        yield {
          documents: specs.map((spec) => row(spec, spec.id === 'contract' ? status : undefined)),
          relationships: relationshipRows(set, present),
        };
      }
    }
  }
}

describe('why the rule could not fire', () => {
  it('every contract identity document is in pricing, across every project shape', () => {
    let shapes = 0;
    let shapesWithContract = 0;
    for (const { documents, relationships } of everyProjectShape()) {
      shapes += 1;
      const { contract_identity: identity, pricing } = resolvedCategories(documents, relationships).truthCategoryDocumentIds;
      if (identity.length > 0) shapesWithContract += 1;
      expect(identity.filter((id) => !pricing.includes(id))).toEqual([]);
    }
    // The sweep reached the rule's precondition, not just empty projects.
    expect(shapes).toBe(128 * RELATIONSHIP_SETS.length * AUTHORITY_STATUSES.length);
    expect(shapesWithContract).toBeGreaterThan(shapes / 2);
  });

  it('a contract alone is its own pricing source', () => {
    const { truthCategoryDocumentIds } = resolvedCategories([row(CONTRACT)], []);
    expect(truthCategoryDocumentIds).toMatchObject({ contract_identity: ['contract'], pricing: ['contract'] });
  });

  it('an amendment alone is no exception: there is no contract identity for the rule to act on', () => {
    const { truthCategoryDocumentIds } = resolvedCategories([row(AMENDMENT)], []);
    expect(truthCategoryDocumentIds.contract_identity).toEqual([]);
    expect(runRequiredSourcesRules(inputFor(resolvedCategories([row(AMENDMENT)], []))).map((finding) => finding.rule_id))
      .toContain('SOURCES_NO_CONTRACT');
  });
});

describe('the retired branch', () => {
  it('emits nothing across every project shape', () => {
    for (const { documents, relationships } of everyProjectShape()) {
      expect(emitsRetiredRule(inputFor(resolvedCategories(documents, relationships)))).toBe(false);
    }
  });

  it('emits nothing even on input production cannot build', () => {
    const impossible = inputFor(resolvedCategories([row(CONTRACT)], []));
    impossible.truthCategoryDocumentIds = { ...impossible.truthCategoryDocumentIds, pricing: [] };
    impossible.familyDocumentIds = { ...impossible.familyDocumentIds, rate_sheet: [] };
    expect(emitsRetiredRule(impossible)).toBe(false);
  });

  it('leaves the other required-source rules firing', () => {
    const rules = runRequiredSourcesRules(inputFor(resolvedCategories([], []))).map((finding) => finding.rule_id);
    expect(rules).toEqual(expect.arrayContaining(['SOURCES_NO_CONTRACT', 'SOURCES_NO_INVOICE_DATA', 'SOURCES_NO_TICKET_DATA']));
  });

  it('leaves the dedicated rule covering a rate-based contract with no schedule', () => {
    const rules = runFinancialIntegrityRules(inputFor(resolvedCategories([row(CONTRACT)], []))).map((finding) => finding.rule_id);
    expect(rules).toContain('FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED');
  });
});

describe('historical findings of the retired rule', () => {
  const historical = {
    id: 'finding-historical', run_id: 'run-old', project_id: PROJECT, rule_id: RETIRED_RULE, check_key: 'project:contract:rate_schedule',
    category: 'required_sources', severity: 'critical', status: 'resolved', subject_type: 'project', subject_id: PROJECT,
    field: 'rate_schedule', expected: 'extracted rate schedule facts', actual: 'missing', variance: null, variance_unit: null,
    blocked_reason: 'Governing contract requires pricing support but no pricing schedule is linked', evidence_refs: [],
    decision_eligible: false, action_eligible: true, linked_decision_id: null, linked_action_id: null, resolved_by_user_id: null,
    resolved_at: AT, created_at: AT, updated_at: AT,
  } as unknown as ValidationFinding;

  it('still explains the rule from the catalogue', () => {
    expect(validatorRuleExplanation(RETIRED_RULE)).toMatchObject({ title: 'Required pricing schedule is missing', category: 'Source documents' });
  });

  it('still displays with its title, never a raw key', () => {
    expect(getIssueDisplayLabel(RETIRED_RULE).title).toBe('Required pricing schedule is missing');
  });

  it('still normalizes with its source family and required action', () => {
    const normalized = normalizeValidationFinding(historical);
    expect(normalized.source_family).toBe('contract');
    expect(normalized.required_action).toBe(validatorRuleExplanation(RETIRED_RULE)?.requiredAction);
  });
});
