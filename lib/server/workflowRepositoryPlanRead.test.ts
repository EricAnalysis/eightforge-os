import { describe, expect, it, vi } from 'vitest';

import { readWorkflowRepositoryPlanV2 } from '@/lib/server/workflowRepositoryPlanRead';

const runId = '66666666-6666-4666-8666-666666666666';
const digest = 'a'.repeat(64);

function admin(result: unknown) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const secondEq = vi.fn().mockReturnValue({ maybeSingle });
  const firstEq = vi.fn().mockReturnValue({ eq: secondEq });
  const select = vi.fn().mockReturnValue({ eq: firstEq });
  const from = vi.fn().mockReturnValue({ select });
  return { client: { from }, from, select, firstEq, secondEq };
}

describe('validated repository Plan V2 exact-pin read', () => {
  it('rejects incomplete pins before database access', async () => {
    const db = admin({ data: null, error: null });
    await expect(readWorkflowRepositoryPlanV2({ planV2RunId: runId }, { admin: db.client }))
      .resolves.toEqual({ ok: false, code: 'invalid_pin' });
    expect(db.from).not.toHaveBeenCalled();
  });

  it('queries only the validated table with both exact identities', async () => {
    const db = admin({ data: null, error: null });
    await expect(readWorkflowRepositoryPlanV2({ planV2RunId: runId, planV2DigestSha256: digest }, { admin: db.client }))
      .resolves.toEqual({ ok: false, code: 'not_found' });
    expect(db.from).toHaveBeenCalledWith('workflow_repository_plan_v2_runs');
    expect(db.select).toHaveBeenCalledWith('id, plan_v2_digest_sha256, plan_v2_canonical_json');
    expect(db.firstEq).toHaveBeenCalledWith('id', runId);
    expect(db.secondEq).toHaveBeenCalledWith('plan_v2_digest_sha256', digest);
  });

  it('fails closed for transport and malformed persisted evidence', async () => {
    for (const result of [{ data: null, error: { message: 'secret' } },
      { data: { id: runId, plan_v2_digest_sha256: digest, plan_v2_canonical_json: '{}' }, error: null }]) {
      await expect(readWorkflowRepositoryPlanV2({ planV2RunId: runId, planV2DigestSha256: digest },
        { admin: admin(result).client })).resolves.toMatchObject({ ok: false });
    }
  });
});
