/**
 * How internal project-intelligence values are put to an operator: the one place that
 * says it. It only changes wording in a copy: canonical values, stored records, citations
 * and telemetry keep their codes. The lists are closed. A value they do not name stays
 * byte for byte, so an answer repeating it is still rejected by validation and the operator
 * gets the deterministic answer. Ids, titles, names, numbers and dates are never rewritten,
 * because a value like `TKT_001` could be real data.
 */

/** Values that are only ever system enums. */
const ENUM_VALUE_KEYS: ReadonlySet<string> = new Set(['field', 'fieldKey', 'type', 'family', 'subtype', 'reason', 'reading', 'projectState', 'authorityStatus', 'sourceKind', 'validationStatus']);

const ENUM_TERMS: Readonly<Record<string, string>> = Object.freeze({
  FINDINGS_OPEN: 'findings open',
  at_risk_amount: 'at-risk amount',
  attached_to: 'attached to',
  authored_unverified: 'not source-verified',
  base_contract: 'base contract',
  billing_rate_key: 'billing rate',
  canonical_category: 'category',
  contract_ceiling_type: 'contract ceiling type',
  contract_document: 'contract document',
  document_extraction: 'read from the document',
  evidence_unavailable: 'evidence unavailable',
  extended_cost: 'extended cost',
  findings_open: 'findings open',
  invoice_data: 'invoice data',
  likely_system_issue: 'likely system issue',
  no_open_findings: 'no open findings',
  not_a_source_gap: 'not a source gap',
  nte_amount: 'not-to-exceed amount',
  pricing_applicability: 'pricing applicability',
  pricing_schedule: 'pricing schedule',
  rate_row_count: 'rate row count',
  rate_schedule_pages: 'rate schedule pages',
  rate_schedule_present: 'rate schedule present',
  rate_sheet: 'rate sheet',
  reference_only: 'reference only',
  role_priority: 'role priority',
  source_missing: 'source missing',
  source_present: 'source present',
  source_present_relationship_unresolved: 'source present, relationship unresolved',
  source_present_unread: 'source present, not read',
  supported_amount: 'supported amount',
  ticket_data: 'ticket data',
  ticket_support: 'ticket support',
  total_at_risk_amount: 'total at-risk amount',
  total_fully_reconciled_amount: 'total fully reconciled amount',
  transaction_data: 'transaction data',
  transaction_quantity: 'transaction quantity',
  upload_recency_fallback: 'most recent upload',
  validation_not_run: 'validation not run',
});

/** Text the system wrote, not a person or a source document. Only the closed list below changes in it. */
const SYSTEM_TEXT_KEYS: ReadonlySet<string> = new Set(['description', 'expected', 'actual', 'snippet', 'whatItChecks', 'requiredAction']);

const SYSTEM_TERMS: ReadonlyArray<readonly [RegExp, string]> = Object.freeze(([
  ['canonical contract truth', 'contract record'],
  ['contract truth', 'contract record'],
  ['extended_cost', 'extended cost'],
  ['transaction_quantity', 'transaction quantity'],
  ['mobile_tickets', 'mobile tickets'],
  ['load_tickets', 'load tickets'],
  ['transaction_data', 'transaction data'],
  ['requires_activation_scope_or_eligibility_resolution', 'scope or eligibility not yet decided'],
] as const).map(([term, words]) => [new RegExp(`\\b${term}\\b`, 'gu'), words] as const));

const withoutPlatformWord = (text: string) => text.replace(/\bcanonical\b\s*/giu, '').trim();

/** `attached_to` to "attached to", `rate_sheet` to "rate sheet", and an unknown value to itself. */
export function operatorTermForEnum(value: string): string {
  return ENUM_TERMS[value] ?? value;
}

export function operatorTextForSystemText(text: string): string {
  return withoutPlatformWord(SYSTEM_TERMS.reduce((rest, [term, words]) => rest.replace(term, words), text));
}

/** A copy of a payload in operator terms, chosen by what each value is, never by what it says. */
export function operatorPresentation(value: unknown, key: string | null = null): unknown {
  if (Array.isArray(value)) return value.map((entry) => operatorPresentation(entry, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([entryKey, entry]) => [entryKey, operatorPresentation(entry, entryKey)]));
  }
  if (typeof value !== 'string' || key == null) return value;
  if (ENUM_VALUE_KEYS.has(key)) return operatorTermForEnum(value);
  if (SYSTEM_TEXT_KEYS.has(key)) return operatorTextForSystemText(value);
  return value;
}
