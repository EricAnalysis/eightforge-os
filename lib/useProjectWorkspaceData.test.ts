import assert from 'node:assert/strict';
import { describe, it, vi } from 'vitest';

const supabaseFrom = vi.hoisted(() => vi.fn());

vi.mock('@/lib/supabaseClient', () => ({
  supabase: { from: supabaseFrom },
}));

import {
  isNonCoreWorkspaceLoadError,
  loadTransactionRowsForProject,
} from '@/lib/useProjectWorkspaceData';

type PageResult = {
  data: Array<{ id: string }> | null;
  error: { code?: string | null; message?: string | null } | null;
  count?: number | null;
};

function configureTransactionRowsMock(
  fetchPage: (args: { offset: number; withExactCount: boolean }) => Promise<PageResult>,
) {
  supabaseFrom.mockImplementation(() => ({
    select: (_columns: string, options?: { count?: string }) => {
      const withExactCount = options?.count === 'exact';
      const query = {
        eq: () => query,
        order: () => query,
        range: (offset: number) => fetchPage({ offset, withExactCount }),
      };
      return query;
    },
  }));
}

function rowsForPage(page: number, length: number) {
  return Array.from({ length }, (_, index) => ({ id: `row-${page}-${index}` }));
}

describe('workspace load issue classification', () => {
  it('suppresses non-core audit event load failures from the operator banner', () => {
    assert.equal(
      isNonCoreWorkspaceLoadError('Audit events', { message: 'Bad Request', code: '400' }),
      true,
    );
  });

  it('keeps genuine data integrity load failures visible', () => {
    assert.equal(
      isNonCoreWorkspaceLoadError('Validation findings', { message: 'Bad Request', code: '400' }),
      false,
    );
    assert.equal(
      isNonCoreWorkspaceLoadError('Transaction datasets', { message: 'relation missing', code: '42P01' }),
      false,
    );
    assert.equal(
      isNonCoreWorkspaceLoadError('Documents', {
        message: 'column documents.document_role does not exist',
        code: '42703',
      }),
      false,
    );
  });
});

describe('transaction row paging', () => {
  it('assembles exact-count pages in serial-equivalent order while overlapping pages after the first', async () => {
    const pages = Array.from({ length: 6 }, (_, page) => rowsForPage(page, 1000));
    pages.push(rowsForPage(6, 123));
    const expected = pages.flat();
    const pending = new Map<number, (result: PageResult) => void>();
    const offsets: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    configureTransactionRowsMock(({ offset, withExactCount }) => {
      offsets.push(offset);
      if (offset === 0 && withExactCount) {
        return Promise.resolve({ data: pages[0], error: null, count: expected.length });
      }

      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        pending.set(offset, (result) => {
          inFlight -= 1;
          resolve(result);
        });
      });
    });

    const resultPromise = loadTransactionRowsForProject('project-1');
    await vi.waitFor(() => assert.deepEqual(offsets, [0, 1000, 2000, 3000, 4000, 5000, 6000]));
    assert.equal(maxInFlight, 6, 'the six remaining page requests overlap instead of serializing');

    for (let page = 1; page < pages.length; page += 1) {
      pending.get(page * 1000)?.({ data: pages[page], error: null });
    }

    const result = await resultPromise;
    assert.equal(result.error, null);
    assert.deepEqual(result.data, expected);
    assert.equal(result.data.length, expected.length);
  });

  it('falls back to the original serial loop when exact count is unavailable', async () => {
    const firstPage = rowsForPage(0, 1000);
    const finalPage = rowsForPage(1, 20);
    const offsets: Array<{ offset: number; withExactCount: boolean }> = [];

    configureTransactionRowsMock(({ offset, withExactCount }) => {
      offsets.push({ offset, withExactCount });
      if (withExactCount) {
        return Promise.resolve({ data: firstPage, error: null, count: null });
      }
      return Promise.resolve({
        data: offset === 0 ? firstPage : finalPage,
        error: null,
      });
    });

    const result = await loadTransactionRowsForProject('project-1');
    assert.equal(result.error, null);
    assert.deepEqual(result.data, [...firstPage, ...finalPage]);
    assert.deepEqual(offsets, [
      { offset: 0, withExactCount: true },
      { offset: 0, withExactCount: false },
      { offset: 1000, withExactCount: false },
    ]);
  });
});
