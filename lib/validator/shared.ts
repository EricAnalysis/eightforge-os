import type {
  DocumentRelationshipRecord,
  ResolvedDocumentPrecedenceFamily,
} from '@/lib/documentPrecedence';
import {
  normalizeCurrency,
  normalizeString,
} from '@/lib/validation/normalizeValidationValues';
import type {
  ValidationEvidence,
  ValidationFinding,
  ValidationRuleState,
  ValidationSummary,
  ValidationCategory,
  ValidationSeverity,
  ValidationStatus,
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

export type RateScheduleItem = {
  source_document_id: string;
  record_id: string;
  rate_code: string | null;
  unit_type: string | null;
  rate_amount: number | null;
  material_type: string | null;
  description: string | null;
  raw_value: unknown;
};

export type ProjectTotals = {
  billed_total: number | null;
  invoice_count: number;
  invoice_line_count: number;
  mobile_ticket_count: number;
  load_ticket_count: number;
};

export type ValidatorFactLookups = {
  contractProjectCodeFacts: ValidatorFactRecord[];
  invoiceProjectCodeFacts: ValidatorFactRecord[];
  contractPartyNameFacts: ValidatorFactRecord[];
  nteFact: ValidatorFactRecord | null;
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

export function buildValidationSummary(
  findings: readonly ValidationFinding[],
  status: ValidationStatus,
): ValidationSummary {
  const criticalCount = findings.filter((finding) => finding.severity === 'critical').length;
  const warningCount = findings.filter((finding) => finding.severity === 'warning').length;
  const infoCount = findings.filter((finding) => finding.severity === 'info').length;

  return {
    status,
    last_run_at: null,
    critical_count: criticalCount,
    warning_count: warningCount,
    info_count: infoCount,
    open_count: findings.filter((finding) => finding.status === 'open').length,
    blocked_reasons: blockingReasons(findings),
    trigger_source: null,
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
