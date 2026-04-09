import type {
  DocumentRelationshipRecord,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import type { ContractAnalysisResult } from '@/lib/contracts/types';
import type { EvidenceObject } from '@/lib/extraction/types';
import type {
  TransactionDataInvoiceGroup,
  TransactionDataRateCodeGroup,
  TransactionDataSiteMaterialGroup,
} from '@/lib/types/transactionData';
import {
  normalizeCurrency,
  normalizeString,
} from '@/lib/validation/normalizeValidationValues';
import type {
  ContractInvoiceReconciliationSummary,
  InvoiceTransactionReconciliationSummary,
  ProjectExposureSummary,
  ProjectReconciliationSummary,
  ValidationEvidence,
  ValidationFinding,
  ValidationRuleState,
  ValidationSummary,
  ValidationCategory,
  ValidationSeverity,
  ValidationStatus,
  ValidatorStatus,
  ValidatorSummaryItem,
} from '@/types/validator';

export const PURE_VALIDATOR_RUN_ID = 'pure-validator';
export const PURE_VALIDATOR_TIMESTAMP = '1970-01-01T00:00:00.000Z';

export type ValidatorProjectRow = {
  id: string;
  organization_id: string;
  name: string;
  code: string | null;
  validation_status?: string | null;
  validation_summary_json?: unknown;
};

export type ValidatorDocumentRow = {
  id: string;
  project_id: string | null;
  organization_id: string;
  title: string | null;
  name: string;
  document_type: string | null;
  created_at: string;
  processing_status?: string | null;
  processed_at?: string | null;
};

export type ValidatorExtractionFactRow = {
  document_id: string;
  field_key: string;
  field_type: string | null;
  field_value_text: string | null;
  field_value_number: number | null;
  field_value_date: string | null;
  field_value_boolean: boolean | null;
  source?: string | null;
  confidence?: number | null;
};

export type ValidatorLegacyExtractionRow = {
  document_id: string;
  created_at?: string | null;
  data?: Record<string, unknown> | null;
};

export type StructuredRow = Record<string, unknown>;
export type MobileTicketRow = StructuredRow;
export type LoadTicketRow = StructuredRow;
export type InvoiceRow = StructuredRow;
export type InvoiceLineRow = StructuredRow;

export type ValidatorDocumentIdsByFamily = {
  contract: string[];
  rate_sheet: string[];
  permit: string[];
  invoice: string[];
  ticket_support: string[];
};

export type ValidatorFactSource =
  | 'normalized_row'
  | 'legacy_typed_field'
  | 'legacy_structured_field'
  | 'legacy_section_signal';

export type ValidatorFactRecord = {
  id: string;
  document_id: string;
  key: string;
  value: unknown;
  source: ValidatorFactSource;
  field_type: string | null;
  evidence: ValidationEvidence[];
};

export type ValidatorEvidenceResult = ValidationEvidence;

/** Rate rows: raw fields preserved; canonical billing keys live in `@/lib/validator/billingKeys`. */
export type RateScheduleItem = {
  source_document_id: string;
  record_id: string;
  rate_code: string | null;
  unit_type: string | null;
  rate_amount: number | null;
  material_type: string | null;
  description: string | null;
  service_item?: string | null;
  raw_value: unknown;
  /** Derived: canonical pricing key for reconciliation (see billingKeys). */
  billing_rate_key?: string | null;
  /** Derived: normalized description for fallback matching. */
  description_match_key?: string | null;
  /** Derived: site/facility + material when available. */
  site_material_key?: string | null;
};

export type ProjectTotals = {
  billed_total: number | null;
  invoice_count: number;
  invoice_line_count: number;
  mobile_ticket_count: number;
  load_ticket_count: number;
};

export type ValidatorTransactionDataDataset = {
  id: string;
  document_id: string;
  project_id: string;
  row_count: number;
  total_extended_cost: number;
  total_transaction_quantity: number;
  date_range_start: string | null;
  date_range_end: string | null;
  summary_json: Record<string, unknown>;
  created_at: string;
};

export type ValidatorTransactionDataRow = {
  id: string;
  document_id: string;
  project_id: string;
  invoice_number: string | null;
  transaction_number: string | null;
  rate_code: string | null;
  billing_rate_key: string | null;
  site_material_key: string | null;
  transaction_quantity: number | null;
  extended_cost: number | null;
  invoice_date: string | null;
  source_sheet_name: string;
  source_row_number: number;
  record_json: Record<string, unknown>;
  raw_row_json: Record<string, unknown>;
  created_at: string;
};

export type ValidatorProjectTransactionData = {
  datasets: ValidatorTransactionDataDataset[];
  rows: ValidatorTransactionDataRow[];
  rollups?: ValidatorTransactionRollups;
};

export type ValidatorTransactionRollups = {
  grouped_by_rate_code: TransactionDataRateCodeGroup[];
  grouped_by_invoice: TransactionDataInvoiceGroup[];
  grouped_by_site_material: TransactionDataSiteMaterialGroup[];
};

export type ValidatorContractReconciliationSource = {
  governing_document_ids: string[];
  intelligence: ValidatorContractAnalysisContext | null;
  rate_schedule_items: RateScheduleItem[];
};

export type ValidatorInvoiceReconciliationSource = {
  invoices: InvoiceRow[];
  line_items: InvoiceLineRow[];
};

export type ValidatorTransactionReconciliationSource = {
  datasets: ValidatorTransactionDataDataset[];
  rows: ValidatorTransactionDataRow[];
  rollups: ValidatorTransactionRollups;
};

export type ValidatorBillingGroup = {
  billing_group_id: string;
  billing_rate_key: string;
  description_match_key: string | null;
  site_material_keys: string[];
  invoice_rate_keys: string[];
  contract_rate_schedule_items: RateScheduleItem[];
  invoice_lines: InvoiceLineRow[];
  transaction_rows: ValidatorTransactionDataRow[];
  transaction_rate_groups: TransactionDataRateCodeGroup[];
  transaction_invoice_groups: TransactionDataInvoiceGroup[];
  transaction_site_material_groups: TransactionDataSiteMaterialGroup[];
};

export type ValidatorReconciliationContext = {
  contract: ValidatorContractReconciliationSource;
  invoice: ValidatorInvoiceReconciliationSource;
  transaction: ValidatorTransactionReconciliationSource;
  billing_groups: ValidatorBillingGroup[];
};

export type ValidatorContractAnalysisContext = {
  document_id: string;
  analysis: ContractAnalysisResult;
  evidence_by_id: Map<string, EvidenceObject>;
};

export type ValidatorFactLookups = {
  contractProjectCodeFacts: ValidatorFactRecord[];
  invoiceProjectCodeFacts: ValidatorFactRecord[];
  contractPartyNameFacts: ValidatorFactRecord[];
  nteFact: ValidatorFactRecord | null;
  contractDocumentId: string | null;
  contractCeilingTypeFact: ValidatorFactRecord | null;
  contractCeilingType: string | null;
  rateSchedulePresentFact: ValidatorFactRecord | null;
  rateSchedulePresent: boolean | null;
  rateRowCountFact: ValidatorFactRecord | null;
  rateRowCount: number | null;
  rateSchedulePagesFact: ValidatorFactRecord | null;
  rateSchedulePagesDisplay: string | null;
  rateUnitsDetectedFact: ValidatorFactRecord | null;
  rateUnitsDetected: string[];
  timeAndMaterialsPresentFact: ValidatorFactRecord | null;
  timeAndMaterialsPresent: boolean;
  rateScheduleFacts: ValidatorFactRecord[];
  rateScheduleItems: RateScheduleItem[];
  hasRateScheduleFacts: boolean;
};

export type ProjectValidatorInput = {
  project: ValidatorProjectRow;
  documents: ValidatorDocumentRow[];
  documentRelationships: DocumentRelationshipRecord[];
  precedenceFamilies: ResolvedDocumentPrecedenceFamily[];
  familyDocumentIds: ValidatorDocumentIdsByFamily;
  governingDocumentIds: ValidatorDocumentIdsByFamily;
  ruleStateByRuleId: Map<string, ValidationRuleState>;
  factsByDocumentId: Map<string, ValidatorFactRecord[]>;
  allFacts: ValidatorFactRecord[];
  mobileTickets: MobileTicketRow[];
  loadTickets: LoadTicketRow[];
  invoices: InvoiceRow[];
  invoiceLines: InvoiceLineRow[];
  mobileToLoadsMap: Map<string, LoadTicketRow[]>;
  invoiceLineToRateMap: Map<string, RateScheduleItem | null>;
  projectTotals: ProjectTotals;
  factLookups: ValidatorFactLookups;
  contractValidationContext: ValidatorContractAnalysisContext | null;
  transactionData?: ValidatorProjectTransactionData;
  reconciliationContext?: ValidatorReconciliationContext | null;
};

export type FindingEvidenceInput = {
  evidence_type: string;
  source_document_id?: string | null;
  source_page?: number | null;
  fact_id?: string | null;
  record_id?: string | null;
  field_name?: string | null;
  field_value?: unknown;
  note?: string | null;
};

export type ValidatorFindingResult = ValidationFinding & {
  evidence: ValidationEvidence[];
};

const PARTY_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bCO\b/g, 'COMPANY'],
  [/\bCO\.\b/g, 'COMPANY'],
  [/\bCOMPANIES\b/g, 'COMPANY'],
  [/\bINCORPORATED\b/g, 'INC'],
  [/\bCORPORATION\b/g, 'CORP'],
  [/\bLIMITED\b/g, 'LTD'],
  [/\bL\.L\.C\b/g, 'LLC'],
  [/\bL L C\b/g, 'LLC'],
  [/\bAND\b/g, '&'],
];

