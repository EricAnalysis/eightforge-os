import { z } from 'zod';

import { openGitCheckout, type GitAncestryFailureCode } from '@/lib/server/gitAncestry';

/**
 * Deployment proof for attested fixes (B8.4b). Trusted worker only.
 *
 * A fix is deployed only when its human-attested commit is an ancestor of a
 * production revision that the application itself observed (the first
 * production Validator run stamped with that revision). The proof is git
 * ancestry in the worker's own checkout; Vercel, Linear and PR state are never
 * consulted. Production revisions are tried in order of first observation, so
 * the recorded deployment is the earliest observed one containing the fix. If
 * any earlier revision cannot be checked, nothing is recorded for that fix:
 * a later revision must not stand in for an unknown earlier one.
 */

export const READ_IMPROVEMENT_DEPLOYMENT_WORK_FUNCTION = 'read_improvement_deployment_work' as const;
export const RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION = 'record_improvement_deployment' as const;

const sha1 = z.string().regex(/^[a-f0-9]{40}$/);
const WorkSchema = z.object({
  pending_attestations: z.array(z.object({ event_id: z.string().uuid(), fix_commit_sha: sha1 }).strict()).max(50),
  production_observations: z.array(z.object({
    revision: sha1, run_id: z.string().uuid(), observed_at: z.string().min(1),
  }).strict()).max(1000),
  observations_truncated: z.boolean(),
}).strict();
const RecordReceiptSchema = z.object({ event_id: z.string().uuid(), inserted: z.boolean() }).strict();

type RpcClient = Readonly<{ rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> }>;

export type DeploymentProofOutcome =
  | Readonly<{ implementedEventId: string; outcome: 'deployed'; productionRevision: string; eventId: string; inserted: boolean }>
  | Readonly<{ implementedEventId: string; outcome: 'not_yet_deployed' }>
  | Readonly<{ implementedEventId: string; outcome: 'unverifiable'; code: GitAncestryFailureCode; revision: string }>
  | Readonly<{ implementedEventId: string; outcome: 'record_failed' }>;

export type DeploymentProofRunResult =
  | Readonly<{ status: 'completed'; verifierCheckoutCommit: string; outcomes: readonly DeploymentProofOutcome[] }>
  | Readonly<{ status: 'failed'; code: 'read_failed' | 'invalid_work' | 'observations_truncated' | GitAncestryFailureCode }>;

export async function runImprovementDeploymentProof(
  client: RpcClient,
  repositoryRoot: string,
  dependencies: Readonly<{ openCheckout?: typeof openGitCheckout; limit?: number }> = {},
): Promise<DeploymentProofRunResult> {
  const opened = (dependencies.openCheckout ?? openGitCheckout)(repositoryRoot);
  if (!opened.ok) return { status: 'failed', code: opened.code };
  const { checkout } = opened;

  let read: { data: unknown; error: unknown };
  try {
    read = await client.rpc(READ_IMPROVEMENT_DEPLOYMENT_WORK_FUNCTION, { p_limit: dependencies.limit ?? 25 });
  } catch { return { status: 'failed', code: 'read_failed' }; }
  if (read.error) return { status: 'failed', code: 'read_failed' };
  const work = WorkSchema.safeParse(Array.isArray(read.data) ? read.data[0] : read.data);
  if (!work.success) return { status: 'failed', code: 'invalid_work' };
  // An incomplete revision list could hide the earliest deployment: refuse.
  if (work.data.observations_truncated) return { status: 'failed', code: 'observations_truncated' };

  const outcomes: DeploymentProofOutcome[] = [];
  for (const attestation of work.data.pending_attestations) {
    let decided: DeploymentProofOutcome | null = null;
    for (const observation of work.data.production_observations) {
      const proof = checkout.contains(attestation.fix_commit_sha, observation.revision);
      if (!proof.ok) {
        decided = { implementedEventId: attestation.event_id, outcome: 'unverifiable', code: proof.code,
          revision: observation.revision };
        break;
      }
      if (!proof.contains) continue;
      try {
        const recorded = await client.rpc(RECORD_IMPROVEMENT_DEPLOYMENT_FUNCTION, {
          p_implemented_event_id: attestation.event_id, p_production_revision: observation.revision,
          p_observation_run_id: observation.run_id, p_verifier_checkout_commit: checkout.headCommit,
        });
        const receipt = recorded.error ? null
          : RecordReceiptSchema.safeParse(Array.isArray(recorded.data) ? recorded.data[0] : recorded.data);
        decided = receipt?.success
          ? { implementedEventId: attestation.event_id, outcome: 'deployed', productionRevision: observation.revision,
            eventId: receipt.data.event_id, inserted: receipt.data.inserted }
          : { implementedEventId: attestation.event_id, outcome: 'record_failed' };
      } catch {
        decided = { implementedEventId: attestation.event_id, outcome: 'record_failed' };
      }
      break;
    }
    outcomes.push(decided ?? { implementedEventId: attestation.event_id, outcome: 'not_yet_deployed' });
  }
  return { status: 'completed', verifierCheckoutCommit: checkout.headCommit, outcomes };
}

