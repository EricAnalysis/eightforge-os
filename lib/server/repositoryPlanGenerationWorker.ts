import { buildRepositoryPlanFoundation } from '@/lib/repositoryPlanFoundation';
import { prepareRepositoryPlanGuidance } from '@/lib/repositoryPlanGuidance';
import { createForgewingEngineeringWorkerClient } from '@/lib/server/forgewingEngineeringWorkerClient';
import { loadRepositoryPlanEvidenceCatalog } from '@/lib/server/repositoryPlanEvidenceCatalogLoader';
import { collectCommittedContent } from '@/lib/server/repositoryPlanContentCollector';
import {
  beginRepositoryPlanProviderCall,
  claimRepositoryPlanGenerationJob,
  failRepositoryPlanGenerationJob,
  readRepositoryPlanGenerationSource,
  succeedRepositoryPlanGenerationJob,
} from '@/lib/server/repositoryPlanGenerationJobs';
import { verifyCurrentRepositorySnapshot } from '@/lib/server/repositoryPlanCurrentSnapshot';
import { recordWorkflowRepositoryPlanV2 } from '@/lib/server/workflowRepositoryPlanPersistence';
import { resolveEffectiveReviewedSpecification } from '@/lib/workflowEffectiveReviewedSpecification';
import { buildWorkflowImplementationPlan } from '@/lib/workflowImplementationPlan';
import { runForgewingRepositoryPlanGuidance } from '@/lib/forgewing/tasks/repositoryPlanGuidance';

type WorkerClient = NonNullable<ReturnType<typeof createForgewingEngineeringWorkerClient>>;
export type RepositoryPlanWorkerFailureCode =
  | 'provider_disabled' | 'provider_timeout' | 'provider_failed' | 'invalid_provider_output'
  | 'trusted_source_invalid' | 'repository_mismatch' | 'persistence_failed' | 'worker_failed';

export type RepositoryPlanGenerationWorkerResult =
  | Readonly<{ status: 'idle' }>
  | Readonly<{ status: 'succeeded'; jobId: string; planV2RunId: string; providerCallCount: 0 | 1 }>
  | Readonly<{ status: 'failed'; jobId?: string; code: RepositoryPlanWorkerFailureCode }>;

export type RepositoryPlanGenerationWorkerDependencies = Readonly<{
  client?: WorkerClient | null;
  claim?: typeof claimRepositoryPlanGenerationJob;
  readSource?: typeof readRepositoryPlanGenerationSource;
  beginProvider?: typeof beginRepositoryPlanProviderCall;
  succeed?: typeof succeedRepositoryPlanGenerationJob;
  fail?: typeof failRepositoryPlanGenerationJob;
  verifySnapshot?: typeof verifyCurrentRepositorySnapshot;
  loadCatalog?: typeof loadRepositoryPlanEvidenceCatalog;
  collectContent?: typeof collectCommittedContent;
  runGuidance?: typeof runForgewingRepositoryPlanGuidance;
  persist?: typeof recordWorkflowRepositoryPlanV2;
}>;

function guidanceFailure(reason: string): RepositoryPlanWorkerFailureCode {
  if (reason === 'forgewing_disabled') return 'provider_disabled';
  if (reason === 'provider_timeout') return 'provider_timeout';
  if (reason === 'invalid_model_output' || reason === 'output_too_large'
    || reason === 'provider_truncated_output' || reason === 'invalid_guidance_input') {
    return 'invalid_provider_output';
  }
  return reason === 'provider_error' ? 'provider_failed' : 'worker_failed';
}

