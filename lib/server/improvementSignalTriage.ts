import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  TRIAGE_CAPABILITY_SCOPES,
  TRIAGE_DISPOSITIONS,
  TRIAGE_PLAN_CLASSIFICATIONS,
  TRIAGE_SEMANTICS_DEFECT_CLASSES,
  triageShapeError,
  type TriageDisposition,
} from '@/lib/improvementSignalTriageContract';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { IMPROVEMENT_SIGNAL_SUBMISSIONS_TABLE } from '@/lib/server/improvementSignalSubmissions';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

/**
 * Human triage of improvement signal submissions (B8.3c). Trusted server only.
 *
 * Authority is the existing platform-review allowlist
 * (`resolveWorkflowPlatformReviewAccess`); no new role. It is checked at the
 * route and again here. The reviewer is derived from the authenticated session,
 * never from a request body.
 *
 * Triage is append-only and versioned: a re-triage is the next version, and a
 * caller must name the version it saw (`expectedTriageVersion`), so two
 * reviewers can never silently overwrite each other. A triage decides where a
 * signal goes; it executes nothing:
 * - `route_to_engineering`: eligible for the existing Plan V2 path (B8.3d);
 * - `customer_config_or_mapping`: belongs in customer configuration / mapping;
 * - `reject`, `defer`.
 * A routed signal names its capability scope. A routed rule semantics review
 * carries the human defect classification, which replaces the development-only
 * Orchestrator form as its permanent home. The rationale stays platform-local.
 *
 * B8.3d: routing to engineering also records the Plan V2 classification the
 * reviewer chose (`planClassification`); nothing derives it. That triage row
 * is then the planning pin for the existing repository-plan path.
 */

export const IMPROVEMENT_SIGNAL_TRIAGE_TABLE = 'improvement_signal_triage_reviews' as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const improvementSignalTriageInputSchema = z.object({
  submissionId: z.string().uuid(),
  /** The latest triage version the reviewer saw; 0 when there was none. */
  expectedTriageVersion: z.number().int().min(0).max(2_147_483_646),
  disposition: z.enum(TRIAGE_DISPOSITIONS),
  capabilityScope: z.enum(TRIAGE_CAPABILITY_SCOPES).nullable().default(null),
  semanticsDefectClass: z.enum(TRIAGE_SEMANTICS_DEFECT_CLASSES).nullable().default(null),
  planClassification: z.enum(TRIAGE_PLAN_CLASSIFICATIONS).nullable().default(null),
  rationale: z.string().trim().min(1).max(4_000),
}).strict();
export type ImprovementSignalTriageInput = z.input<typeof improvementSignalTriageInputSchema>;

export type SessionDerivedTriageReviewer = Readonly<{ actorId: string; email: string | null; role: string | null }>;

export type ImprovementSignalTriageResult =
  | Readonly<{ status: 'triage_recorded'; triageId: string; triageVersion: number; disposition: TriageDisposition }>
  | Readonly<{ status: 'version_conflict'; currentTriageVersion: number }>
  | Readonly<{ status: 'reviewer_unresolved' | 'submission_not_found' | 'not_configured' }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'input_invalid' | 'read_failed' | 'persist_failed'; reason: string }>;

type Rows = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Query = Rows & {
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly string[]): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): Query;
};
export type TriageClient = {
  from(table: string): { select(columns: string): Query; insert(row: Record<string, unknown>): Rows };
};

function client(admin: TriageClient | null | undefined): TriageClient | null {
  return admin === undefined ? getSupabaseAdmin() as unknown as TriageClient | null : admin;
}

async function latestTriageVersion(admin: TriageClient, submissionId: string): Promise<number | null> {
  const read = await admin.from(IMPROVEMENT_SIGNAL_TRIAGE_TABLE).select('triage_version')
    .eq('submission_id', submissionId).order('triage_version', { ascending: false }).limit(1);
  if (read.error) return null;
  const version = Array.isArray(read.data) ? (read.data[0] as { triage_version?: unknown } | undefined)?.triage_version : undefined;
  return typeof version === 'number' ? version : 0;
}