const PARTY_SUFFIX_TOKENS = new Set([
  'INC',
  'LLC',
  'LTD',
  'CORP',
  'COMPANY',
  '&',
]);

function sortUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortUnknown(entry));
  }

  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right, 'en-US'))
        .map(([key, entry]) => [key, sortUnknown(entry)]),
    );
  }

  return value;
}

export function stringifyValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  const serialized = JSON.stringify(sortUnknown(value));
  return typeof serialized === 'string' && serialized.length > 0
    ? serialized
    : null;
}

export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const currency = normalizeCurrency(value);
    if (currency != null) return currency;

    const cleaned = value.replace(/,/g, '').trim();
    if (!cleaned) return null;

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

export function toBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;

  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', 'y', '1'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0'].includes(normalized)) return false;
  }

  return null;
}

export function normalizeCode(value: string | null | undefined): string | null {
  if (!value) return null;

  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '');

  return normalized.length > 0 ? normalized : null;
}

export function normalizePartyName(value: string | null | undefined): string | null {
  if (!value) return null;

  let normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9&\s.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  for (const [pattern, replacement] of PARTY_ABBREVIATIONS) {
    normalized = normalized.replace(pattern, replacement);
  }

  normalized = normalized
    .replace(/\bTHE\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > 0 ? normalized : null;
}

export function partiesClearlyDifferent(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const normalizedLeft = normalizePartyName(left);
  const normalizedRight = normalizePartyName(right);

  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return false;

  const leftCore = normalizedLeft
    .split(' ')
    .filter((token) => token.length > 0 && !PARTY_SUFFIX_TOKENS.has(token));
  const rightCore = normalizedRight
    .split(' ')
    .filter((token) => token.length > 0 && !PARTY_SUFFIX_TOKENS.has(token));

  if (leftCore.length === 0 || rightCore.length === 0) {
    return normalizedLeft !== normalizedRight;
  }

  if (leftCore.join(' ') === rightCore.join(' ')) return false;

  const leftInsideRight = leftCore.every((token) => rightCore.includes(token));
  const rightInsideLeft = rightCore.every((token) => leftCore.includes(token));

  return !leftInsideRight && !rightInsideLeft;
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(
    new Set(
      values
        .map((value) => value?.trim())
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );
}

export function readRowValue(
  row: StructuredRow,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    if (key in row && row[key] != null) return row[key];
  }

  return null;
}

export function readRowString(
  row: StructuredRow,
  keys: readonly string[],
): string | null {
  const value = readRowValue(row, keys);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }

  return null;
}

