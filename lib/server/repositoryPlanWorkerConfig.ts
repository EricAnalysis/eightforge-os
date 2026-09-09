import { isAbsolute, resolve } from 'node:path';

export type RepositoryPlanWorkerConfig = Readonly<{
  repositoryRoot: string;
  pollingIntervalMs: number;
  oneShot: boolean;
}>;

export type RepositoryPlanWorkerConfigResult =
  | Readonly<{ ok: true; config: RepositoryPlanWorkerConfig }>
  | Readonly<{ ok: false; code: 'repository_root_missing' | 'repository_root_not_absolute' | 'polling_interval_invalid' }>;

export function readRepositoryPlanWorkerConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RepositoryPlanWorkerConfigResult {
  const rawRoot = env.FORGEWING_REPOSITORY_ROOT?.trim();
  if (!rawRoot) return { ok: false, code: 'repository_root_missing' };
  if (!isAbsolute(rawRoot)) return { ok: false, code: 'repository_root_not_absolute' };
  const rawInterval = env.FORGEWING_REPOSITORY_PLAN_POLL_INTERVAL_MS?.trim() ?? '5000';
  const pollingIntervalMs = Number(rawInterval);
  if (!Number.isSafeInteger(pollingIntervalMs) || pollingIntervalMs < 1_000 || pollingIntervalMs > 60_000) {
    return { ok: false, code: 'polling_interval_invalid' };
  }
  return { ok: true, config: {
    repositoryRoot: resolve(rawRoot), pollingIntervalMs,
    oneShot: env.FORGEWING_REPOSITORY_PLAN_ONE_SHOT === '1',
  } };
}
