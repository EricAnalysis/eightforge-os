// lib/server/workflowIntake.ts
// Server-side validation and append-only persistence for the public Forgewing
// workflow intake.
//
// This module owns raw source intake only. It must never import canonical,
// Validator, Project Truth, extraction, or Forgewing modules, and it must never
// derive, classify, score, or interpret an answer. A later Workflow Assessment
// phase reads these submissions by id and writes its own derived records
// elsewhere; the submission itself stays exactly as the visitor typed it.

import { randomUUID } from 'node:crypto';

import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export const WORKFLOW_INTAKE_SCHEMA_VERSION = 'workflow_intake_v1' as const;
export const WORKFLOW_INTAKE_TABLE = 'workflow_intake_submissions' as const;

/** Matches the per-answer CHECK constraints in the migration. */
export const WORKFLOW_INTAKE_MAX_ANSWER_LENGTH = 5_000;

/**
 * Request field -> column. The order is the dialog's step order and is the
 * contract the client posts against.
 */
const ANSWER_FIELDS = [
  ['workflowDescription', 'workflow_description'],
  ['documentsInvolved', 'documents_involved'],
  ['manualChecks', 'manual_checks'],
  ['frequencyAndVolume', 'frequency_and_volume'],
  ['exceptions', 'exceptions'],
  ['humanDecisions', 'human_decisions'],
] as const;

export type WorkflowIntakeField = (typeof ANSWER_FIELDS)[number][0];

export type WorkflowIntakeAnswers = Readonly<Record<WorkflowIntakeField, string>>;

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
 * Validates the six intake answers server-side. The browser is untrusted: every
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

/**
 * Appends one submission through the trusted admin seam.
 *
 * The identity is generated here rather than by the database because the table
 * grants INSERT and nothing else — there is no SELECT to read a default back
 * with, which is what keeps the write one-way.
 *
 * organization_id is intentionally not set: public intake has no tenant yet.
 */
export async function persistWorkflowIntakeSubmission(
  answers: WorkflowIntakeAnswers,
  dependencies: Readonly<{ admin?: ReturnType<typeof getSupabaseAdmin> }> = {},
): Promise<WorkflowIntakePersistResult> {
  const admin = dependencies.admin ?? getSupabaseAdmin();
  if (!admin) return { status: 'not_configured' };

  const submissionId = randomUUID();
  const row: Record<string, string> = {
    id: submissionId,
    schema_version: WORKFLOW_INTAKE_SCHEMA_VERSION,
  };
  for (const [field, column] of ANSWER_FIELDS) row[column] = answers[field];

  const { error } = await admin.from(WORKFLOW_INTAKE_TABLE).insert(row);
  if (error) return { status: 'failed', reason: error.message };

  return { status: 'persisted', submissionId };
}
