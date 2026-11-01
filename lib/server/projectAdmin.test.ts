import { describe, expect, it } from 'vitest';

import { getDocumentProjectMutationBlockers, getProjectDeletionBlockers } from '@/lib/server/projectAdmin';

type TableResult = Readonly<{ count?: number; data?: unknown[]; error?: { code?: string; message?: string } | null }>;

/** Any chain resolves to the table's result. */
function adminWith(relationships: TableResult) {
  return {
    from(table: string) {
      const result = table === 'document_relationships'
        ? { count: relationships.count ?? null, data: relationships.data ?? [], error: relationships.error ?? null }
        : { count: 0, data: [], error: null };
      const chain: Record<string, unknown> = {
        select: () => chain, eq: () => chain, or: () => chain, in: () => chain,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    },
  } as never;
}

const PROJECT = { organizationId: 'org-1', projectId: 'project-1' };
const DOCUMENT = { organizationId: 'org-1', documentId: 'document-1' };

const NOT_MISSING: ReadonlyArray<readonly [string, { code?: string; message: string }]> = [
  ['permission denied', { code: '42501', message: 'permission denied for table document_relationships' }],
  ['a missing column', { code: '42703', message: 'column document_relationships.project_id does not exist' }],
  ['a query timeout', { code: '57014', message: 'canceling statement on document_relationships due to statement timeout' }],
  ['a network failure', { message: 'TypeError: fetch failed while reading document_relationships' }],
];

const MISSING: ReadonlyArray<readonly [string, { code: string; message: string }]> = [
  ['42P01', { code: '42P01', message: 'relation "public.document_relationships" does not exist' }],
  ['PGRST205', { code: 'PGRST205', message: "Could not find the table 'public.document_relationships' in the schema cache" }],
];

describe('project deletion blockers', () => {
  it.each(NOT_MISSING)('%s is an error that blocks deletion, never zero relationships', async (_name, error) => {
    const blockers = await getProjectDeletionBlockers(adminWith({ error }), PROJECT);
    expect(blockers.errors).toEqual([error.message]);
  });

  it.each(MISSING)('a truly missing table (%s) means no relationships and no error', async (_name, error) => {
    const blockers = await getProjectDeletionBlockers(adminWith({ error }), PROJECT);
    expect(blockers.errors).toEqual([]);
    expect(blockers.relationshipCount).toBe(0);
  });

  it('counts relationships when the read succeeds', async () => {
    const blockers = await getProjectDeletionBlockers(adminWith({ count: 3 }), PROJECT);
    expect(blockers.relationshipCount).toBe(3);
  });
});

describe('document project mutation blockers', () => {
  it.each(NOT_MISSING)('%s is an error that blocks the move, never zero relationships', async (_name, error) => {
    const blockers = await getDocumentProjectMutationBlockers(adminWith({ error }), DOCUMENT);
    expect(blockers.errors).toEqual([error.message]);
  });

  it.each(MISSING)('a truly missing table (%s) means no relationships and no error', async (_name, error) => {
    const blockers = await getDocumentProjectMutationBlockers(adminWith({ error }), DOCUMENT);
    expect(blockers.errors).toEqual([]);
    expect(blockers.relationshipCount).toBe(0);
  });
});
