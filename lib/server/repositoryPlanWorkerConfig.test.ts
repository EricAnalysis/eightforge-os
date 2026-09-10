import { describe, expect, it } from 'vitest';
import { readRepositoryPlanWorkerConfig } from './repositoryPlanWorkerConfig';

describe('repository plan worker configuration', () => {
  it('requires a worker-owned absolute repository root', () => {
    expect(readRepositoryPlanWorkerConfig({})).toEqual({ ok: false, code: 'repository_root_missing' });
    expect(readRepositoryPlanWorkerConfig({ FORGEWING_REPOSITORY_ROOT: 'relative/repo' }))
      .toEqual({ ok: false, code: 'repository_root_not_absolute' });
  });

  it('uses bounded polling and explicit one-shot mode', () => {
    const root = process.platform === 'win32' ? 'C:\\trusted\\eightforge' : '/trusted/eightforge';
    expect(readRepositoryPlanWorkerConfig({ FORGEWING_REPOSITORY_ROOT: root,
      FORGEWING_REPOSITORY_PLAN_POLL_INTERVAL_MS: '2500', FORGEWING_REPOSITORY_PLAN_ONE_SHOT: '1' }))
      .toMatchObject({ ok: true, config: { pollingIntervalMs: 2500, oneShot: true } });
    expect(readRepositoryPlanWorkerConfig({ FORGEWING_REPOSITORY_ROOT: root,
      FORGEWING_REPOSITORY_PLAN_POLL_INTERVAL_MS: '999' }))
      .toEqual({ ok: false, code: 'polling_interval_invalid' });
  });
});