export function readRowNumber(
  row: StructuredRow,
  keys: readonly string[],
): number | null {
  return toNumber(readRowValue(row, keys));
}

export function collectRowIdentityKeys(
  row: StructuredRow,
  keys: readonly string[],
  options: { includeRowId?: boolean } = {},
): string[] {
  const values = uniqueStrings([
    readRowString(row, keys),
    options.includeRowId === false ? null : readRowString(row, ['id']),
  ]);

  return values.flatMap((value) => {
    const normalizedCode = normalizeCode(value);
    if (!normalizedCode || normalizedCode === value) return [value];
    return [value, normalizedCode];
  });
}

export function rowIdentifier(
  row: StructuredRow,
  preferredKeys: readonly string[],
  fallbackPrefix: string,
): string {
  return readRowString(row, preferredKeys)
    ?? readRowString(row, ['id'])
    ?? `${fallbackPrefix}:unknown`;
}

export function findFactRecords(
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
  documentIds: readonly string[],
  keys: readonly string[],
): ValidatorFactRecord[] {
  const wantedKeys = new Set(keys);
  const records: ValidatorFactRecord[] = [];

  for (const documentId of documentIds) {
    const docFacts = factsByDocumentId.get(documentId) ?? [];
    for (const fact of docFacts) {
      if (wantedKeys.has(fact.key)) {
        records.push(fact);
      }
    }
  }

  return records.sort(compareFactPriority);
}

