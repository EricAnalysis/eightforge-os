// lib/server/workflowAssessmentPending.ts
// Discovering intake submissions that have not been assessed.
//
// Pending state is derived in the database from immutable evidence -- a
// submission with no assessment -- so there is no status flag to drift.
//
// Reading this list triggers nothing. It answers "is there work?", which is the
// question production could not previously ask at all. Running the work stays
// behind the existing bounded, feature-flagged assessment path.

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WORKFLOW_PENDING_ASSESSMENT_FUNCTION =
  'read_pending_workflow_assessments' as const;

export type PendingWorkflowAssessment = Readonly<{
  submissionId: string;
  schemaVersion: string;
  submittedAt: string;
}>;

export type PendingWorkflowAssessmentResult =
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'read_failed'; reason: string }>
  | Readonly<{ status: 'ok'; pending: readonly PendingWorkflowAssessment[] }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export async function readPendingWorkflowAssessments(
  limit = 25,
): Promise<PendingWorkflowAssessmentResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const { data, error } = await admin.rpc(WORKFLOW_PENDING_ASSESSMENT_FUNCTION, {
    p_limit: limit,
  });
  if (error) return { status: 'read_failed', reason: error.message };

  const pending = (Array.isArray(data) ? data : []).flatMap(
    (row): PendingWorkflowAssessment[] => {
      if (!isRecord(row)) return [];
      const submissionId = row.submission_id;
      const schemaVersion = row.schema_version;
      const submittedAt = row.submitted_at;
      if (typeof submissionId !== 'string' || typeof schemaVersion !== 'string') return [];
      return [{
        submissionId,
        schemaVersion,
        submittedAt: typeof submittedAt === 'string' ? submittedAt : '',
      }];
    },
  );

  return { status: 'ok', pending };
}
