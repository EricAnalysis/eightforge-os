import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';
import { buildPortfolioCommandCenter } from '@/lib/server/portfolioCommandCenter';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

vi.mock('@/lib/server/supabaseAdmin', () => ({
  getSupabaseAdmin: vi.fn(),
}));

function makePortfolioAdmin() {
  return {
    from(table: string) {
      let selectValue = '';

      const query = {
        select(value: string) {
          selectValue = value;
          return query;
        },
        eq() {
          return query;
        },
        in() {
          return query;
        },
        neq() {
          return query;
        },
        not() {
          return query;
        },
        lt() {
          return query;
        },
        order() {
          return query;
        },
        limit() {
          return query;
        },
        then(
          resolve: (value: { data: unknown[] | null; error: Error | null }) => unknown,
          reject?: (reason: unknown) => unknown,
        ) {
          if (table === 'projects') {
            return Promise.resolve({
              data: [{
                id: 'project-1',
                name: 'Project One',
                code: 'P1',
                status: 'active',
                created_at: '2026-07-04T12:00:00.000Z',
              }],
              error: null,
            }).then(resolve, reject);
          }

          if (table === 'decision_detections' && selectValue === 'project_id') {
            return Promise.resolve({
              data: null,
              error: new Error('relation "public.decision_detections" does not exist'),
            }).then(resolve, reject);
          }

          return Promise.resolve({ data: [], error: null }).then(resolve, reject);
        },
      };

      return query;
    },
  };
}

describe('buildPortfolioCommandCenter', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fails the portfolio aggregate when decision_detections is unavailable instead of silently zeroing issue counts', async () => {
    vi.mocked(getSupabaseAdmin).mockReturnValue(makePortfolioAdmin() as never);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await buildPortfolioCommandCenter('org-1');

    assert.equal(result, null);
    assert.match(
      String(consoleError.mock.calls[0]?.[1] ?? ''),
      /decision_detections resolved-count query failed/,
    );
  });
});
