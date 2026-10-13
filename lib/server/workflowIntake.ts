// lib/server/workflowIntake.ts
// Server-side validation and append-only persistence for authenticated Forgewing
// workflow intake.
//
// This module owns raw source intake only. It must never import canonical,
// Validator, Project Truth, extraction, or Forgewing modules, and it must never
// derive, classify, score, or interpret an answer. A later Workflow Assessment
// phase reads these submissions by id and writes its own derived records
// elsewhere; the submission itself stays exactly as the visitor typed it.

import type { ActorContext } from '@/lib/server/getActorContext';
import { WORKFLOW_INTAKE_V2_FIELDS, type WorkflowIntakeV2Answers } from '@/lib/workflowIntakeContract';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WORKFLOW_INTAKE_SCHEMA_VERSION = 'workflow_intake_v2' as const;
export const WORKFLOW_INTAKE_TABLE = 'workflow_intake_submissions' as const;

/** Matches the per-answer CHECK constraints in the migration. */
export const WORKFLOW_INTAKE_MAX_ANSWER_LENGTH = 5_000;

/**
 * Request field -> column. The order is the dialog's step order and is the
 * contract the client posts against.
 */
const ANSWER_FIELDS = WORKFLOW_INTAKE_V2_FIELDS;

export type WorkflowIntakeField = (typeof ANSWER_FIELDS)[number][0];

export type WorkflowIntakeAnswers = WorkflowIntakeV2Answers;

export type WorkflowIntakeValidation =
  | Readonly<{ ok: true; answers: WorkflowIntakeAnswers }>
  | Readonly<{ ok: false; error: string }>;

export type WorkflowIntakePersistResult =
  | Readonly<{ status: 'persisted'; submissionId: string }>
  | Readonly<{ status: 'not_configured' }>
  | Readonly<{ status: 'failed'; reason: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validates the seven intake answers server-side. The browser is untrusted: every
 * field must be present, a string, non-empty after trimming, and within the
 * length the table will accept, so a rejected payload never reaches Postgres as
 * a constraint violation.
 */
export function validateWorkflowIntakeSubmission(body: unknown): WorkflowIntakeValidation {
  if (!isRecord(body)) return { ok: false, error: 'request body must be a JSON object' };

  const answers: Partial<Record<WorkflowIntakeField, string>> = {};
  for (const [field] of ANSWER_FIELDS) {
    const raw = body[field];
    if (typeof raw !== 'string') return { ok: false, error: `${field} is required` };
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, error: `${field} is required` };
    if (trimmed.length > WORKFLOW_INTAKE_MAX_ANSWER_LENGTH) {
      return {
        ok: false,
        error: `${field} must be ${WORKFLOW_INTAKE_MAX_ANSWER_LENGTH} characters or fewer`,
      };
    }
    answers[field] = trimmed;
  }

  const unknownField = Object.keys(body).find(
    (key) => !ANSWER_FIELDS.some(([field]) => field === key),
  );
  if (unknownField) return { ok: false, error: `unexpected field: ${unknownField}` };

  return { ok: true, answers: Object.freeze(answers as WorkflowIntakeAnswers) };
}

/** Submit an owned draft atomically; caller org/actor are verified server context. */
export async function persistWorkflowIntakeSubmission(
  answers: WorkflowIntakeAnswers,
  actor: Pick<ActorContext, 'actorId' | 'organizationId'>,
  draftId: string,
  dependencies: Readonly<{ admin?: ReturnType<typeof getSupabaseAdmin> }> = {},
): Promise<WorkflowIntakePersistResult> {
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return { status: 'not_configured' };
  const { data, error } = await admin.rpc('submit_workflow_assessment_draft', {
    p_draft_id: draftId,
    p_organization_id: actor.organizationId,
    p_actor_id: actor.actorId,
    p_answers: answers,
  });
  if (error) return { status: 'failed', reason: error.message };
  if (typeof data !== 'string' || !data) return { status: 'failed', reason: 'invalid_submission_result' };
  return { status: 'persisted', submissionId: data };
}
