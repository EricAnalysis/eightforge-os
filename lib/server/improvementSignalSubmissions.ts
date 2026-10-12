import { randomUUID } from 'node:crypto';

import { hashCanonical } from '@/lib/extraction/domain/hash';
import {
  AllowlistedFrictionSignalSchema,
  type AllowlistedFrictionSignal,
} from '@/lib/resolution/frictionSignalAllowlist';
import { readFrictionReport, type FrictionReportReadBounds } from '@/lib/server/frictionReportRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Durable, organization-scoped submission of one friction signal for platform
 * triage (B8.3b). Trusted server only.
 *
 * The caller names a signal; it never supplies a payload. The server recomputes
 * the caller's organization's friction report, takes that signal's allowlisted
 * payload (B8.3a), re-validates it, and appends it with the read bounds, the
 * actor and the time. Customer text cannot be submitted because nothing but
 * the validated payload is written.
 *
 * Qualification-demand signals are a policy decision, not an engineering item
 * (they have no prefill), so they are not submittable.
 *
 * Idempotent: the same payload for the same organization is one submission.
 */

export const IMPROVEMENT_SIGNAL_SUBMISSIONS_TABLE = 'improvement_signal_submissions' as const;
export const IMPROVEMENT_SIGNAL_SUBMISSION_SCHEMA_VERSION = 'improvement_signal_submission_v1' as const;

export type ImprovementSignalSubmissionResult =
  | Readonly<{ status: 'submitted' | 'already_submitted'; submissionId: string; signalId: string; payloadDigestSha256: string }>
  | Readonly<{ status: 'signal_not_found' | 'not_submittable' | 'not_configured' }>
  | Readonly<{ status: 'read_failed' | 'persist_failed'; reason: string }>;

type InsertResult = PromiseLike<{ error: { code?: string; message?: string } | null }>;
type SelectResult = PromiseLike<{ data: unknown; error: unknown }>;
type SelectQuery = SelectResult & { eq(column: string, value: unknown): SelectQuery; limit(count: number): SelectQuery };
export type ImprovementSignalWriteClient = {
  from(table: string): {
    insert(row: Record<string, unknown>): InsertResult;
    select(columns: string): SelectQuery;
  };
};

export type ImprovementSignalSubmissionRow = Readonly<{
  id: string;
  organization_id: string;
  schema_version: typeof IMPROVEMENT_SIGNAL_SUBMISSION_SCHEMA_VERSION;
  signal_kind: AllowlistedFrictionSignal['signalKind'];
  signal_code: string;
  payload: AllowlistedFrictionSignal;
  payload_digest_sha256: string;
  read_bounds: FrictionReportReadBounds;
  submitted_by: string;
}>;

/** The row to append, from a validated payload. Pure. */
export function buildImprovementSignalSubmissionRow(params: Readonly<{
  id: string;
  organizationId: string;
  actorId: string;
  payload: AllowlistedFrictionSignal;
  readBounds: FrictionReportReadBounds;
}>): ImprovementSignalSubmissionRow {
  const payload = AllowlistedFrictionSignalSchema.parse(params.payload);
  return {
    id: params.id,
    organization_id: params.organizationId,
    schema_version: IMPROVEMENT_SIGNAL_SUBMISSION_SCHEMA_VERSION,
    signal_kind: payload.signalKind,
    signal_code: payload.code,
    payload,
    payload_digest_sha256: hashCanonical(payload),
    read_bounds: { ...params.readBounds },
    submitted_by: params.actorId,
  };
}

export async function submitImprovementSignal(
  request: Readonly<{ organizationId: string; actorId: string; signalId: string }>,
  dependencies: Readonly<{
    admin?: ImprovementSignalWriteClient | null;
    readReport?: typeof readFrictionReport;
    newId?: () => string;
  }> = {},
): Promise<ImprovementSignalSubmissionResult> {
  const admin = dependencies.admin === undefined
    ? getSupabaseAdmin() as unknown as ImprovementSignalWriteClient | null
    : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const read = await (dependencies.readReport ?? readFrictionReport)({ organizationId: request.organizationId });
  if (read.status === 'not_configured') return { status: 'not_configured' };
  if (read.status === 'read_failed') return { status: 'read_failed', reason: read.reason };

  const signal = read.report.signals.find((entry) => entry.signalId === request.signalId);
  if (!signal) return { status: 'signal_not_found' };
  if (signal.orchestratorPrefill == null) return { status: 'not_submittable' };

  const row = buildImprovementSignalSubmissionRow({
    id: (dependencies.newId ?? randomUUID)(),
    organizationId: request.organizationId,
    actorId: request.actorId,
    payload: signal.payload,
    readBounds: read.readBounds,
  });

  const { error } = await admin.from(IMPROVEMENT_SIGNAL_SUBMISSIONS_TABLE).insert({ ...row });
  if (!error) {
    return { status: 'submitted', submissionId: row.id, signalId: signal.signalId, payloadDigestSha256: row.payload_digest_sha256 };
  }
  if (error.code !== '23505') return { status: 'persist_failed', reason: error.message ?? 'insert_failed' };

  // Same payload already submitted for this organization: return that submission.
  const existing = await admin.from(IMPROVEMENT_SIGNAL_SUBMISSIONS_TABLE).select('id')
    .eq('organization_id', request.organizationId)
    .eq('payload_digest_sha256', row.payload_digest_sha256)
    .limit(1);
  const existingId = Array.isArray(existing.data) && typeof (existing.data[0] as { id?: unknown })?.id === 'string'
    ? (existing.data[0] as { id: string }).id
    : null;
  if (existing.error || !existingId) return { status: 'persist_failed', reason: 'duplicate_unreadable' };
  return { status: 'already_submitted', submissionId: existingId, signalId: signal.signalId,
    payloadDigestSha256: row.payload_digest_sha256 };
}
