// B8.4b/B8.4c: one bounded pass of deployment proof for human-attested fixes,
// then producer classification for measurement.
// Uses the dedicated worker role and the worker's configured checkout only.
import { createForgewingEngineeringWorkerClient } from '@/lib/server/forgewingEngineeringWorkerClient';
import { runImprovementDeploymentProof, runImprovementProducerClassification } from '@/lib/server/improvementDeploymentWorker';
import { readRepositoryPlanWorkerConfig } from '@/lib/server/repositoryPlanWorkerConfig';

const configured = readRepositoryPlanWorkerConfig();
const client = createForgewingEngineeringWorkerClient();
if (!configured.ok || !client) {
  console.error(`[improvement-deployment-worker] configuration_failed code=${configured.ok ? 'worker_client_unavailable' : configured.code}`);
  process.exitCode = 1;
} else {
  const result = await runImprovementDeploymentProof(client, configured.config.repositoryRoot);
  if (result.status === 'failed') {
    console.error(`[improvement-deployment-worker] failed code=${result.code}`);
    process.exitCode = 1;
  } else {
    for (const outcome of result.outcomes) {
      const detail = outcome.outcome === 'deployed' ? ` productionRevision=${outcome.productionRevision} inserted=${outcome.inserted}`
        : outcome.outcome === 'unverifiable' ? ` code=${outcome.code} revision=${outcome.revision}` : '';
      console.info(`[improvement-deployment-worker] implementedEventId=${outcome.implementedEventId} outcome=${outcome.outcome}${detail}`);
    }
    if (result.outcomes.some((outcome) => outcome.outcome === 'record_failed')) process.exitCode = 1;
  }
  // B8.4c: classify the production revisions behind each deployed fix's measured units.
  const classified = await runImprovementProducerClassification(client, configured.config.repositoryRoot);
  if (classified.status === 'failed') {
    console.error(`[improvement-deployment-worker] classification_failed code=${classified.code}`);
    process.exitCode = 1;
  } else {
    console.info(`[improvement-deployment-worker] classification classified=${classified.classified} unverifiable=${classified.unverifiable} recordFailed=${classified.recordFailed} truncatedEvents=${classified.truncatedEvents}`);
    if (classified.recordFailed > 0) process.exitCode = 1;
  }
}