export function findFirstFactRecord(
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
  documentIds: readonly string[],
  keys: readonly string[],
): ValidatorFactRecord | null {
  return findFactRecords(factsByDocumentId, documentIds, keys)[0] ?? null;
}

export function findFirstStringFact(
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
  documentIds: readonly string[],
  keys: readonly string[],
): string | null {
  for (const fact of findFactRecords(factsByDocumentId, documentIds, keys)) {
    const value = stringifyValue(fact.value);
    if (value) return value;
  }

  return null;
}

export function findFirstNumberFact(
  factsByDocumentId: Map<string, ValidatorFactRecord[]>,
  documentIds: readonly string[],
  keys: readonly string[],
): number | null {
  for (const fact of findFactRecords(factsByDocumentId, documentIds, keys)) {
    const value = toNumber(fact.value);
    if (value != null) return value;
  }

  return null;
}

export function isRuleEnabled(
  ruleStateByRuleId: Map<string, ValidationRuleState>,
  ruleId: string,
): boolean {
  const state = ruleStateByRuleId.get(ruleId);
  if (!state) return true;
  if (!state.enabled) return false;
  if (!state.muted_until) return true;

  return new Date(state.muted_until).getTime() <= Date.now();
}

export function resolveRuleTolerance(
  ruleStateByRuleId: Map<string, ValidationRuleState>,
  ruleId: string,
  defaultValue: number,
): number {
  const state = ruleStateByRuleId.get(ruleId);
  const override = state?.tolerance_override;

  if (typeof override === 'number' && Number.isFinite(override)) {
    return override;
  }

  if (override != null && typeof override === 'object' && !Array.isArray(override)) {
    const candidate = override as Record<string, unknown>;
    for (const key of ['value', 'tolerance', 'absolute', 'amount']) {
      const parsed = toNumber(candidate[key]);
      if (parsed != null) return parsed;
    }
  }

  return defaultValue;
}

export function makeEvidenceInput(params: FindingEvidenceInput): FindingEvidenceInput {
  return params;
}

export function structuredRowEvidenceInput(params: {
  evidenceType: string;
  row: StructuredRow;
  fieldName?: string | null;
  fieldValue?: unknown;
  note?: string | null;
}): FindingEvidenceInput {
  return {
    evidence_type: params.evidenceType,
    source_document_id:
      readRowString(params.row, ['source_document_id', 'document_id']) ?? null,
    record_id:
      readRowString(params.row, ['id', 'invoice_line_id', 'mobile_ticket_id', 'load_ticket_id'])
      ?? null,
    field_name: params.fieldName ?? null,
    field_value: params.fieldValue,
    note: params.note ?? null,
  };
}

