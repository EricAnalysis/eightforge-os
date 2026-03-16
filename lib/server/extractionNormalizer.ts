// lib/server/extractionNormalizer.ts
// Bridge between blob-style document extractions (ExtractionPayload) and
// normalized field_key rows used by the deterministic rule engine.
//
// Called after processDocument inserts a blob extraction to populate
// the field_key-based rows that loadFactsFromExtractions() depends on.

import type { ExtractionFactInput } from '@/lib/server/documentExtractions';
import { upsertManyExtractionFacts } from '@/lib/server/documentExtractions';

type TypedFields = Record<string, unknown>;

type ExtractionBlob = {
  fields?: {
    typed_fields?: TypedFields | null;
    detected_document_type?: string | null;
    file_name?: string;
    title?: string | null;
    rate_mentions?: string[];
    material_mentions?: string[];
    scope_mentions?: string[];
    compliance_mentions?: string[];
  };
  extraction?: {
    detected_document_type?: string | null;
  };
};

function inferType(value: unknown): 'text' | 'number' | 'boolean' | 'date' {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (value instanceof Date) return 'date';
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/.test(value) && !isNaN(Date.parse(value))) {
      return 'date';
    }
    const n = Number(value);
    if (!isNaN(n) && value.trim() !== '') return 'number';
  }
  return 'text';
}

function coerceValue(value: unknown, type: string): string | number | boolean | Date | null {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value : Number(value);
    case 'boolean':
      return Boolean(value);
    case 'date':
      return value instanceof Date ? value : new Date(String(value));
    default:
      return String(value);
  }
}

function flattenTypedFields(
  obj: TypedFields,
  prefix = '',
): Array<{ key: string; value: unknown }> {
  const out: Array<{ key: string; value: unknown }> = [];

  for (const [rawKey, value] of Object.entries(obj)) {
    if (rawKey === 'schema_type') continue;
    const key = prefix ? `${prefix}_${rawKey}` : rawKey;

    if (value === null || value === undefined) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      if (typeof value[0] === 'string' || typeof value[0] === 'number') {
        out.push({ key, value: value.join(', ') });
      }
      continue;
    }

    if (typeof value === 'object' && !(value instanceof Date)) {
      continue;
    }

    out.push({ key, value });
  }

  return out;
}

/**
 * Normalize a blob extraction payload into field_key rows.
 * Extracts typed_fields from the payload and creates fact rows
 * that the deterministic rule engine can query.
 */
export async function normalizeExtraction(params: {
  documentId: string;
  organizationId: string;
  payload: ExtractionBlob;
}): Promise<{ inserted: number; errors: number }> {
  const { documentId, organizationId, payload } = params;
  const facts: ExtractionFactInput[] = [];

  const typedFields = payload.fields?.typed_fields;
  if (typedFields && typeof typedFields === 'object') {
    const flat = flattenTypedFields(typedFields as TypedFields);
    for (const { key, value } of flat) {
      const type = inferType(value);
      facts.push({
        document_id: documentId,
        organization_id: organizationId,
        field_key: key,
        field_type: type,
        value: coerceValue(value, type),
        source: 'heuristic_extraction',
        confidence: 0.7,
      });
    }
  }

  const detectedType = payload.fields?.detected_document_type
    ?? payload.extraction?.detected_document_type;
  if (detectedType) {
    facts.push({
      document_id: documentId,
      organization_id: organizationId,
      field_key: 'document_type',
      field_type: 'text',
      value: detectedType,
      source: 'heuristic_extraction',
      confidence: 0.8,
    });
  }

  if (payload.fields?.rate_mentions && payload.fields.rate_mentions.length > 0) {
    facts.push({
      document_id: documentId,
      organization_id: organizationId,
      field_key: 'has_rate_mentions',
      field_type: 'boolean',
      value: true,
      source: 'heuristic_extraction',
    });
  }

  if (payload.fields?.compliance_mentions && payload.fields.compliance_mentions.length > 0) {
    facts.push({
      document_id: documentId,
      organization_id: organizationId,
      field_key: 'has_compliance_mentions',
      field_type: 'boolean',
      value: true,
      source: 'heuristic_extraction',
    });
  }

  if (facts.length === 0) {
    return { inserted: 0, errors: 0 };
  }

  return upsertManyExtractionFacts(documentId, facts);
}
