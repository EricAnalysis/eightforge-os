// lib/server/workflowIntakeRead.ts
// The single read path for one immutable workflow intake submission.
//
// This lives on its own because two seams legitimately need it: the assessment
// runner and the review surface's read seam. Neither may import the other --
// architecture guards confine each to one authorized consumer -- and
// duplicating the read would create a second interpretation of the same row.
// A neutral module keeps one implementation without widening either boundary.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

type AdminClient = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export const WORKFLOW_INTAKE_READ_FUNCTION = 'read_workflow_intake_submission' as const;

/** Request/column pairs, mirroring the intake contract exactly. */
const ANSWER_COLUMNS = [
  ['workflowDescription', 'workflow_description'],
  ['documentsInvolved', 'documents_involved'],
  ['manualChecks', 'manual_checks'],
  ['frequencyAndVolume', 'frequency_and_volume'],
  ['exceptions', 'exceptions'],
  ['humanDecisions', 'human_decisions'],
] as const;

export type LoadedWorkflowIntakeSubmission = Readonly<{
  submissionId: string;
  submissionSchemaVersion: string;
  answers: Readonly<Record<(typeof ANSWER_COLUMNS)[number][0], string>>;
}>;

/**
 * Reads one immutable submission through the SECURITY DEFINER seam.
 *
 * The intake table grants INSERT only, so this RPC is the single auditable read
 * path. It requires a known id, so it cannot be used to enumerate submissions.
 */
export async function loadWorkflowIntakeSubmission(
  submissionId: string,
  admin: AdminClient,
): Promise<LoadedWorkflowIntakeSubmission | null> {
  const { data, error } = await admin.rpc(WORKFLOW_INTAKE_READ_FUNCTION, {
    submission_id: submissionId,
  });
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) return null;
  if (typeof row.id !== 'string' || row.id !== submissionId) return null;
  if (typeof row.schema_version !== 'string') return null;

  const answers: Partial<Record<(typeof ANSWER_COLUMNS)[number][0], string>> = {};
  for (const [field, column] of ANSWER_COLUMNS) {
    const value = row[column];
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    answers[field] = value;
  }

  return Object.freeze({
    submissionId: row.id,
    submissionSchemaVersion: row.schema_version,
    answers: Object.freeze(answers as LoadedWorkflowIntakeSubmission['answers']),
  });
}