export function makeFinding(params: {
  projectId: string;
  ruleId: string;
  category: ValidationCategory;
  severity: ValidationSeverity;
  subjectType: string;
  subjectId: string;
  status?: ValidationFinding['status'];
  field?: string | null;
  expected?: unknown;
  actual?: unknown;
  variance?: number | null;
  varianceUnit?: string | null;
  blockedReason?: string | null;
  decisionEligible?: boolean;
  actionEligible?: boolean;
  evidence?: FindingEvidenceInput[];
}): ValidatorFindingResult {
  const checkKey = `${params.ruleId}:${params.subjectId}`;
  const id = [checkKey, params.field ?? null]
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
    .join(':');

  const evidence = (params.evidence ?? []).map((entry, index) => ({
    id: `${id}:evidence:${index + 1}`,
    finding_id: id,
    evidence_type: entry.evidence_type,
    source_document_id: entry.source_document_id ?? null,
    source_page: entry.source_page ?? null,
    fact_id: entry.fact_id ?? null,
    record_id: entry.record_id ?? null,
    field_name: entry.field_name ?? null,
    field_value: stringifyValue(entry.field_value),
    note: entry.note ?? null,
    created_at: PURE_VALIDATOR_TIMESTAMP,
  }));

  return {
    id,
    run_id: PURE_VALIDATOR_RUN_ID,
    project_id: params.projectId,
    rule_id: params.ruleId,
    check_key: checkKey,
    category: params.category,
    severity: params.severity,
    status: params.status ?? 'open',
    subject_type: params.subjectType,
    subject_id: params.subjectId,
    field: params.field ?? null,
    expected: stringifyValue(params.expected),
    actual: stringifyValue(params.actual),
    variance: params.variance ?? null,
    variance_unit: params.varianceUnit ?? null,
    blocked_reason: params.blockedReason ?? null,
    decision_eligible: params.decisionEligible ?? false,
    action_eligible: params.actionEligible ?? false,
    linked_decision_id: null,
    linked_action_id: null,
    resolved_by_user_id: null,
    resolved_at: null,
    created_at: PURE_VALIDATOR_TIMESTAMP,
    updated_at: PURE_VALIDATOR_TIMESTAMP,
    evidence,
  };
}

export function blockingReasons(findings: readonly ValidationFinding[]): string[] {
  return uniqueStrings(
    findings
      .filter((finding) => finding.category === 'required_sources')
      .map((finding) => finding.blocked_reason),
  );
}

export function hasBlockingFindings(findings: readonly ValidationFinding[]): boolean {
  return blockingReasons(findings).length > 0;
}

export function sortFindings<T extends ValidationFinding>(findings: readonly T[]): T[] {
  const severityRank: Record<ValidationSeverity, number> = {
    critical: 0,
    warning: 1,
    info: 2,
  };

  const categoryRank: Record<ValidationCategory, number> = {
    required_sources: 0,
    identity_consistency: 1,
    financial_integrity: 2,
    ticket_integrity: 3,
  };

  return [...findings].sort((left, right) => {
    const categoryDelta = categoryRank[left.category] - categoryRank[right.category];
    if (categoryDelta !== 0) return categoryDelta;

    const severityDelta = severityRank[left.severity] - severityRank[right.severity];
    if (severityDelta !== 0) return severityDelta;

    const ruleDelta = left.rule_id.localeCompare(right.rule_id, 'en-US');
    if (ruleDelta !== 0) return ruleDelta;

    return left.subject_id.localeCompare(right.subject_id, 'en-US');
  });
}

