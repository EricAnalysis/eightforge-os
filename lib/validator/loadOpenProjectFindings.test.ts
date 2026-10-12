import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeValidationFinding } from '@/lib/validator/findingSemantics';
import { loadOpenProjectFindings } from '@/lib/validator/loadOpenProjectFindings';
import type { ValidationFinding } from '@/types/validator';

const finding: ValidationFinding = {
  id: 'finding-1', run_id: 'run-1', project_id: 'project-1',
  rule_id: 'FINANCIAL_RATE_NOT_IN_SCHEDULE', check_key: 'FINANCIAL_RATE_NOT_IN_SCHEDULE:line-1',
  category: 'financial_integrity', severity: 'critical', status: 'open',
  subject_type: 'invoice_line', subject_id: 'line-1', field: 'unit_rate',
  expected: '100', actual: '125', variance: 25, variance_unit: 'USD',
  blocked_reason: 'The invoice rate differs from the governing rate.',
  decision_eligible: true, action_eligible: true,
  linked_decision_id: null, linked_action_id: null,
  resolved_by_user_id: null, resolved_at: null,
  created_at: '2026-10-12T00:00:00Z', updated_at: '2026-10-12T00:00:00Z',
};

// Derive the schema contract from the migration, rather than blessing UI fields.
const migration = readFileSync(path.resolve('supabase/migrations/20260401000000_project_validator_phase0_schema.sql'), 'utf8');
const tableDefinition = migration.split('CREATE TABLE IF NOT EXISTS public.project_validation_findings (')[1].split('\n);')[0];
const persistedColumns = new Set(Array.from(tableDefinition.matchAll(/^\s+(\w+)\s+(?:uuid|text|numeric|boolean|timestamptz)\b/gm), (match) => match[1]));

function mockClient(result: { data: ValidationFinding[] | null; error: { message: string } | null }) {
  const filters: Array<[string, string]> = [];
  const query = {
    select(columns: string) {
      for (const column of columns.split(',').map((column) => column.trim())) {
        assert.ok(persistedColumns.has(column), `column "${column}" does not exist`);
      }
      return query;
    },
    eq(column: string, value: string) { filters.push([column, value]); return query; },
    then(resolve: (value: typeof result) => unknown) { return Promise.resolve(result).then(resolve); },
  };
  const client = {
    from(table: string) { assert.equal(table, 'project_validation_findings'); return query; },
  } as unknown as SupabaseClient;
  return { client, filters };
}

describe('loadOpenProjectFindings', () => {
  it('queries persisted columns scoped to the linked project and normalizes display semantics', async () => {
    const { client, filters } = mockClient({ data: [finding], error: null });
    const result = await loadOpenProjectFindings(client, 'project-1');
    assert.deepEqual(filters, [['project_id', 'project-1'], ['status', 'open']]);
    assert.deepEqual(result, [normalizeValidationFinding(finding)]);
    assert.ok(result[0].problem);
    assert.ok(result[0].impact);
    assert.ok(result[0].required_action);
    assert.equal(result[0].id, finding.id);
    assert.equal(result[0].run_id, finding.run_id);
    assert.equal(finding.problem, undefined);
  });

  it('returns an empty state only for a successful empty query', async () => {
    const { client } = mockClient({ data: [], error: null });
    assert.deepEqual(await loadOpenProjectFindings(client, 'project-1'), []);
  });

  it('preserves the shared advisory rule semantics without adding a local severity rule', async () => {
    const advisory = {
      ...finding,
      rule_id: 'SOURCES_REFERENCED_AMENDMENT_MISSING',
      category: 'required_sources' as const,
      severity: 'info' as const,
    };
    const { client } = mockClient({ data: [advisory], error: null });
    const [result] = await loadOpenProjectFindings(client, 'project-1');
    assert.deepEqual(result, normalizeValidationFinding(advisory));
    assert.equal(result.approval_gate_effect, 'informational');
    assert.equal(result.business_severity, 'low');
  });

  it('rejects query errors instead of converting unavailable findings to an empty state', async () => {
    const { client } = mockClient({ data: null, error: { message: 'permission denied' } });
    await assert.rejects(loadOpenProjectFindings(client, 'project-1'), /Failed to load project validation findings: permission denied/);
  });

  it('rejects even when a failed query returns partial data', async () => {
    const { client } = mockClient({ data: [finding], error: { message: 'query failed' } });
    await assert.rejects(loadOpenProjectFindings(client, 'project-1'), /query failed/);
  });
});
