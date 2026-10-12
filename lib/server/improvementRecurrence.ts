import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { readFrictionReport } from '@/lib/server/frictionReportRead';
import { buildImprovementSignalSubmissionRow } from '@/lib/server/improvementSignalSubmissions';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

/**
 * B8.4d: a confirmed recurrence re-enters the improvement loop as a new
 * submission. Trusted server only; platform-review authority.
 *
 * The successor is the organization's CURRENT allowlisted friction signal for
 * the same problem, built by the shared submission builder (the same
 * allowlist and digest as any submission), never an edit of the original.
 * The database links it to the originating submission, engineering request,
 * deployment, measurement and decision, and refuses anything but the latest
 * `recurred_confirmed` decision. If the current report does not carry the
 * signal, nothing is created and the reason is returned.
 */

export const RECORD_RECURRENCE_SUCCESSOR_FUNCTION = 'record_improvement_recurrence_successor' as const;

export const RecurrenceSuccessorInputSchema = z.object({ decisionId: z.string().uuid() }).strict();

export type RecurrenceSuccessorResult =
  | Readonly<{ status: 'recorded'; successorId: string; successorSubmissionId: string; inserted: boolean }>
  | Readonly<{ status: 'reviewer_not_eligible' | 'invalid_input' | 'not_configured' | 'decision_not_found'
    | 'not_current_recurrence' | 'signal_not_current' | 'successor_repeats_submission' | 'read_failed'
    | 'successor_failed' }>;

type QueryResult = PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
type Query = QueryResult & { eq(column: string, value: unknown): Query; limit(count: number): Query };
export type RecurrenceAdmin = {
  from(table: string): { select(columns: string): Query };
  rpc(name: string, args: Record<string, unknown>): QueryResult;
};

const ERRORS: Readonly<Record<string, Exclude<RecurrenceSuccessorResult['status'], 'recorded'>>> = {
  P0002: 'decision_not_found', B8409: 'not_current_recurrence', B8410: 'successor_repeats_submission',
  B8406: 'successor_failed', '22023': 'invalid_input',
};

async function first(query: QueryResult): Promise<Record<string, unknown> | null> {
  const { data, error } = await query;
  if (error) throw new Error(error.code ?? 'read_failed');
  return Array.isArray(data) && data[0] && typeof data[0] === 'object' ? data[0] as Record<string, unknown> : null;
}

export async function recordRecurrenceSuccessor(
  input: unknown,
  reviewer: Readonly<{ actorId: string; email: string | null; role: string | null }>,
  dependencies: Readonly<{ admin?: RecurrenceAdmin | null; readReport?: typeof readFrictionReport; newId?: () => string }> = {},
): Promise<RecurrenceSuccessorResult> {
  if (!resolveWorkflowPlatformReviewAccess(reviewer).allowed) return { status: 'reviewer_not_eligible' };
  const parsed = RecurrenceSuccessorInputSchema.safeParse(input);
  if (!parsed.success) return { status: 'invalid_input' };
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() as unknown as RecurrenceAdmin | null : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  let origin: Record<string, unknown> | null;
  try {
    const decision = await first(admin.from('improvement_measurement_decisions')
      .select('id, deployed_event_id, decision').eq('id', parsed.data.decisionId).limit(1));
    if (!decision) return { status: 'decision_not_found' };
    if (decision.decision !== 'recurred_confirmed') return { status: 'not_current_recurrence' };
    const deployed = await first(admin.from('improvement_lifecycle_events')
      .select('id, submission_id').eq('id', decision.deployed_event_id).eq('event_kind', 'deployed').limit(1));
    origin = deployed ? await first(admin.from('improvement_signal_submissions')
      .select('id, organization_id, signal_kind, signal_code').eq('id', deployed.submission_id).limit(1)) : null;
  } catch {
    return { status: 'read_failed' };
  }
  if (!origin || typeof origin.organization_id !== 'string') return { status: 'decision_not_found' };

  const read = await (dependencies.readReport ?? readFrictionReport)({ organizationId: origin.organization_id });
  if (read.status !== 'ok') return { status: 'read_failed' };
  const signal = read.report.signals.find((entry) =>
    entry.payload.signalKind === origin!.signal_kind && entry.payload.code === origin!.signal_code);
  if (!signal) return { status: 'signal_not_current' };

  let row: ReturnType<typeof buildImprovementSignalSubmissionRow>;
  try {
    row = buildImprovementSignalSubmissionRow({ id: (dependencies.newId ?? randomUUID)(),
      organizationId: origin.organization_id, actorId: reviewer.actorId, payload: signal.payload,
      readBounds: read.readBounds });
  } catch {
    return { status: 'successor_failed' };
  }
  try {
    const recorded = await admin.rpc(RECORD_RECURRENCE_SUCCESSOR_FUNCTION, {
      p_decision_id: parsed.data.decisionId, p_successor_submission_id: row.id, p_schema_version: row.schema_version,
      p_payload: row.payload, p_payload_digest_sha256: row.payload_digest_sha256, p_read_bounds: row.read_bounds,
      p_recorded_by: reviewer.actorId,
    });
    if (recorded.error) return { status: (recorded.error.code && ERRORS[recorded.error.code]) || 'successor_failed' };
    const receipt = Array.isArray(recorded.data) ? recorded.data[0] as Record<string, unknown> | undefined : undefined;
    if (!receipt || typeof receipt.successor_id !== 'string' || typeof receipt.successor_submission_id !== 'string') {
      return { status: 'successor_failed' };
    }
    return { status: 'recorded', successorId: receipt.successor_id, successorSubmissionId: receipt.successor_submission_id,
      inserted: receipt.inserted === true };
  } catch {
    return { status: 'successor_failed' };
  }
}
