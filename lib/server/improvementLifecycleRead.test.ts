import { afterEach, describe, expect, it, vi } from 'vitest';

import { readImprovementLifecycle, type LifecycleReadAdmin } from '@/lib/server/improvementLifecycleRead';

const SUBMISSION = 'b84d0000-0000-4000-8000-000000000301';
const REVIEWER = { email: 'reviewer@example.invalid', role: null };

function admin(tables: Record<string, Record<string, unknown>[]>) {
  const from = (table: string) => ({ select: () => {
    const filters: ((row: Record<string, unknown>) => boolean)[] = [];
    const query = {
      eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
      in: (column: string, values: readonly unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
      order: () => query, limit: () => query,
      then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ error: null,
        data: (tables[table] ?? []).filter((row) => filters.every((filter) => filter(row))) })),
    };
    return query;
  } });
  return { from } as unknown as LifecycleReadAdmin;
}

afterEach(() => vi.unstubAllEnvs());

describe('improvement lifecycle read (B8.4d)', () => {
  it('lists approved requests of the triage-sourced plans, marks superseded ones, and shows Linear as a copy only', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    const result = await readImprovementLifecycle({ submissionId: SUBMISSION }, REVIEWER, { admin: admin({
      improvement_signal_triage_reviews: [{ id: 't1', submission_id: SUBMISSION }],
      workflow_repository_plan_v2_runs: [{ id: 'run1', plan_v2_digest_sha256: 'd', triage_review_id: 't1' }],
      workflow_repository_plan_recommendation_reviews: [
        { id: 'r1', review_version: 1, plan_v2_run_id: 'run1', plan_v2_digest_sha256: 'd', recommendation_id: 'rec_a', disposition: 'accepted' },
        { id: 'r2', review_version: 2, plan_v2_run_id: 'run1', plan_v2_digest_sha256: 'd', recommendation_id: 'rec_a', disposition: 'modified' },
        { id: 'r3', review_version: 1, plan_v2_run_id: 'run1', plan_v2_digest_sha256: 'd', recommendation_id: 'rec_b', disposition: 'rejected' },
      ],
      linear_projection_correlations: [{ review_id: 'r2', status: 'projected', linear_issue_identifier: 'ENG-1' }],
      improvement_lifecycle_events: [{ id: 'e1', event_kind: 'implemented', submission_id: SUBMISSION }],
    }) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.view.engineeringRequests).toEqual([
      expect.objectContaining({ reviewId: 'r1', current: false, linearStatus: null }),
      expect.objectContaining({ reviewId: 'r2', current: true, linearStatus: 'projected', linearIssueIdentifier: 'ENG-1' }),
    ]);
    expect(result.view.events).toHaveLength(1);
    expect(result.view.predecessor).toBeNull();
  });

  it('refuses non-reviewers and malformed queries', async () => {
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', 'someone-else@example.invalid');
    expect(await readImprovementLifecycle({ submissionId: SUBMISSION }, REVIEWER, { admin: admin({}) }))
      .toEqual({ status: 'reviewer_not_eligible' });
    vi.stubEnv('INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS', REVIEWER.email);
    expect(await readImprovementLifecycle({ submissionId: 'x' }, REVIEWER, { admin: admin({}) }))
      .toEqual({ status: 'invalid_input' });
  });
});
