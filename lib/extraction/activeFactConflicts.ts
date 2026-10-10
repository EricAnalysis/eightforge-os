import { canonicalEffectiveFactKey, effectiveFactValueIdentity } from '@/lib/effectiveFacts';
import { canonicalEvidenceRef, extractionConflict, type TruthEnvelope } from '@/lib/canonical/truth/envelope';
import type { Facts } from '@/lib/types/rules';

/** Observations remain stored; this module only resolves their effective read. */
export type ActiveExtractionFactRow = {
  id?: string;
  document_id?: string;
  status?: string;
  source?: string | null;
  confidence?: number | null;
  page_number?: number | null;
  field_key: string;
  field_type?: string | null;
  field_value_text?: string | null;
  field_value_number?: number | null;
  field_value_date?: string | null;
  field_value_boolean?: boolean | null;
};

export type ActiveExtractionFactConflict = {
  documentId: string | null;
  fieldKey: string;
  observations: readonly ActiveExtractionFactRow[];
  truth: TruthEnvelope<unknown>;
};

export function extractionFactValue(row: ActiveExtractionFactRow): string | number | boolean | Date | null {
  if (row.field_value_number != null) return Number(row.field_value_number);
  if (row.field_value_boolean != null) return Boolean(row.field_value_boolean);
  if (row.field_value_date != null) return new Date(row.field_value_date);
  return row.field_value_text ?? null;
}

/** Conservative typed equality; no date guessing, source ranking or confidence winner. */
export function extractionValueIdentity(value: unknown): string {
  return effectiveFactValueIdentity(value);
}

export function resolveActiveExtractionFacts(rows: readonly ActiveExtractionFactRow[]): {
  facts: Facts;
  conflicts: ActiveExtractionFactConflict[];
} {
  const groups = new Map<string, ActiveExtractionFactRow[]>();
  for (const row of rows) {
    // Missing status is allowed only for projections from an already active-filtered query.
    if ((row.status != null && row.status !== 'active') || !row.field_key) continue;
    const key = `${row.document_id ?? ''}:${canonicalEffectiveFactKey(row.field_key)}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const facts: Facts = {};
  const conflicts: ActiveExtractionFactConflict[] = [];
  for (const [, unsorted] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const group = [...unsorted].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const values = new Map(group.map(row => [extractionValueIdentity(extractionFactValue(row)), extractionFactValue(row)]));
    const fieldKey = canonicalEffectiveFactKey(group[0].field_key);
    if (values.size > 1) {
      conflicts.push({
        documentId: group[0].document_id ?? null,
        fieldKey,
        observations: group,
        truth: extractionConflict({
          stateReason: 'conflicting_active_extraction_values',
          conflictingEvidence: group.map(row => canonicalEvidenceRef({
            documentId: row.document_id,
            extractionArtifactId: row.id,
            sourceAnchor: row.id,
            rawSpan: String(row.field_value_date ?? row.field_value_text ?? row.field_value_number ?? row.field_value_boolean ?? ''),
          })),
        }),
      });
      continue;
    }
    const value = values.values().next().value ?? null;
    // Keep existing rule keys while comparing aliases at the canonical boundary.
    for (const key of [...new Set(group.map(row => row.field_key))].sort()) facts[key] = value;
  }
  return { facts, conflicts };
}