const FINDING_FACT_KEYS_BY_RULE_ID: Record<string, string[]> = {
  FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED: ['rate_schedule_present'],
  FINANCIAL_RATE_BASED_ROWS_REQUIRED: ['rate_row_count'],
  FINANCIAL_RATE_BASED_PAGES_REQUIRED: ['rate_schedule_pages'],
  FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR: [
    'rate_schedule_present',
    'pricing_applicability',
    'disposal_fee_treatment',
    'fema_eligibility_gate',
  ],
  FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE: [
    'rate_units_detected',
    'time_and_materials_present',
  ],
  FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED: [
    'activation_trigger_type',
    'authorization_required',
    'performance_start_basis',
  ],
  FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT: [
    'rate_code',
    'rate_table',
    'hauling_rates',
    'tipping_fees',
  ],
  FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE: [
    'rate_code',
    'unit_price',
    'rate_table',
    'hauling_rates',
    'tipping_fees',
  ],
  FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR: [
    'contractor_name',
    'vendor_name',
  ],
  FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT: [
    'owner_name',
    'client_name',
    'bill_to_name',
  ],
  FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON: [
    'owner_name',
    'client_name',
    'bill_to_name',
  ],
  FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM: [
    'period_start',
    'period_end',
    'term_start_date',
    'term_end_date',
    'effective_date',
    'expiration_date',
  ],
  FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING: [
    'period_start',
    'period_end',
  ],
  FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS: [
    'line_total',
    'total_amount',
    'invoice_total',
    'billed_amount',
  ],
  INVOICE_DUPLICATE_BILLED_LINE: ['invoice_number', 'rate_code', 'line_total'],
  INVOICE_LINE_REQUIRES_BILLING_KEY: ['invoice_number', 'rate_code', 'description', 'line_total'],
  FINANCIAL_NTE_FACT_MISSING: ['nte_amount', 'contract_ceiling'],
  FINANCIAL_NTE_EXCEEDED: ['billed_total', 'nte_amount', 'contract_ceiling'],
  FINANCIAL_NTE_APPROACHING: ['billed_total', 'nte_amount', 'contract_ceiling'],
  SOURCES_NO_CONTRACT: ['contract_document'],
  SOURCES_NO_RATE_SCHEDULE: ['rate_schedule'],
  SOURCES_NO_TICKET_DATA: ['ticket_data', 'transaction_data'],
};

const FINDING_MESSAGE_BY_RULE_ID: Record<string, string> = {
  FINANCIAL_RATE_BASED_SCHEDULE_REQUIRED: 'Rate-based contract has no valid rate schedule',
  FINANCIAL_RATE_BASED_ROWS_REQUIRED:
    'Rate schedule present but insufficient rows to support operations',
  FINANCIAL_RATE_BASED_PAGES_REQUIRED:
    'Rate schedule pages could not be confidently identified',
  FINANCIAL_RATE_BASED_PRICING_APPLICABILITY_UNCLEAR:
    'Pricing schedule present but applicability is unresolved',
  FINANCIAL_RATE_BASED_UNIT_COVERAGE_INCOMPLETE:
    'Rate schedule detected but unit coverage may be incomplete',
  FINANCIAL_RATE_BASED_ACTIVATION_GATE_UNRESOLVED:
    'Activation trigger detected but status unresolved',
  FINANCIAL_INVOICE_LINE_CODE_EXISTS_IN_CONTRACT:
    'Invoice line code is not found in governing contract schedule',
  FINANCIAL_INVOICE_UNIT_PRICE_MATCHES_CONTRACT_RATE:
    'Invoice unit price does not match governing contract rate',
  FINANCIAL_INVOICE_VENDOR_MATCHES_CONTRACT_CONTRACTOR:
    'Invoice vendor does not match contract contractor',
  FINANCIAL_INVOICE_CLIENT_MATCHES_CONTRACT_CLIENT:
    'Invoice client does not match governing contract client',
  FINANCIAL_INVOICE_CLIENT_MISSING_FOR_CONTRACT_COMPARISON:
    'Invoice client could not be extracted for governing contract comparison',
  FINANCIAL_INVOICE_SERVICE_PERIOD_WITHIN_CONTRACT_TERM:
    'Invoice service period falls outside governing contract term',
  FINANCIAL_INVOICE_SERVICE_PERIOD_MISSING:
    'Invoice service period could not be extracted for governing contract comparison',
  FINANCIAL_INVOICE_TOTAL_RECONCILES_TO_LINE_ITEMS:
    'Invoice totals do not reconcile to billed line items',
  INVOICE_DUPLICATE_BILLED_LINE:
    'Duplicate billed line appears more than once on the invoice',
  INVOICE_LINE_REQUIRES_BILLING_KEY:
    'Invoice line is missing the billing key required for validation',
};

function humanizeRuleId(ruleId: string): string {
  return ruleId
    .toLowerCase()
    .split(/[_:]+/g)
    .filter((token) => token.length > 0)
    .map((token, index) => (
      index === 0 ? token[0]?.toUpperCase() + token.slice(1) : token
    ))
    .join(' ');
}

