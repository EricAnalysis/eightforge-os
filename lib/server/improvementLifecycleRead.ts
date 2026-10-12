import { z } from 'zod';

import { improvementSourceMeasurability } from '@/lib/improvementMeasurement';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

/**
 * B8.4d: everything recorded about one improvement submission after triage,
 * for the platform triage view. Read-only and bounded. It shows evidence; it
 * derives no state the database did not record:
 * - approved engineering requests of the submission's triage-sourced plans
 *   (the attestation targets), each with its Linear copy status, which is an
 *   outbound projection only and never decides anything here;
 * - the append-only lifecycle (implemented, deployed, measuring,
 *   measurement_completed);
 * - every measurement snapshot (counts, windows, outcome, reasons);
 * - every human decision, and recurrence successors with their links.
 */

const MAX_ROWS = 200;

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Query = QueryResult & {
  eq(column: string, value: unknown): Query; in(column: string, values: readonly unknown[]): Query;
  order(column: string, options?: { ascending?: boolean }): Query; limit(count: number): Query;
};
export type LifecycleReadAdmin = { from(table: string): { select(columns: string): Query } };

class ReadFailed extends Error {}
async function read(query: QueryResult): Promise<Record<string, unknown>[]> {
  const { data, error } = await query;
  if (error) throw new ReadFailed(error.code ?? 'read_failed');
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}
const ids = (rows: readonly Record<string, unknown>[], key: string) =>
  [...new Set(rows.flatMap((row) => typeof row[key] === 'string' ? [row[key] as string] : []))];

export type ImprovementLifecycleView = Readonly<{
  submissionId: string;
  measurable: boolean;
  engineeringRequests: readonly Readonly<{
    reviewId: string; reviewVersion: number; planV2RunId: string; planV2DigestSha256: string;
    recommendationId: string; disposition: string; current: boolean; linearStatus: string | null;
    linearIssueIdentifier: string | null;
  }>[];
  events: readonly Record<string, unknown>[];
  snapshots: readonly Record<string, unknown>[];
  decisions: readonly Record<string, unknown>[];
  successors: readonly Record<string, unknown>[];
  /** Present when this submission is itself the successor of a confirmed recurrence. */
  predecessor: Record<string, unknown> | null;
}>;

export const ImprovementLifecycleQuerySchema = z.object({ submissionId: z.string().uuid() }).strict();

export async function readImprovementLifecycle(
  query: unknown,
  reviewer: Readonly<{ email: string | null; role: string | null }>,
  dependencies: Readonly<{ admin?: LifecycleReadAdmin | null }> = {},
): Promise<Readonly<{ status: 'ok'; view: ImprovementLifecycleView }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'invalid_input' | 'not_configured' | 'read_failed' }>> {
  if (!resolveWorkflowPlatformReviewAccess(reviewer).allowed) return { status: 'reviewer_not_eligible' };
  const parsed = ImprovementLifecycleQuerySchema.safeParse(query);
  if (!parsed.success) return { status: 'invalid_input' };
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() as unknown as LifecycleReadAdmin | null : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const { submissionId } = parsed.data;
  try {
    const triages = await read(admin.from('improvement_signal_triage_reviews').select('id')
      .eq('submission_id', submissionId).limit(MAX_ROWS));
    const runs = triages.length === 0 ? [] : await read(admin.from('workflow_repository_plan_v2_runs')
      .select('id, plan_v2_digest_sha256').in('triage_review_id', ids(triages, 'id')).limit(MAX_ROWS));
    const reviews = runs.length === 0 ? [] : await read(admin.from('workflow_repository_plan_recommendation_reviews')
      .select('id, review_version, plan_v2_run_id, plan_v2_digest_sha256, recommendation_id, disposition')
      .in('plan_v2_run_id', ids(runs, 'id')).order('review_version', { ascending: true }).limit(MAX_ROWS));
    const correlations = reviews.length === 0 ? [] : await read(admin.from('linear_projection_correlations')
      .select('review_id, status, linear_issue_identifier').in('review_id', ids(reviews, 'id')).limit(MAX_ROWS));
    const latestVersion = new Map<string, number>();
    for (const review of reviews) {
      const key = `${review.plan_v2_run_id}:${review.recommendation_id}`;
      latestVersion.set(key, Math.max(latestVersion.get(key) ?? 0, Number(review.review_version)));
    }
    const engineeringRequests = reviews.filter((review) => review.disposition === 'accepted' || review.disposition === 'modified')
      .map((review) => {
        const linear = correlations.find((row) => row.review_id === review.id);
        return {
          reviewId: String(review.id), reviewVersion: Number(review.review_version),
          planV2RunId: String(review.plan_v2_run_id), planV2DigestSha256: String(review.plan_v2_digest_sha256),
          recommendationId: String(review.recommendation_id), disposition: String(review.disposition),
          current: latestVersion.get(`${review.plan_v2_run_id}:${review.recommendation_id}`) === Number(review.review_version),
          linearStatus: linear ? String(linear.status) : null,
          linearIssueIdentifier: typeof linear?.linear_issue_identifier === 'string' ? linear.linear_issue_identifier : null,
        };
      });
    const events = await read(admin.from('improvement_lifecycle_events')
      .select('id, event_kind, engineering_review_id, engineering_review_version, fix_commit_sha, attested_by, '
        + 'implemented_event_id, production_revision, ancestry_method, verifier_checkout_commit, '
        + 'deployment_observation_id, deployment_observed_at, deployed_event_id, measurement_snapshot_id, recorded_at')
      .eq('submission_id', submissionId).order('recorded_at', { ascending: true }).limit(MAX_ROWS));
    const snapshots = await read(admin.from('improvement_measurement_snapshots')
      .select('id, deployed_event_id, problem_key, policy_version, window_policy_version, baseline_from, baseline_to, '
        + 'post_from, post_to, baseline_exposure, baseline_occurrences, post_exposure, post_occurrences, outcome, '
        + 'reasons, measurement_digest_sha256, read_bounds, measured_by, measured_at')
      .eq('submission_id', submissionId).order('measured_at', { ascending: true }).limit(MAX_ROWS));
    const deployedIds = events.filter((event) => event.event_kind === 'deployed').flatMap((event) => String(event.id));
    const decisions = deployedIds.length === 0 ? [] : await read(admin.from('improvement_measurement_decisions')
      .select('id, deployed_event_id, snapshot_id, decision_version, decision, rationale, reviewer_actor_id, decided_at')
      .in('deployed_event_id', deployedIds).order('decision_version', { ascending: true }).limit(MAX_ROWS));
    const successors = await read(admin.from('improvement_recurrence_successors')
      .select('id, originating_submission_id, successor_submission_id, engineering_review_id, deployed_event_id, '
        + 'snapshot_id, decision_id, recorded_by, recorded_at')
      .eq('originating_submission_id', submissionId).order('recorded_at', { ascending: true }).limit(MAX_ROWS));
    const [predecessor] = await read(admin.from('improvement_recurrence_successors')
      .select('id, originating_submission_id, successor_submission_id, engineering_review_id, deployed_event_id, '
        + 'snapshot_id, decision_id, recorded_by, recorded_at')
      .eq('successor_submission_id', submissionId).limit(1));
    return { status: 'ok', view: {
      submissionId,
      // Every submission here is a triaged signal: it carries originating friction.
      measurable: improvementSourceMeasurability({ sourceKind: 'triaged_improvement_signal' }).measurable,
      engineeringRequests, events, snapshots, decisions, successors, predecessor: predecessor ?? null,
    } };
  } catch {
    return { status: 'read_failed' };
  }
}