// ---------------------------------------------------------------------------
// B8.4c: producer classification for measurement.
// ---------------------------------------------------------------------------

export const READ_CLASSIFICATION_WORK_FUNCTION = 'read_improvement_classification_work' as const;
export const RECORD_PRODUCER_CLASSIFICATION_FUNCTION = 'record_improvement_producer_classification' as const;

const ClassificationWorkSchema = z.array(z.object({
  deployed_event_id: z.string().uuid(), fix_commit_sha: sha1,
  revisions: z.array(sha1).max(500), revisions_truncated: z.boolean(),
}).strict()).max(25);

export type ProducerClassificationRunResult =
  | Readonly<{ status: 'completed'; verifierCheckoutCommit: string; classified: number; unverifiable: number;
    recordFailed: number; truncatedEvents: number }>
  | Readonly<{ status: 'failed'; code: 'read_failed' | 'invalid_work' | GitAncestryFailureCode }>;

/**
 * For each deployed fix still being measured, prove for every production
 * revision that produced the organization's units whether it contains the
 * attested commit. Revision SHAs only; no tenant content reaches the worker.
 * A revision the checkout cannot answer for stays unclassified, so its units
 * are excluded from measurement rather than guessed. A truncated list is
 * worked in passes: classified revisions drop out of the next read.
 */
export async function runImprovementProducerClassification(
  client: RpcClient,
  repositoryRoot: string,
  dependencies: Readonly<{ openCheckout?: typeof openGitCheckout; limit?: number }> = {},
): Promise<ProducerClassificationRunResult> {
  const opened = (dependencies.openCheckout ?? openGitCheckout)(repositoryRoot);
  if (!opened.ok) return { status: 'failed', code: opened.code };
  const { checkout } = opened;
  let read: { data: unknown; error: unknown };
  try {
    read = await client.rpc(READ_CLASSIFICATION_WORK_FUNCTION, { p_limit: dependencies.limit ?? 10 });
  } catch { return { status: 'failed', code: 'read_failed' }; }
  if (read.error) return { status: 'failed', code: 'read_failed' };
  const work = ClassificationWorkSchema.safeParse(read.data ?? []);
  if (!work.success) return { status: 'failed', code: 'invalid_work' };

  let classified = 0; let unverifiable = 0; let recordFailed = 0;
  for (const event of work.data) {
    for (const revision of event.revisions) {
      const proof = checkout.contains(event.fix_commit_sha, revision);
      if (!proof.ok) { unverifiable += 1; continue; }
      try {
        const recorded = await client.rpc(RECORD_PRODUCER_CLASSIFICATION_FUNCTION, {
          p_deployed_event_id: event.deployed_event_id, p_producer_revision: revision,
          p_contains_fix: proof.contains, p_verifier_checkout_commit: checkout.headCommit,
        });
        if (recorded.error) recordFailed += 1; else classified += 1;
      } catch { recordFailed += 1; }
    }
  }
  return { status: 'completed', verifierCheckoutCommit: checkout.headCommit, classified, unverifiable, recordFailed,
    truncatedEvents: work.data.filter((event) => event.revisions_truncated).length };
}
