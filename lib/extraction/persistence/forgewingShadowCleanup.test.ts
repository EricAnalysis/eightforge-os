import { afterEach, describe, expect, it, vi } from 'vitest';

import { cleanupReasoningShadowArtifacts } from './forgewingShadowCleanup';
import { REASONING_SHADOW_BUCKET } from './forgewingShadowPersistence';

const now = new Date('2026-08-14T12:00:00.000Z');

function storage(entries: Record<string, readonly Record<string, unknown>[]>, options: {
  listErrorAt?: string;
  deleteError?: boolean;
} = {}) {
  const list = vi.fn(async (prefix: string, query: { limit: number; offset: number }) => {
    if (options.listErrorAt === prefix) return { data: null, error: { message: 'list failed' } };
    return {
      data: (entries[prefix] ?? []).slice(query.offset, query.offset + query.limit),
      error: null,
    };
  });
  const remove = vi.fn<(paths: readonly string[]) => Promise<{
    error: { message: string } | null;
  }>>(async () => ({
    error: options.deleteError ? { message: 'delete failed' } : null,
  }));
  const from = vi.fn<(bucket: string) => { list: typeof list; remove: typeof remove }>(
    () => ({ list, remove }),
  );
  return { admin: { storage: { from } }, from, list, remove };
}

function tree(files: readonly Record<string, unknown>[]) {
  return {
    forgewing: [{ name: 'organization-1', id: null, created_at: null }],
    'forgewing/organization-1': [{ name: 'artifact-1', id: null, created_at: null }],
    'forgewing/organization-1/artifact-1': files,
  };
}

describe('reasoning shadow cleanup', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('deletes only expired files discovered under the dedicated prefix', async () => {
    const store = storage(tree([
      { name: 'old.json.gz', id: 'old', created_at: '2026-08-01T00:00:00.000Z' },
      { name: 'young.json.gz', id: 'young', created_at: '2026-08-12T00:00:00.000Z' },
      { name: 'unknown.json.gz', id: 'unknown', created_at: null },
    ]));
    const result = await cleanupReasoningShadowArtifacts({ admin: store.admin as never, now: () => now });

    expect(result).toMatchObject({ status: 'completed', deleted: 1, failedBatches: 0 });
    expect(store.from).toHaveBeenCalledWith(REASONING_SHADOW_BUCKET);
    expect(store.list.mock.calls[0]![0]).toBe('forgewing');
    expect(store.list.mock.calls.some(([prefix]) => prefix === '')).toBe(false);
    expect(store.remove).toHaveBeenCalledWith([
      'forgewing/organization-1/artifact-1/old.json.gz',
    ]);
  });

  it('uses bounded pagination and bounded delete batches', async () => {
    const store = storage(tree([
      { name: 'a.json.gz', id: 'a', created_at: '2026-08-01T00:00:00.000Z' },
      { name: 'b.json.gz', id: 'b', created_at: '2026-08-02T00:00:00.000Z' },
      { name: 'c.json.gz', id: 'c', created_at: '2026-08-03T00:00:00.000Z' },
    ]));
    const result = await cleanupReasoningShadowArtifacts({
      admin: store.admin as never,
      now: () => now,
      listPageSize: 1,
      deleteBatchSize: 2,
    });

    expect(result).toMatchObject({ status: 'completed', deleted: 3 });
    expect(store.list.mock.calls.some(([, options]) => options.offset === 1)).toBe(true);
    expect(store.remove).toHaveBeenCalledTimes(2);
    expect(store.remove.mock.calls[0]![0]).toHaveLength(2);
    expect(store.remove.mock.calls[1]![0]).toHaveLength(1);
  });

  it('contains listing failures without attempting deletion', async () => {
    const store = storage(tree([]), { listErrorAt: 'forgewing/organization-1' });
    await expect(cleanupReasoningShadowArtifacts({
      admin: store.admin as never, now: () => now,
    })).resolves.toMatchObject({
      status: 'failed', deleted: 0, warningCodes: ['forgewing_shadow_cleanup_list_failed'],
    });
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('contains delete failures and reports a partial cleanup', async () => {
    const store = storage(tree([
      { name: 'old.json.gz', id: 'old', created_at: '2026-08-01T00:00:00.000Z' },
    ]), { deleteError: true });
    await expect(cleanupReasoningShadowArtifacts({
      admin: store.admin as never, now: () => now,
    })).resolves.toMatchObject({
      status: 'partial', deleted: 0, failedBatches: 1,
      warningCodes: ['forgewing_shadow_cleanup_delete_failed'],
    });
  });

  it('stops at invocation bounds and reports truncation', async () => {
    const store = storage(tree([
      { name: 'a.json.gz', id: 'a', created_at: '2026-08-01T00:00:00.000Z' },
      { name: 'b.json.gz', id: 'b', created_at: '2026-08-01T00:00:00.000Z' },
    ]));
    await expect(cleanupReasoningShadowArtifacts({
      admin: store.admin as never, now: () => now, maxScanned: 1,
    })).resolves.toMatchObject({ status: 'partial', truncated: true, deleted: 0 });
  });
});
