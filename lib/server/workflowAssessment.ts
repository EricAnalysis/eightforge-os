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
  type ForgewingWorkflowAssessmentResult,
} from '@/lib/forgewing/tasks/workflowAssessment';
import { hashCanonical } from '@/lib/extraction/domain/hash';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WORKFLOW_ASSESSMENT_TABLE = 'workflow_assessments' as const;
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
  dependencies: Readonly<{
    admin?: AdminClient | null;
    load?: typeof loadWorkflowIntakeSubmission;
    run?: (
      input: Parameters<typeof runForgewingWorkflowAssessment>[0],
    ) => Promise<ForgewingWorkflowAssessmentResult>;
  }> = {},
): Promise<WorkflowAssessmentRunResult> {
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { status: 'not_configured' };

  const submission = await (dependencies.load ?? loadWorkflowIntakeSubmission)(
    submissionId, admin,
  );
  if (!submission) return { status: 'submission_not_found' };

  const result = await (dependencies.run ?? runForgewingWorkflowAssessment)({
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
