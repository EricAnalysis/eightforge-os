import { runOneRepositoryPlanGenerationJob } from '@/lib/server/repositoryPlanGenerationWorker';
import { readRepositoryPlanWorkerConfig } from '@/lib/server/repositoryPlanWorkerConfig';

const configured = readRepositoryPlanWorkerConfig();
if (!configured.ok) {
  console.error(`[repository-plan-worker] configuration_failed code=${configured.code}`);
  process.exitCode = 1;
} else {
  const { repositoryRoot, pollingIntervalMs, oneShot } = configured.config;
  let stopping = false;
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
    if (!oneShot && !stopping) await new Promise((resolve) => setTimeout(resolve, pollingIntervalMs));
  } while (!oneShot && !stopping);
}
