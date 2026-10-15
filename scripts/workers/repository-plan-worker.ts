import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createForgewingEngineeringWorkerClient } from '@/lib/server/forgewingEngineeringWorkerClient';
import { runOneRepositoryPlanGenerationJob } from '@/lib/server/repositoryPlanGenerationWorker';
import { readRepositoryPlanWorkerConfig } from '@/lib/server/repositoryPlanWorkerConfig';
import { nextConsecutiveClaimFailures, workerClaimPathUnhealthy } from '@/lib/server/repositoryPlanWorkerHealth';

// Fail closed at startup, before any poll: a worker that can never claim a job
// (no dedicated-role token, a service-role token, no Supabase target) or has no
// real Git checkout exits non-zero instead of looping on failures.
const configured = readRepositoryPlanWorkerConfig();
const startupFailure = !configured.ok ? configured.code
  : !createForgewingEngineeringWorkerClient() ? 'worker_client_unconfigured'
  : !existsSync(join(configured.config.repositoryRoot, '.git')) ? 'repository_checkout_missing'
  : null;
if (!configured.ok || startupFailure) {
  console.error(`[repository-plan-worker] configuration_failed code=${startupFailure}`);
  process.exitCode = 1;
} else {
  const { repositoryRoot, pollingIntervalMs, oneShot } = configured.config;
  let stopping = false;
  let consecutiveClaimFailures = 0;
  process.once('SIGINT', () => { stopping = true; });
  process.once('SIGTERM', () => { stopping = true; });
  do {
    const result = await runOneRepositoryPlanGenerationJob(repositoryRoot);
    if (result.status === 'succeeded') {
      console.info(`[repository-plan-worker] succeeded jobId=${result.jobId} planV2RunId=${result.planV2RunId} providerCallCount=${result.providerCallCount}`);
    } else if (result.status === 'failed') {
      console.error(`[repository-plan-worker] failed jobId=${result.jobId ?? 'none'} code=${result.code}`);
      if (oneShot || result.jobId === undefined) process.exitCode = 1;
    }
    // Liveness: a claim path that keeps failing (expired or revoked token,
    // Supabase outage) exits non-zero so the restart policy surfaces it.
    consecutiveClaimFailures = nextConsecutiveClaimFailures(consecutiveClaimFailures, result);
    if (workerClaimPathUnhealthy(consecutiveClaimFailures)) {
      console.error(`[repository-plan-worker] unhealthy code=claim_path_failing consecutive=${consecutiveClaimFailures}`);
      process.exitCode = 1;
      stopping = true;
    }
    if (!oneShot && !stopping) await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
  } while (!oneShot && !stopping);
}
