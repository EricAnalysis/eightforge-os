// lib/server/workflowIntakeRead.ts
// The single read path for one immutable workflow intake submission.
//
// This lives on its own because two seams legitimately need it: the assessment
// runner and the review surface's read seam. Neither may import the other --
// architecture guards confine each to one authorized consumer -- and
// duplicating the read would create a second interpretation of the same row.
// A neutral module keeps one implementation without widening either boundary.

import { WORKFLOW_INTAKE_V1_FIELDS, WORKFLOW_INTAKE_V2_FIELDS, type VersionedWorkflowIntake } from '@/lib/workflowIntakeContract';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

type AdminClient = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export const WORKFLOW_INTAKE_READ_FUNCTION = 'read_workflow_intake_submission' as const;

export type LoadedWorkflowIntakeSubmission = VersionedWorkflowIntake & Readonly<{
  submissionId: string; organizationId: string | null; submittedByActorId: string | null;
  attachmentManifest?: unknown;
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
  organizationId?: string,
): Promise<LoadedWorkflowIntakeSubmission | null> {
  const { data, error } = await admin.rpc(WORKFLOW_INTAKE_READ_FUNCTION, {
    submission_id: submissionId,
  });
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  if (!isRecord(row)) return null;
  if (typeof row.id !== 'string' || row.id !== submissionId) return null;
  if (organizationId !== undefined && row.organization_id !== organizationId) return null;
  if (row.schema_version !== 'workflow_intake_v1' && row.schema_version !== 'workflow_intake_v2') return null;
  const answerColumns = row.schema_version === 'workflow_intake_v1'
    ? WORKFLOW_INTAKE_V1_FIELDS : WORKFLOW_INTAKE_V2_FIELDS;

  const answers: Record<string, string> = {};
  for (const [field, column] of answerColumns) {
    const value = row[column];
    if (typeof value !== 'string' || value.trim().length === 0) return null;
    answers[field] = value;
  }

  return Object.freeze({
    submissionId: row.id,
    organizationId: typeof row.organization_id === 'string' ? row.organization_id : null,
    submittedByActorId: typeof row.submitted_by_actor_id === 'string' ? row.submitted_by_actor_id : null,
    ...(row.attachment_manifest === undefined ? {} : { attachmentManifest: row.attachment_manifest }),
    submissionSchemaVersion: row.schema_version,
    answers: Object.freeze(answers),
  }) as LoadedWorkflowIntakeSubmission;
}