export async function recordImprovementSignalTriage(
  input: ImprovementSignalTriageInput,
  reviewer: SessionDerivedTriageReviewer,
  dependencies: Readonly<{ admin?: TriageClient | null; newId?: () => string }> = {},
): Promise<ImprovementSignalTriageResult> {
  if (!reviewer || typeof reviewer.actorId !== 'string' || !UUID.test(reviewer.actorId)) {
    return { status: 'reviewer_unresolved' };
  }
  const access = resolveWorkflowPlatformReviewAccess(reviewer);
  if (!access.allowed) return { status: 'reviewer_not_eligible', reason: access.reason };

  const parsed = improvementSignalTriageInputSchema.safeParse(input);
  if (!parsed.success) {
    // Issue paths only: the rationale is never echoed or logged.
    return { status: 'input_invalid', reason: parsed.error.issues.map((issue) => issue.path.join('.')).join(',') || 'invalid' };
  }
  const triage = parsed.data;

  const admin = client(dependencies.admin);
  if (!admin) return { status: 'not_configured' };

  const submissionRead = await admin.from(IMPROVEMENT_SIGNAL_SUBMISSIONS_TABLE).select('id, organization_id, signal_kind')
    .eq('id', triage.submissionId).limit(1);
  if (submissionRead.error) return { status: 'read_failed', reason: 'submission_read_failed' };
  const submission = Array.isArray(submissionRead.data)
    ? submissionRead.data[0] as { id?: unknown; organization_id?: unknown; signal_kind?: unknown } | undefined
    : undefined;
  if (!submission || typeof submission.organization_id !== 'string' || typeof submission.signal_kind !== 'string') {
    return { status: 'submission_not_found' };
  }

  const shapeError = triageShapeError({ signalKind: submission.signal_kind, disposition: triage.disposition,
    capabilityScope: triage.capabilityScope, semanticsDefectClass: triage.semanticsDefectClass,
    planClassification: triage.planClassification });
  if (shapeError) return { status: 'input_invalid', reason: shapeError };

  const current = await latestTriageVersion(admin, triage.submissionId);
  if (current == null) return { status: 'read_failed', reason: 'triage_read_failed' };
  if (current !== triage.expectedTriageVersion) return { status: 'version_conflict', currentTriageVersion: current };

  const id = (dependencies.newId ?? randomUUID)();
  const triageVersion = current + 1;
  const { error } = await admin.from(IMPROVEMENT_SIGNAL_TRIAGE_TABLE).insert({
    id,
    submission_id: triage.submissionId,
    organization_id: submission.organization_id,
    signal_kind: submission.signal_kind,
    triage_version: triageVersion,
    disposition: triage.disposition,
    capability_scope: triage.capabilityScope,
    semantics_defect_class: triage.semanticsDefectClass,
    plan_classification: triage.planClassification,
    rationale: triage.rationale,
    reviewer_actor_id: reviewer.actorId,
  });
  if (error) {
    if (error.code === '23505') {
      const latest = await latestTriageVersion(admin, triage.submissionId);
      return { status: 'version_conflict', currentTriageVersion: latest ?? triageVersion };
    }
    return { status: 'persist_failed', reason: error.message ?? 'insert_failed' };
  }
  return { status: 'triage_recorded', triageId: id, triageVersion, disposition: triage.disposition };
}

export const TRIAGE_QUEUE_LIMIT = 100;

export type TriageQueueRow = Readonly<{
  submissionId: string;
  organizationId: string;
  signalKind: string;
  signalCode: string;
  payload: unknown;
  readBounds: unknown;
  submittedAt: string;
  latestTriage: Readonly<{
    triageReviewId: string;
    triageVersion: number;
    disposition: TriageDisposition;
    capabilityScope: string | null;
    semanticsDefectClass: string | null;
    planClassification: string | null;
    rationale: string;
    reviewerActorId: string;
    reviewedAt: string;
  }> | null;
  /** Untriaged or deferred. */
  awaitingTriage: boolean;
}>;

export type TriageQueueResult =
  | Readonly<{ status: 'ok'; rows: readonly TriageQueueRow[] }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>;

/** The most recent submissions with their latest triage. Platform reviewers only (checked by the route). */
export async function readImprovementSignalTriageQueue(
  dependencies: Readonly<{ admin?: TriageClient | null }> = {},
): Promise<TriageQueueResult> {
  const admin = client(dependencies.admin);
  if (!admin) return { status: 'not_configured' };
  const submissions = await admin.from(IMPROVEMENT_SIGNAL_SUBMISSIONS_TABLE)
    .select('id, organization_id, signal_kind, signal_code, payload, read_bounds, submitted_at')
    .order('submitted_at', { ascending: false }).limit(TRIAGE_QUEUE_LIMIT);
  if (submissions.error) return { status: 'read_failed', reason: 'submissions_read_failed' };
  const submissionRows = (Array.isArray(submissions.data) ? submissions.data : []) as Array<Record<string, unknown>>;
  const ids = submissionRows.flatMap((row) => typeof row.id === 'string' ? [row.id] : []);

  const latestBySubmission = new Map<string, Record<string, unknown>>();
  if (ids.length > 0) {
    const triages = await admin.from(IMPROVEMENT_SIGNAL_TRIAGE_TABLE)
      .select('id, submission_id, triage_version, disposition, capability_scope, semantics_defect_class, plan_classification, rationale, reviewer_actor_id, reviewed_at')
      .in('submission_id', ids);
    if (triages.error) return { status: 'read_failed', reason: 'triage_read_failed' };
    for (const row of (Array.isArray(triages.data) ? triages.data : []) as Array<Record<string, unknown>>) {
      const key = row.submission_id as string;
      const existing = latestBySubmission.get(key);
      if (!existing || (row.triage_version as number) > (existing.triage_version as number)) latestBySubmission.set(key, row);
    }
  }

  return {
    status: 'ok',
    rows: submissionRows.flatMap((row) => {
      if (typeof row.id !== 'string') return [];
      const latest = latestBySubmission.get(row.id);
      const latestTriage = latest ? {
        triageReviewId: latest.id as string,
        triageVersion: latest.triage_version as number,
        disposition: latest.disposition as TriageDisposition,
        capabilityScope: (latest.capability_scope as string | null) ?? null,
        semanticsDefectClass: (latest.semantics_defect_class as string | null) ?? null,
        planClassification: (latest.plan_classification as string | null) ?? null,
        rationale: latest.rationale as string,
        reviewerActorId: latest.reviewer_actor_id as string,
        reviewedAt: latest.reviewed_at as string,
      } : null;
      return [{
        submissionId: row.id,
        organizationId: row.organization_id as string,
        signalKind: row.signal_kind as string,
        signalCode: row.signal_code as string,
        payload: row.payload,
        readBounds: row.read_bounds,
        submittedAt: row.submitted_at as string,
        latestTriage,
        awaitingTriage: latestTriage == null || latestTriage.disposition === 'defer',
      }];
    }),
  };
}
