export type EffectiveFactSource =
  | 'human_override'
  | 'human_review'
  | 'canonical_correction'
  | 'canonical_contract_intelligence'
  | 'normalized_row'
  | 'legacy_structured_field'
  | 'legacy_typed_field'
  | 'legacy_section_signal'
  | string;

export type EffectiveFactRecord = {
  document_id: string;
  key: string;
  value: unknown;
  source: EffectiveFactSource;
  evidence?: unknown[];
};

const SOURCE_PRIORITY: Record<string, number> = {
  human_override: 0,
  human_review: 1,
  canonical_correction: 2,
  canonical_contract_intelligence: 3,
  normalized_row: 4,
  legacy_structured_field: 5,
  legacy_typed_field: 6,
  legacy_section_signal: 7,
};

const ARRAY_FACT_KEYS = new Set([
  'rate_table',
  'hauling_rates',
  'tipping_fees',
  'invoice_lines',
  'invoice_line_items',
  'line_items',
  'pricing_rows',
]);

const FIELD_KEY_ALIASES: Record<string, string> = {
  vendor_name: 'contractor_name',
  contractor: 'contractor_name',
  current_amount_due: 'billed_amount',
  current_payment_due: 'billed_amount',
  total_amount: 'billed_amount',
  invoice_total: 'billed_amount',
  amount_due: 'billed_amount',
  lineitems: 'invoice_line_items',
  invoice_lines: 'invoice_line_items',
  line_items: 'invoice_line_items',
  service_period_start: 'period_start',
  service_period_end: 'period_end',
  period_start_date: 'period_start',
  period_end_date: 'period_end',
  rate_section_present: 'rate_schedule_present',
  unit_price_structure_present: 'rate_schedule_present',
  rate_section_pages: 'rate_schedule_pages',
  rate_items_detected: 'rate_row_count',
};

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(row: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return null;
}

function normalizeIdentityText(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return normalized.length > 0 ? normalized : null;
}

export function canonicalEffectiveFactKey(fieldKey: string): string {
  const normalized = toSnakeCase(fieldKey);
  return FIELD_KEY_ALIASES[normalized] ?? normalized;
}

export function effectiveFactPriority(source: EffectiveFactSource): number {
  return SOURCE_PRIORITY[source] ?? 99;
}

export function compareEffectiveFactPriority(
  left: Pick<EffectiveFactRecord, 'source' | 'key'>,
  right: Pick<EffectiveFactRecord, 'source' | 'key'>,
): number {
  const sourceDelta = effectiveFactPriority(left.source) - effectiveFactPriority(right.source);
  if (sourceDelta !== 0) return sourceDelta;
  return canonicalEffectiveFactKey(left.key).localeCompare(canonicalEffectiveFactKey(right.key), 'en-US');
}

function rowIdentityForArrayFact(
  factKey: string,
  documentId: string,
  row: Record<string, unknown>,
  index: number,
): string {
  const key = canonicalEffectiveFactKey(factKey);
  if (key === 'rate_table' || key === 'hauling_rates' || key === 'tipping_fees' || key === 'pricing_rows') {
    const rateCode = normalizeIdentityText(readString(row, ['rate_code', 'code', 'item_code', 'service_code']));
    const description = normalizeIdentityText(readString(row, ['description', 'rate_description', 'item_description', 'name', 'item', 'rate_raw']));
    if (rateCode && description) return `${documentId}:rate:${rateCode}:${description}`;
    if (rateCode) return `${documentId}:rate:${rateCode}`;
  }

  const invoiceNumber = normalizeIdentityText(readString(row, ['invoice_number', 'invoice_no', 'number']));
  const lineNumber = normalizeIdentityText(readString(row, ['line_number', 'line_no', 'line_id', 'invoice_line_id', 'id']));
  if (invoiceNumber && lineNumber) return `${documentId}:invoice-line:${invoiceNumber}:${lineNumber}`;

  const rateCode = normalizeIdentityText(readString(row, ['rate_code', 'contract_rate_code', 'item_code', 'service_code', 'line_code']));
  const description = normalizeIdentityText(readString(row, ['description', 'rate_description', 'item_description', 'line_description', 'service_item', 'name', 'item']));
  if (rateCode && description) return `${documentId}:invoice-line:${invoiceNumber ?? 'unknown'}:${rateCode}:${description}`;
  if (rateCode) return `${documentId}:invoice-line:${invoiceNumber ?? 'unknown'}:${rateCode}`;

  return `${documentId}:${key}:row:${index + 1}`;
}

function isArrayFact(key: string, value: unknown): value is unknown[] {
  return Array.isArray(value) && ARRAY_FACT_KEYS.has(canonicalEffectiveFactKey(key));
}

function collapseArrayFacts<T extends EffectiveFactRecord>(facts: readonly T[]): T {
  const sorted = [...facts].sort(compareEffectiveFactPriority);
  const byIdentity = new Map<string, unknown>();

  for (const fact of sorted) {
    if (!Array.isArray(fact.value)) continue;
    fact.value.forEach((entry, index) => {
      const record = asRecord(entry);
      const identity = record
        ? rowIdentityForArrayFact(fact.key, fact.document_id, record, index)
        : `${fact.document_id}:${canonicalEffectiveFactKey(fact.key)}:scalar:${index + 1}`;
      if (!byIdentity.has(identity)) byIdentity.set(identity, entry);
    });
  }

  const base = sorted[0];
  return {
    ...base,
    key: canonicalEffectiveFactKey(base.key),
    value: [...byIdentity.values()],
    evidence: sorted.flatMap((fact) => fact.evidence ?? []),
  } as T;
}

export function collapseEffectiveFactRecords<T extends EffectiveFactRecord>(
  facts: readonly T[],
): T[] {
  const grouped = new Map<string, T[]>();
  for (const fact of facts) {
    const key = `${fact.document_id}:${canonicalEffectiveFactKey(fact.key)}`;
    const current = grouped.get(key) ?? [];
    current.push(fact);
    grouped.set(key, current);
  }

  return [...grouped.values()].map((group) => {
    if (group.some((fact) => isArrayFact(fact.key, fact.value))) {
      return collapseArrayFacts(group);
    }

    const [winner] = [...group].sort(compareEffectiveFactPriority);
    return {
      ...winner,
      key: canonicalEffectiveFactKey(winner.key),
    } as T;
  });
}
