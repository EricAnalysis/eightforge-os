// lib/server/workflowAssessment.ts
// Server seam for the Forgewing workflow assessment.
//
// This is the only production module permitted to reach the Forgewing workflow
// assessment task (see lib/architecture/importBoundaries.test.ts). It exists
// because the task itself is pure: Forgewing may not import a database client,
// so loading the immutable submission and appending the derived assessment
// happen here, on the trusted side of the boundary.
//
// The persisted intake submission is the sole authority for assessment input.
// Caller-supplied prose is never accepted: this module takes a submission id
// and reads the row through the SECURITY DEFINER seam.
//
// Nothing here writes canonical truth, Validator state, Project Truth,
// decisions, actions, or any executable rule. The output is a proposal.

import { randomUUID } from 'node:crypto';

import {
  runForgewingWorkflowAssessment,
  type ForgewingWorkflowAssessment,
} from '@/lib/forgewing/tasks/workflowAssessment';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WORKFLOW_ASSESSMENT_TABLE = 'workflow_assessments' as const;
import { loadWorkflowIntakeSubmission } from '@/lib/server/workflowIntakeRead';

// Re-exported so this module's public surface is unchanged. The
// implementation lives in a neutral module the review read seam also uses,
// so neither guarded seam has to import the other.
export {
  WORKFLOW_INTAKE_READ_FUNCTION,
  type LoadedWorkflowIntakeSubmission,
} from '@/lib/server/workflowIntakeRead';
export { loadWorkflowIntakeSubmission };

export type WorkflowAssessmentRunResult =
  | Readonly<{ status: 'submission_not_found' }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'assessment_not_produced'; reason: string }>
  | Readonly<{ status: 'persist_failed'; reason: string }>
  | Readonly<{
      status: 'assessment_recorded';
      assessmentId: string;
      sourceSubmissionId: string;
      assessmentVersion: number;
      requiresHumanReview: true;
      authority: 'non_authoritative';
    }>;

type AdminClient = NonNullable<ReturnType<typeof getSupabaseAdmin>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}


/**
 * Appends one assessment at the next version for its submission.
 *
 * The unique index on (source_submission_id, assessment_version) is what makes
 * this safe under concurrency: a racing writer loses the insert rather than
 * overwriting an existing interpretation.
 */
async function appendAssessment(
  admin: AdminClient,
  assessment: ForgewingWorkflowAssessment,
  runtime: Readonly<{ model: string; promptTemplateId: string; promptTemplateVersion: string }>,
): Promise<Readonly<{ ok: true; version: number }> | Readonly<{ ok: false; reason: string }>> {
  const existing = await admin
    .from(WORKFLOW_ASSESSMENT_TABLE)
    .select('assessment_version')
    .eq('source_submission_id', assessment.sourceSubmissionId)
    .order('assessment_version', { ascending: false })
    .limit(1);
  if (existing.error) return { ok: false, reason: existing.error.message };

  const latest = Array.isArray(existing.data) && isRecord(existing.data[0])
    && typeof existing.data[0].assessment_version === 'number'
    ? existing.data[0].assessment_version
    : 0;
  const assessmentVersion = latest + 1;

  const { error } = await admin.from(WORKFLOW_ASSESSMENT_TABLE).insert({
    // Row identity is a server-generated uuid; the assessment's own derived
    // assessmentId travels inside the validated payload.
    id: randomUUID(),
    source_submission_id: assessment.sourceSubmissionId,
    assessment_version: assessmentVersion,
    schema_version: assessment.schemaVersion,
    authority: assessment.authority,
    requires_human_review: assessment.requiresHumanReview,
    review_status: 'pending_human_review',
    assessment,
    assessment_digest_sha256: hashCanonical(assessment),
    model: runtime.model,
    prompt_template_id: runtime.promptTemplateId,
    prompt_template_version: runtime.promptTemplateVersion,
  });
  if (error) return { ok: false, reason: error.message };
  return { ok: true, version: assessmentVersion };
}

/**
 * Runs one bounded assessment for one persisted submission.
 *
 * Every failure mode leaves the intake row untouched: this function only ever
 * reads the submission and appends to a separate table.
 */
export async function runAndRecordWorkflowAssessment(
  submissionId: string,
): Promise<WorkflowAssessmentRunResult> {
  const admin = getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const submission = await loadWorkflowIntakeSubmission(submissionId, admin);
  if (!submission) return { status: 'submission_not_found' };

  const result = await runForgewingWorkflowAssessment({
    submissionId: submission.submissionId,
    submissionSchemaVersion: submission.submissionSchemaVersion,
    answers: submission.answers,
  });

  if (result.status !== 'requires_human_review') {
    // Reason codes only. The six answers describe a visitor's business process
    // and are never logged from here.
    return { status: 'assessment_not_produced', reason: result.status };
  }

  const appended = await appendAssessment(admin, result.assessment, result.metadata);
  if (!appended.ok) return { status: 'persist_failed', reason: appended.reason };

  return {
    status: 'assessment_recorded',
    assessmentId: result.assessment.assessmentId,
    sourceSubmissionId: result.assessment.sourceSubmissionId,
    assessmentVersion: appended.version,
    requiresHumanReview: true,
    authority: 'non_authoritative',
  };
}
