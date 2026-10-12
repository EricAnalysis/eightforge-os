import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { readFrictionReport } from '@/lib/server/frictionReportRead';

function fakeAdmin(tables: Record<string, unknown[]>) {
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const selects: Array<{ table: string; columns: string }> = [];
  const writes: string[] = [];
  return {
    filters, selects, writes,
    admin: {
      from(table: string) {
        return {
          select(columns: string) {
            selects.push({ table, columns });
            const query = {
              eq: (column: string, value: unknown) => { filters.push({ table, column, value }); return query; },
              in: () => query, is: () => query, order: () => query, limit: () => query,
              then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(resolve),
            };
            return query;
          },
          insert: () => { writes.push(table); throw new Error('write'); },
        };
      },
      rpc: async () => { writes.push('rpc'); return { data: null, error: null }; },
    } as never,
  };
}

describe('readFrictionReport', () => {
  it('reads every project of one organization through the resolution queue, and writes nothing', async () => {
    const fake = fakeAdmin({ projects: [{ id: 'p1' }, { id: 'p2' }], documents: [{ id: 'd1', document_type: 'contract' }],
      forgewing_recovery_generation_outcomes: [{ outcome_code: 'activation_not_allowed', source_document_id: 'd1' }] });
    const readQueue = vi.fn(async (query: { projectId: string }) => ({ status: 'ok' as const, queue: { cases: [{
      caseId: `c-${query.projectId}`, kind: 'review_required_value', documentId: 'd1', actions: [] }] } as never }));
    const result = await readFrictionReport({ organizationId: 'org-1' }, { admin: fake.admin, readQueue });
    if (result.status !== 'ok') throw new Error(result.status);
    expect(readQueue).toHaveBeenCalledTimes(2);
    expect(readQueue).toHaveBeenCalledWith({ organizationId: 'org-1', projectId: 'p1' }, expect.objectContaining({ forgewingEnabled: false }));
    expect(result.report).toMatchObject({ organizationId: 'org-1', projectCount: 2, openCases: 2,
      byReason: [{ key: 'scanned_rate_requires_review', cases: 2, documents: 1, projects: 2 }],
      forgewing: { policyBlocked: 1 } });
    expect(fake.filters.filter((entry) => entry.column === 'organization_id').every((entry) => entry.value === 'org-1')).toBe(true);
    expect(fake.writes).toEqual([]);
  });
});

const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';

describe('readFrictionReport rule semantics review (B6.4)', () => {
  it('reads only this organization\'s overridden Validator execution items, never the override reason', async () => {
    const fake = fakeAdmin({
      projects: [{ id: 'p1' }],
      documents: [{ id: 'd1', document_type: 'invoice' }, { id: 'd2', document_type: 'invoice' }],
      execution_items: [
        { id: E1, project_id: 'p1', source_id: 'f1', validator_rule_key: 'FINANCIAL_NTE_EXCEEDED' },
        { id: E2, project_id: 'p1', source_id: 'f2', validator_rule_key: 'FINANCIAL_NTE_EXCEEDED' },
        // A project outside this organization's report is ignored.
        { id: 'e3', project_id: 'p-other', source_id: 'f3', validator_rule_key: 'FINANCIAL_NTE_EXCEEDED' },
      ],
      project_validation_evidence: [
        { finding_id: 'f1', source_document_id: 'd1' },
        { finding_id: 'f2', source_document_id: 'd2' },
        // A document outside this organization never counts as distinct.
        { finding_id: 'f2', source_document_id: 'd-foreign' },
      ],
    });
    const readQueue = vi.fn(async () => ({ status: 'ok' as const, queue: { cases: [] } as never }));
    const result = await readFrictionReport({ organizationId: 'org-1' }, { admin: fake.admin, readQueue });
    if (result.status !== 'ok') throw new Error(result.status);

    expect(fake.filters.filter((entry) => entry.table === 'execution_items')).toEqual([
      { table: 'execution_items', column: 'organization_id', value: 'org-1' },
      { table: 'execution_items', column: 'source_type', value: 'validator_finding' },
      { table: 'execution_items', column: 'outcome', value: 'overridden' },
    ]);
    expect(fake.selects.find((entry) => entry.table === 'execution_items')!.columns).not.toContain('override_reason');
    const signal = result.report.signals.find((entry) => entry.kind === 'rule_semantics_review');
    expect(signal?.semanticsReview).toMatchObject({ ruleId: 'FINANCIAL_NTE_EXCEEDED', overrideCount: 2, distinctDocuments: 2,
      defectClass: 'undetermined' });
    expect(signal?.orchestratorPrefill?.evidenceLinks).toBe(`execution_item:${E1}\nexecution_item:${E2}`);
    expect(fake.writes).toEqual([]);
  });
});
