import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/server/supabaseAdmin', () => ({ getSupabaseAdmin: () => null }));

import { readResolutionQueue, type ResolutionReadClient } from '@/lib/server/resolutionQueueRead';

const ORG = 'org-1';
const PROJECT = 'project-1';
const DOC = 'doc-1';
const DIGEST = 'a'.repeat(64);

const extraction = {
  document_id: DOC, created_at: '2026-10-04T00:00:00Z',
  data: { extraction: { content_layers_v1: { pdf: {
    text: { pages: [{ plain_text_blocks: [{ text: 'x' }] }] },
    page_extraction_coverage_v1: { pages: [{ page_number: 2, page_representation_digest: DIGEST }] },
    priced_schedule_reconstruction_v1: {
      parser_version: 'priced_schedule_reconstruction_v2', pages: [],
      unresolved_pages: [{ authority: 'non_authoritative_diagnostic', reason: 'header_not_found', physical_page_number: 2,
        header_lines: [], priced_lines: [{ raw_text: 'Hauling TON $ 8.7S', y: 300, source_refs: [
          { observation_id: 'o1', text: 'Hauling', x_min: 1, x_max: 2, y_min: 3, y_max: 4 },
          { observation_id: 'o2', text: '8.7S', x_min: 5, x_max: 6, y_min: 3, y_max: 4 },
        ] }] }],
    },
  } } } },
};

function fakeClient(tables: Record<string, unknown[]>, projectOrg = ORG) {
  const writes: string[] = [];
  const reads: string[] = [];
  const client = {
    rpc: vi.fn(async () => { writes.push('rpc'); return { data: null, error: null }; }),
    from(table: string) {
      return {
        select() {
          reads.push(table);
          const result = { data: table === 'projects' ? null : tables[table] ?? [], error: null };
          const query = {
            eq: () => query, in: () => query, is: () => query, order: () => query,
            maybeSingle: async () => ({ data: table === 'projects' ? { id: PROJECT, organization_id: projectOrg } : null, error: null }),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve),
          };
          return query;
        },
        insert: () => { writes.push(`insert:${table}`); throw new Error('write attempted'); },
        update: () => { writes.push(`update:${table}`); throw new Error('write attempted'); },
        delete: () => { writes.push(`delete:${table}`); throw new Error('write attempted'); },
      };
    },
  };
  return { client: client as unknown as ResolutionReadClient, writes, reads };
}

describe('resolution queue server read (B5-A)', () => {
  it('derives cases from existing records without writing anything', async () => {
    const { client, writes } = fakeClient({
      documents: [{ id: DOC, title: 'Contract', name: 'c.pdf', document_type: 'contract' }],
      document_extractions: [extraction],
    });
    const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: false });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.queue.cases).toHaveLength(1);
    expect(result.queue.cases[0]).toMatchObject({
      kind: 'unreadable_priced_line', documentId: DOC, physicalPageNumber: 2, originalSourceText: 'Hauling TON $ 8.7S',
    });
    expect(writes).toEqual([]);
  });

  it('does not read Forgewing proposals when Forgewing is off', async () => {
    const { client } = fakeClient({ documents: [{ id: DOC, title: 'Contract' }] });
    const readRecoveryQueue = vi.fn();
    await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: false, readRecoveryQueue });
    expect(readRecoveryQueue).not.toHaveBeenCalled();
  });

  it('reads proposals per document when Forgewing is on', async () => {
    const { client } = fakeClient({ documents: [{ id: DOC, title: 'Contract' }] });
    const readRecoveryQueue = vi.fn(async () => ({ status: 'ok' as const, candidates: [] }));
    const result = await readResolutionQueue({ organizationId: ORG, projectId: PROJECT },
      { admin: client, forgewingEnabled: true, readRecoveryQueue });
    expect(readRecoveryQueue).toHaveBeenCalledWith({ organizationId: ORG, sourceDocumentId: DOC }, expect.anything());
    expect(result.status === 'ok' && result.queue.forgewingSuggestionsIncluded).toBe(true);
  });

  it('refuses a project outside the actor organization', async () => {
    const { client, reads } = fakeClient({}, 'other-org');
    await expect(readResolutionQueue({ organizationId: ORG, projectId: PROJECT }, { admin: client, forgewingEnabled: false }))
      .resolves.toEqual({ status: 'not_found' });
    expect(reads).toEqual(['projects']);
  });
});
