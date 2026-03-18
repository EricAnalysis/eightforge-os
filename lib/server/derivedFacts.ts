// lib/server/derivedFacts.ts
// Deterministic derived facts computed from document_extractions rows.
// Merged into the facts map so the existing rule engine can reference them
// via condition_json (e.g. field_key: 'derived_duplicate_ticket_number').
// No new tables; TypeScript only.

import type { Facts } from '@/lib/types/rules';
import type { ExtractionRowForFacts } from '@/lib/server/documentExtractions';

// ---------------------------------------------------------------------------
// Required fields per (domain, document_type) for derived_missing_required_count.
// Avoids new tables; extend this map as document types are added.
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS_BY_TYPE: Record<string, string[]> = {
  'debris_ops|invoice': ['invoice_number', 'vendor_name'],
  'debris_ops|haul_ticket': ['ticket_number', 'disposal_site'],
  'debris_ops|ticket_export': ['transaction_id', 'invoice_number'],
  'debris_ops|project_contract': ['approved_disposal_site', 'expiration_date'],
  'debris_ops|rate_table': [],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function key(domain: string, documentType: string): string {
  return `${domain}|${documentType}`;
}

function textValue(row: ExtractionRowForFacts): string | null {
  if (row.field_value_text != null && row.field_value_text !== '') {
    return String(row.field_value_text).trim();
  }
  return null;
}

/** Collect all values for a given field_key across rows (for duplicate detection). */
function valuesForField(
  rows: ExtractionRowForFacts[],
  fieldKey: string,
): (string | number)[] {
  const out: (string | number)[] = [];
  for (const row of rows) {
    if (row.field_key !== fieldKey) continue;
    if (row.field_value_number != null) {
      out.push(Number(row.field_value_number));
    } else if (row.field_value_text != null) {
      out.push(String(row.field_value_text).trim());
    } else if (row.field_value_date != null) {
      out.push(String(row.field_value_date));
    } else if (row.field_value_boolean != null) {
      out.push(row.field_value_boolean ? 1 : 0);
    }
  }
  return out;
}

/** Count rows with the given field_key (for multi-row ticket detection). */
function rowCountForField(rows: ExtractionRowForFacts[], fieldKey: string): number {
  return rows.filter((r) => r.field_key === fieldKey).length;
}

// ---------------------------------------------------------------------------
// Derived fact keys (stable names for rules)
// ---------------------------------------------------------------------------

export const DERIVED_KEYS = {
  duplicate_ticket_number: 'derived_duplicate_ticket_number',
  duplicate_transaction_number: 'derived_duplicate_transaction_number',
  ticket_row_count: 'derived_ticket_row_count',
  multi_row_ticket: 'derived_multi_row_ticket',
  missing_required_count: 'derived_missing_required_count',
} as const;

function parseErrorKeyNumeric(fieldKey: string): string {
  return `derived_parse_error_numeric_${fieldKey}`;
}

function parseErrorKeyDate(fieldKey: string): string {
  return `derived_parse_error_date_${fieldKey}`;
}

// ---------------------------------------------------------------------------
// Main API
// ---------------------------------------------------------------------------

export type ComputeDerivedFactsParams = {
  rows: ExtractionRowForFacts[];
  facts: Facts;
  domain: string;
  documentType: string;
};

/**
 * Compute derived facts from extraction rows and current facts.
 * Returns only the derived key→value map; caller merges into facts.
 * Deterministic; no I/O.
 */
export function computeDerivedFacts(params: ComputeDerivedFactsParams): Facts {
  const { rows, facts, domain, documentType } = params;
  const derived: Facts = {};

  // ----- Duplicate ticket number -----
  const ticketValues = valuesForField(rows, 'ticket_number');
  const ticketDupes = ticketValues.length > 1 && new Set(ticketValues).size < ticketValues.length;
  derived[DERIVED_KEYS.duplicate_ticket_number] = ticketDupes;

  // ----- Duplicate transaction number -----
  const txnValues = valuesForField(rows, 'transaction_number');
  const txnDupes = txnValues.length > 1 && new Set(txnValues).size < txnValues.length;
  derived[DERIVED_KEYS.duplicate_transaction_number] = txnDupes;

  // ----- Multi-row ticket detection -----
  const ticketRowCount = rowCountForField(rows, 'ticket_number');
  derived[DERIVED_KEYS.ticket_row_count] = ticketRowCount;
  derived[DERIVED_KEYS.multi_row_ticket] = ticketRowCount > 1;

  // ----- Missing required field count -----
  const requiredKeys = REQUIRED_FIELDS_BY_TYPE[key(domain, documentType)];
  if (requiredKeys && requiredKeys.length > 0) {
    let missing = 0;
    for (const k of requiredKeys) {
      const v = facts[k];
      if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) {
        missing += 1;
      }
    }
    derived[DERIVED_KEYS.missing_required_count] = missing;
  } else {
    derived[DERIVED_KEYS.missing_required_count] = 0;
  }

  // ----- Numeric parse error flags -----
  for (const row of rows) {
    if (row.field_type !== 'number') continue;
    const hasNumeric =
      row.field_value_number != null && !Number.isNaN(Number(row.field_value_number));
    const hasText = textValue(row) !== null;
    if (hasText && !hasNumeric) {
      derived[parseErrorKeyNumeric(row.field_key)] = true;
    }
  }

  // ----- Date parse error flags -----
  for (const row of rows) {
    if (row.field_type !== 'date') continue;
    const hasDate = row.field_value_date != null && String(row.field_value_date).trim() !== '';
    const hasText = textValue(row) !== null;
    if (hasText && !hasDate) {
      derived[parseErrorKeyDate(row.field_key)] = true;
    }
  }

  return derived;
}
