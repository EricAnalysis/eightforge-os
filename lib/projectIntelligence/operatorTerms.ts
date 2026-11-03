/**
 * How internal project-intelligence values are put to an operator: the one place that
 * says it. It only changes wording in a copy: canonical values, stored records, citations
 * and telemetry keep their codes. A token it does not know stays as it is, so an answer
 * repeating one is still rejected by validation and the operator gets the deterministic
 * answer. Ids, titles, names, numbers and dates are never rewritten, because a value like
 * `TKT_001` could be real data.
 */

/** Values that are only ever system enums. Underscores become spaces. */
const ENUM_VALUE_KEYS: ReadonlySet<string> = new Set(['field', 'fieldKey', 'type', 'family', 'subtype', 'reason', 'reading', 'projectState', 'authorityStatus', 'sourceKind', 'validationStatus']);

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

/** `attached_to` to "attached to", `reference_only` to "reference only", `rate_sheet` to "rate sheet". */
export function operatorTermForEnum(value: string): string {
  return withoutPlatformWord(value.replace(/_/gu, ' '));
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