export function messageForFinding(finding: ValidationFinding): string {
  const explicit = FINDING_MESSAGE_BY_RULE_ID[finding.rule_id];
  if (explicit) return explicit;

  if (finding.blocked_reason) return finding.blocked_reason;

  if (finding.field && finding.expected && finding.actual) {
    return `${finding.field} expected ${finding.expected} but found ${finding.actual}`;
  }

  if (finding.field && finding.actual) {
    return `${finding.field} found ${finding.actual}`;
  }

  if (finding.field && finding.expected) {
    return `${finding.field} expected ${finding.expected}`;
  }

  return humanizeRuleId(finding.rule_id);
}

export function factKeysForFinding(finding: ValidationFinding): string[] {
  const explicit = FINDING_FACT_KEYS_BY_RULE_ID[finding.rule_id];
  if (explicit) return explicit;

  return finding.field ? [finding.field] : [];
}

export function toValidatorSummaryItem(
  finding: ValidationFinding,
): ValidatorSummaryItem {
  return {
    rule_id: finding.rule_id,
    severity: finding.severity,
    subject_type: finding.subject_type,
    subject_id: finding.subject_id,
    field: finding.field,
    fact_keys: factKeysForFinding(finding),
    message: messageForFinding(finding),
  };
}

export function deriveValidatorStatus(
  findings: readonly ValidationFinding[],
): ValidatorStatus {
  const openFindings = findings.filter((finding) => finding.status === 'open');
  if (openFindings.some((finding) => finding.severity === 'critical')) {
    return 'BLOCKED';
  }
  if (openFindings.length === 0) {
    return 'READY';
  }
  return 'NEEDS_REVIEW';
}

export function buildValidationSummary(
  findings: readonly ValidationFinding[],
  status: ValidationStatus,
  options: {
    contractInvoiceReconciliation?: ContractInvoiceReconciliationSummary | null;
    invoiceTransactionReconciliation?: InvoiceTransactionReconciliationSummary | null;
    reconciliation?: ProjectReconciliationSummary | null;
    exposure?: ProjectExposureSummary | null;
    nte_amount?: number | null;
    total_billed?: number | null;
  } = {},
): ValidationSummary {
  const criticalCount = findings.filter((finding) => finding.severity === 'critical').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const infoCount = findings.filter((finding) => finding.severity === 'info').length;
  const openFindings = findings.filter((finding) => finding.status === 'open');
  const validatorOpenItems = openFindings.map(toValidatorSummaryItem);
  const validatorBlockers = openFindings
    .filter((finding) => finding.severity === 'critical')
    .map(toValidatorSummaryItem);

  return {
    status,
    last_run_at: null,
    critical_count: criticalCount,
    warning_count: warningCount,
    info_count: infoCount,
    open_count: openFindings.length,
    blocked_reasons: blockingReasons(findings),
    trigger_source: null,
    validator_status: deriveValidatorStatus(findings),
    validator_open_items: validatorOpenItems,
    validator_blockers: validatorBlockers,
    contract_invoice_reconciliation:
      options.contractInvoiceReconciliation ?? null,
    invoice_transaction_reconciliation:
      options.invoiceTransactionReconciliation ?? null,
    reconciliation:
      options.reconciliation ?? null,
    exposure:
      options.exposure ?? null,
    nte_amount: options.nte_amount ?? null,
    total_billed: options.total_billed ?? null,
    requires_verification_amount:
      options.exposure?.total_requires_verification_amount ?? null,
  };
}

function compareFactPriority(left: ValidatorFactRecord, right: ValidatorFactRecord): number {
  const priority: Record<ValidatorFactSource, number> = {
    normalized_row: 0,
    legacy_structured_field: 1,
    legacy_typed_field: 2,
    legacy_section_signal: 3,
  };

  const priorityDelta = priority[left.source] - priority[right.source];
  if (priorityDelta !== 0) return priorityDelta;

  return left.key.localeCompare(right.key, 'en-US');
}

export function normalizeLooseText(value: string | null | undefined): string | null {
  return normalizeString(value)?.toUpperCase() ?? null;
}