/** Runs at most one claimed classification job and never selects caller-supplied repository state. */
export async function runOneRepositoryPlanGenerationJob(
  repositoryRoot: string,
  dependencies: RepositoryPlanGenerationWorkerDependencies = {},
): Promise<RepositoryPlanGenerationWorkerResult> {
  const client = dependencies.client === undefined
    ? createForgewingEngineeringWorkerClient() : dependencies.client;
  if (!client) return { status: 'failed', code: 'worker_failed' };
  const claim = await (dependencies.claim ?? claimRepositoryPlanGenerationJob)(client);
  if (!claim.ok) return { status: 'failed', code: 'worker_failed' };
  if (!claim.job) return { status: 'idle' };
  const job = claim.job;
  const fail = async (code: RepositoryPlanWorkerFailureCode): Promise<RepositoryPlanGenerationWorkerResult> => {
    const outcome = await (dependencies.fail ?? failRepositoryPlanGenerationJob)(
      client, job.job_id, job.claim_token, code);
    return outcome.ok ? { status: 'failed', jobId: job.job_id, code }
      : { status: 'failed', jobId: job.job_id, code: 'worker_failed' };
  };

  try {
    const source = await (dependencies.readSource ?? readRepositoryPlanGenerationSource)(
      client, job.job_id, job.claim_token);
    if (!source.ok) return fail('trusted_source_invalid');
    const pin = { assessmentId: job.assessment_id, assessmentVersion: job.assessment_version,
      reviewId: job.review_id, reviewVersion: job.review_version };
    const resolved = resolveEffectiveReviewedSpecification({ pin,
      assessmentRow: source.source.assessment_row, reviewRow: source.source.review_row,
      stepReviewRows: source.source.step_review_rows });
    if (!resolved.ok) return fail('trusted_source_invalid');
    const planned = buildWorkflowImplementationPlan(resolved.artifact);
    if (!planned.ok || planned.artifact.digest.value !== job.implementation_plan_v1_digest_sha256
      || !planned.artifact.plannedSteps.some((step) => step.effectiveClassification === job.classification)) {
      return fail('trusted_source_invalid');
    }

    const verified = (dependencies.verifySnapshot ?? verifyCurrentRepositorySnapshot)(repositoryRoot);
    if (!verified.ok) return fail('repository_mismatch');
    const catalog = (dependencies.loadCatalog ?? loadRepositoryPlanEvidenceCatalog)({
      repositoryRoot, snapshot: verified.snapshot, classification: job.classification,
    });
    if (!catalog.ok) return fail('repository_mismatch');
    const foundation = buildRepositoryPlanFoundation({ trustedPlanV1: planned.artifact,
      repositorySnapshot: verified.snapshot, manifest: catalog.manifest, evidence: catalog.evidence,
      repositoryEvidenceCatalogDigestSha256: catalog.catalogDigestSha256 });
    if (!foundation.ok) return fail('trusted_source_invalid');
    const content = (dependencies.collectContent ?? collectCommittedContent)({ foundation: foundation.artifact,
      snapshot: verified.snapshot, classification: job.classification, repositoryRoot });
    if (!content.ok) return fail('repository_mismatch');
    const prepared = prepareRepositoryPlanGuidance({ trustedPlanV1: planned.artifact,
      foundation: foundation.artifact, content: content.bundle });
    if (!prepared.ok) return fail('trusted_source_invalid');

    const generated = await (dependencies.runGuidance ?? runForgewingRepositoryPlanGuidance)(prepared.artifact, {
      beforeProviderCall: async () => {
        const marked = await (dependencies.beginProvider ?? beginRepositoryPlanProviderCall)(
          client, job.job_id, job.claim_token);
        if (!marked.ok) throw new Error('provider marker failed');
      },
    });
    if (generated.status !== 'completed') return fail(guidanceFailure(
      generated.status === 'skipped' ? generated.reason : generated.reason));
    const persisted = await (dependencies.persist ?? recordWorkflowRepositoryPlanV2)(
      generated.planV2, generated.rawProviderEvidence, { admin: client });
    if (persisted.status !== 'recorded') return fail('persistence_failed');
    const completed = await (dependencies.succeed ?? succeedRepositoryPlanGenerationJob)(
      client, job.job_id, job.claim_token, persisted.planV2RunId);
    if (!completed.ok) return { status: 'failed', jobId: job.job_id, code: 'worker_failed' };
    return { status: 'succeeded', jobId: job.job_id, planV2RunId: persisted.planV2RunId,
      providerCallCount: generated.planV2.providerProvenance.callCount };
  } catch {
    return fail('worker_failed');
  }
}
