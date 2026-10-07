import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { readFrictionReport } from '@/lib/server/frictionReportRead';

function fakeAdmin(tables: Record<string, unknown[]>) {
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const writes: string[] = [];
  return {
    filters, writes,
    admin: {
      from(table: string) {
        return {
          select() {
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
