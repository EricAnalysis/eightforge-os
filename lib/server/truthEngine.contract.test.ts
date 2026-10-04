import { describe, expect, it, vi } from 'vitest';

const tableRows: Record<string, unknown> = {};

// Minimal chainable stand-in for the Supabase query builder: every filter
// returns the builder, and awaiting it (or maybeSingle) yields the table rows.
function queryBuilder(table: string) {
  const result = () => Promise.resolve({ data: tableRows[table] ?? null, error: null });
  const builder: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'in', 'limit', 'order']) {
    builder[method] = () => builder;
  }
  builder.maybeSingle = result;
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    result().then(resolve, reject);
  return builder;
}

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: () => ({ from: (table: string) => queryBuilder(table) }),
}));

import { resolveTruth } from '@/lib/server/truthEngine';

const finding = {
  id: 'finding-1',
  rule_id: 'CONTRACT_CEILING_UNCONFIRMED',
  severity: 'critical',
  status: 'open',
  subject_type: 'contract',
  subject_id: 'project-1',
  field: null,
  expected: null,
  actual: null,
  blocked_reason: null,
  decision_eligible: false,
  action_eligible: true,
  linked_decision_id: null,
  linked_action_id: null,
};

describe('contract truth query with an open contract finding', () => {
  it('resolves instead of throwing when a worst finding exists', async () => {
    tableRows.projects = { validation_status: 'BLOCKED', validation_summary_json: null };
    tableRows.project_validation_findings = [finding];
    tableRows.documents = [];

    const result = await resolveTruth('project-1', 'contract', '');

    expect(result).not.toBeNull();
    expect(result?.queryType).toBe('contract');
    expect(result?.approvalLabel).toBe('Requires Verification');
    expect(result?.validationState).toBe('Requires Verification');
    expect(result?.nextAction).toBe('Confirm the governing contract ceiling.');
  });

  it('falls through to the shared next-action helper for other contract rules', async () => {
    tableRows.projects = { validation_status: 'BLOCKED', validation_summary_json: null };
    tableRows.project_validation_findings = [
      { ...finding, rule_id: 'CONTRACT_SCOPE_MISMATCH', severity: 'warning' },
    ];
    tableRows.documents = [];

    const result = await resolveTruth('project-1', 'contract', '');

    expect(result).not.toBeNull();
    expect(typeof result?.nextAction).toBe('string');
    expect(result?.nextAction.length).toBeGreaterThan(0);
  });
});
