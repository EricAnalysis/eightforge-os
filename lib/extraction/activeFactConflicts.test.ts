import { describe, expect, it, vi } from 'vitest';
import { resolveActiveExtractionFacts, type ActiveExtractionFactRow } from './activeFactConflicts';
import { evaluateCondition } from '@/lib/ruleEvaluation';
import { collapseEffectiveFactRecords, type EffectiveFactRecord } from '@/lib/effectiveFacts';

const row = (value: string, extra: Partial<ActiveExtractionFactRow> = {}): ActiveExtractionFactRow => ({
  id: value, document_id: 'document', field_key: 'expiration_date', field_type: 'text',
  field_value_text: value, source: 'extractor', status: 'active', ...extra,
});

describe('active extraction fact conflicts', () => {
  it('deduplicates identical values from independent sources without losing observations', () => {
    const rows = [row('2030-01-01', { source: 'a' }), row('2030-01-01', { source: 'b' })];
    expect(resolveActiveExtractionFacts(rows)).toEqual({ facts: { expiration_date: '2030-01-01' }, conflicts: [] });
    expect(rows).toHaveLength(2);
  });

  it('withholds conflicting values identically in both row orders, preserving provenance', () => {
    const rows = [row('2030-01-01', { id: 'a', source: 'heuristic' }), row('2020-01-01', { id: 'b', source: 'evidence' })];
    const forward = resolveActiveExtractionFacts(rows);
    expect(forward).toEqual(resolveActiveExtractionFacts([...rows].reverse()));
    expect(forward.facts).not.toHaveProperty('expiration_date');
    expect(forward.conflicts[0].truth).toMatchObject({ state: 'extraction_conflict', value: null });
    expect(forward.conflicts[0].observations).toHaveLength(2);
    expect(forward.conflicts[0].truth.conflictingEvidence.map(e => e.extractionArtifactId)).toEqual(['a', 'b']);
    expect(evaluateCondition({ field_key: 'expiration_date', operator: 'equals', value: '2030-01-01' }, forward.facts).passed).toBe(false);
    expect(evaluateCondition({ field_key: 'expiration_date', operator: 'equals', value: '2020-01-01' }, forward.facts).passed).toBe(false);
  });

  it('publishes one active value and ignores superseded or inactive observations', () => {
    expect(resolveActiveExtractionFacts([row('2030'), row('2020', { status: 'superseded' }), row('2040', { status: 'inactive' })]))
      .toEqual({ facts: { expiration_date: '2030' }, conflicts: [] });
  });

  it('compares canonical aliases but keeps safe rule keys', () => {
    const rows = [row('A', { field_key: 'vendor_name' }), row('B', { field_key: 'contractor_name' })];
    expect(resolveActiveExtractionFacts(rows).facts).toEqual({});
    expect(resolveActiveExtractionFacts(rows).conflicts[0].fieldKey).toBe('contractor_name');
  });

  it('retains safe typed date, number and boolean values', () => {
    const result = resolveActiveExtractionFacts([
      row('', { field_value_text: null, field_value_date: '2030-01-01' }),
      row('', { field_key: 'amount', field_value_number: 10 }),
      row('', { field_key: 'present', field_value_boolean: false }),
    ]);
    expect(result.facts).toEqual({ expiration_date: new Date('2030-01-01'), amount: 10, present: false });
  });

  it('blocks a canonical machine fallback while allowing an existing typed human review', () => {
    const observations = ['A', 'B'].map(value => ({ document_id: 'doc', key: 'expiration_date', value, source: 'normalized_row', evidence: [{ value }] }));
    const fallback = { document_id: 'doc', key: 'expiration_date', value: 'C', source: 'canonical_contract_intelligence' };
    const unresolved = collapseEffectiveFactRecords<EffectiveFactRecord>([...observations, fallback]);
    expect(unresolved).toEqual(collapseEffectiveFactRecords([fallback, ...observations].reverse()));
    expect(unresolved[0].value).toBeNull();
    expect(unresolved[0].conflictingObservations).toHaveLength(2);
    expect(collapseEffectiveFactRecords([...observations, fallback, { ...fallback, value: 'Reviewed', source: 'human_review' }])[0].value).toBe('Reviewed');
  });
  it('does not let an array fallback bypass conflicting normalized scalar observations', () => {
    const observations: EffectiveFactRecord[] = ['A', 'B'].map(value => ({ document_id: 'doc', key: 'rate_table', value, source: 'normalized_row' }));
    const result = collapseEffectiveFactRecords([...observations, { ...observations[0], value: [{ rate: 10 }], source: 'legacy_structured_field' }]);
    expect(result[0].value).toBeNull();
    expect(result[0].extractionConflict?.state).toBe('extraction_conflict');
  });
});

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: vi.fn() }));
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { loadFactsWithDerived } from '@/lib/server/ruleEngine';

it('passes no arbitrary value to the rule/derived layer and returns typed review diagnostics', async () => {
  const rows = [row('2030'), row('2020')];
  const chain = { select: () => chain, eq: () => chain, not: () => chain, then: (resolve: (x: unknown) => unknown) => resolve({ data: rows, error: null }) };
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from: () => chain } as never);
  const result = await loadFactsWithDerived({ documentId: 'doc', domain: 'debris_ops', documentType: 'project_contract' });
  expect(result.facts).not.toHaveProperty('expiration_date');
  expect(result.derived_facts.derived_missing_required_count).toBe(2);
  expect(result.extraction_conflicts[0].observations).toHaveLength(2);
  expect(result.extraction_row_count).toBe(2);
});

it('refuses failed or potentially truncated observation reads', async () => {
  for (const response of [{ data: null, error: { message: 'timeout' } }, { data: Array.from({ length: 1000 }, () => row('A')), error: null }]) {
    const chain = { select: () => chain, eq: () => chain, not: () => chain, then: (resolve: (x: unknown) => unknown) => resolve(response) };
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from: () => chain } as never);
    await expect(loadFactsWithDerived({ documentId: 'doc', domain: 'debris_ops', documentType: 'project_contract' })).rejects.toThrow();
  }
});
