// lib/server/documentExtractions.ts
// Safe extraction persistence helper for normalized fact rows.
// Supports the deterministic rule engine without breaking existing blob-oriented
// document_extractions usage (data jsonb, payload jsonb).
//
// Production schema columns used:
//   id, document_id, organization_id, data, status, confidence, source,
//   field_key, field_value_text, field_value_number, field_value_date,
//   field_value_boolean, field_type, created_by

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import type { Facts } from '@/lib/types/rules';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExtractionFactInput = {
  document_id: string;
  organization_id?: string;
  field_key: string;
  field_type: 'text' | 'number' | 'date' | 'boolean';
  value: string | number | boolean | Date | null;
  source?: string;
  confidence?: number;
  data?: Record<string, unknown>;
  created_by?: string;
};

type ExtractionRow = {
  document_id: string;
  organization_id: string | null;
  field_key: string;
  field_type: string;
  field_value_text: string | null;
  field_value_number: number | null;
  field_value_date: string | null;
  field_value_boolean: boolean | null;
  source: string | null;
  confidence: number | null;
  status: string;
  data: Record<string, unknown> | null;
  created_by: string | null;
};

// ---------------------------------------------------------------------------
// Value Normalization
// ---------------------------------------------------------------------------

function normalizeToRow(input: ExtractionFactInput, orgId: string | null): ExtractionRow {
  const row: ExtractionRow = {
    document_id: input.document_id,
    organization_id: input.organization_id ?? orgId,
    field_key: input.field_key,
    field_type: input.field_type,
    field_value_text: null,
    field_value_number: null,
    field_value_date: null,
    field_value_boolean: null,
    source: input.source ?? null,
    confidence: input.confidence ?? null,
    status: 'active',
    data: input.data ?? null,
    created_by: input.created_by ?? null,
  };

  if (input.value === null || input.value === undefined) return row;

  switch (input.field_type) {
    case 'text':
      row.field_value_text = String(input.value);
      break;
    case 'number':
      row.field_value_number = typeof input.value === 'number' ? input.value : Number(input.value);
      break;
    case 'date':
      row.field_value_date =
        input.value instanceof Date
          ? input.value.toISOString().split('T')[0]
          : String(input.value);
      break;
    case 'boolean':
      row.field_value_boolean = Boolean(input.value);
      break;
  }

  return row;
}

// ---------------------------------------------------------------------------
// Org Lookup (backfill from document if not supplied)
// ---------------------------------------------------------------------------

async function resolveOrgId(documentId: string): Promise<string | null> {
  const admin = getSupabaseAdmin();
  if (!admin) return null;

  const { data } = await admin
    .from('documents')
    .select('organization_id')
    .eq('id', documentId)
    .single();

  return (data as { organization_id?: string } | null)?.organization_id ?? null;
}

// ---------------------------------------------------------------------------
// Upsert Helpers
// ---------------------------------------------------------------------------

/**
 * Upsert a single extraction fact row.
 * If a row with the same document_id + field_key already exists and is active,
 * it will be soft-deactivated and a new row inserted.
 */
export async function upsertExtractionFact(input: ExtractionFactInput): Promise<boolean> {
  const admin = getSupabaseAdmin();
  if (!admin) return false;

  const orgId = input.organization_id ?? (await resolveOrgId(input.document_id));
  const row = normalizeToRow(input, orgId);

  // Soft-deactivate existing active fact for this field
  await admin
    .from('document_extractions')
    .update({ status: 'superseded' })
    .eq('document_id', input.document_id)
    .eq('field_key', input.field_key)
    .eq('status', 'active');

  const { error } = await admin
    .from('document_extractions')
    .insert(row);

  if (error) {
    console.error('[documentExtractions] upsert error:', error);
    return false;
  }

  return true;
}

/**
 * Upsert many extraction fact rows for a single document.
 * Deactivates all existing active fact-rows for this document first,
 * then inserts the new set. Does NOT touch legacy blob rows (field_key IS NULL).
 */
export async function upsertManyExtractionFacts(
  documentId: string,
  facts: ExtractionFactInput[],
): Promise<{ inserted: number; errors: number }> {
  const admin = getSupabaseAdmin();
  if (!admin) return { inserted: 0, errors: 0 };

  if (facts.length === 0) return { inserted: 0, errors: 0 };

  const orgId = facts[0].organization_id ?? (await resolveOrgId(documentId));

  // Soft-deactivate all existing active fact rows (not legacy blob rows)
  await admin
    .from('document_extractions')
    .update({ status: 'superseded' })
    .eq('document_id', documentId)
    .eq('status', 'active')
    .not('field_key', 'is', null);

  const rows = facts.map((f) => normalizeToRow({ ...f, document_id: documentId }, orgId));

  const { error } = await admin
    .from('document_extractions')
    .insert(rows);

  if (error) {
    console.error('[documentExtractions] upsertMany error:', error);
    return { inserted: 0, errors: rows.length };
  }

  return { inserted: rows.length, errors: 0 };
}

// ---------------------------------------------------------------------------
// Facts Conversion (single source of truth for rule engine)
// ---------------------------------------------------------------------------

/**
 * Load active extraction rows for a document and convert to a Facts map.
 *
 * Value priority (highest wins, regardless of field_type label):
 *   1. field_value_number  — if non-null, use it
 *   2. field_value_boolean — if non-null, use it
 *   3. field_value_date    — if non-null, use it as Date
 *   4. field_value_text    — fallback
 *
 * This priority order ensures that a row stored with a numeric value is
 * always read back as a number even if field_type metadata is wrong.
 */
export async function loadFactsFromExtractions(documentId: string): Promise<Facts> {
  const admin = getSupabaseAdmin();
  if (!admin) return {};

  const { data, error } = await admin
    .from('document_extractions')
    .select(
      'field_key, field_value_text, field_value_number, field_value_date, field_value_boolean, field_type',
    )
    .eq('document_id', documentId)
    .eq('status', 'active')
    .not('field_key', 'is', null);

  if (error || !data) return {};

  const facts: Facts = {};

  for (const row of data) {
    const key = row.field_key as string;
    if (!key) continue;

    // Prefer typed columns in priority order, fall back to text
    if (row.field_value_number != null) {
      facts[key] = Number(row.field_value_number);
    } else if (row.field_value_boolean != null) {
      facts[key] = Boolean(row.field_value_boolean);
    } else if (row.field_value_date != null) {
      facts[key] = new Date(row.field_value_date as string);
    } else if (row.field_value_text != null) {
      facts[key] = row.field_value_text as string;
    } else {
      facts[key] = null;
    }
  }

  return facts;
}
