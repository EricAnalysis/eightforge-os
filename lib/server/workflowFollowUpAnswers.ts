import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { allFdeFollowUps } from '@/lib/projectIntelligence/fdeReadiness';
import { loadWorkflowIntakeSubmission } from '@/lib/server/workflowIntakeRead';

/**
 * Answers to the follow-ups a Workflow Assessment left open. Trusted server only.
 *
 * An answer is input for a reviewer, never canonical truth. It is appended beside
 * the assessment: the intake, the assessment and its reviews are not touched, and
 * no truth, Validator, pricing or configuration path reads it. Changing an answer
 * appends a revision that points at the one it replaces.
 *
 * The caller names a follow-up and supplies the answer. The question, its kind and
 * its step come from the assessment, so nothing can be recorded against a question
 * the assessment did not ask. No provider is called.
 */

export const WORKFLOW_FOLLOW_UP_ANSWERS_TABLE = 'workflow_assessment_follow_up_answers';

export const FOLLOW_UP_ANSWER_SOURCES = ['customer_stated', 'found_in_supplied_evidence'] as const;
export type FollowUpAnswerSource = typeof FOLLOW_UP_ANSWER_SOURCES[number];

export type WorkflowFollowUpAnswer = Readonly<{
  answerId: string;
  followUpId: string;
  stepId: string | null;
  question: string;
  answer: string;
  answerSource: FollowUpAnswerSource;
  evidenceAttachmentIds: readonly string[];
  revision: number;
  supersedesAnswerId: string | null;
  assessmentId: string;
  assessmentVersion: number;
  answeredBy: string;
  answeredAt: string;
}>;

/** Every revision of every answer to one submission's follow-ups, oldest first. */
export async function readWorkflowFollowUpAnswers(
  admin: Pick<SupabaseClient, 'from'>,
  params: Readonly<{ organizationId: string; sourceSubmissionId: string }>,
): Promise<readonly WorkflowFollowUpAnswer[]> {
  const { data, error } = await admin.from(WORKFLOW_FOLLOW_UP_ANSWERS_TABLE)
    .select('id, follow_up_id, step_id, question_snapshot, answer_text, answer_source, evidence_attachment_ids, revision, supersedes_answer_id, assessment_id, assessment_version, answered_by, answered_at')
    .eq('organization_id', params.organizationId).eq('source_submission_id', params.sourceSubmissionId)
    .order('answered_at', { ascending: true }).order('revision', { ascending: true });
  if (error) throw new Error('Failed to read follow-up answers.');
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    answerId: String(row.id),
    followUpId: String(row.follow_up_id),
    stepId: row.step_id == null ? null : String(row.step_id),
    question: String(row.question_snapshot),
    answer: String(row.answer_text),
    answerSource: row.answer_source as FollowUpAnswerSource,
    evidenceAttachmentIds: (row.evidence_attachment_ids as string[] | null) ?? [],
    revision: Number(row.revision),
    supersedesAnswerId: row.supersedes_answer_id == null ? null : String(row.supersedes_answer_id),
    assessmentId: String(row.assessment_id),
    assessmentVersion: Number(row.assessment_version),
    answeredBy: String(row.answered_by),
    answeredAt: String(row.answered_at),
  }));
}

export type RecordFollowUpAnswerResult =
  | Readonly<{ status: 'recorded'; answerId: string; revision: number }>
  | Readonly<{ status: 'assessment_not_found' | 'follow_up_not_in_assessment' | 'evidence_not_in_submission' | 'revision_conflict' | 'write_failed' }>;

export async function recordWorkflowFollowUpAnswer(
  admin: NonNullable<Parameters<typeof loadWorkflowIntakeSubmission>[1]> & Pick<SupabaseClient, 'from'>,
  params: Readonly<{
    organizationId: string;
    actorId: string;
    assessmentId: string;
    followUpId: string;
    answer: string;
    answerSource: FollowUpAnswerSource;
    evidenceAttachmentIds: readonly string[];
    newId?: () => string;
  }>,
): Promise<RecordFollowUpAnswerResult> {
  const assessment = await admin.from('workflow_assessments')
    .select('id, source_submission_id, assessment_version, assessment')
    .eq('id', params.assessmentId).maybeSingle();
  if (assessment.error) return { status: 'write_failed' };
  const row = assessment.data as { source_submission_id: string; assessment_version: number; assessment: unknown } | null;
  if (!row) return { status: 'assessment_not_found' };

  // The intake decides the tenant, and a submission with no organization has none to answer for.
  const submission = await loadWorkflowIntakeSubmission(row.source_submission_id, admin);
  if (!submission || submission.organizationId !== params.organizationId) return { status: 'assessment_not_found' };

  const followUp = allFdeFollowUps(row.assessment).find((entry) => entry.followUpId === params.followUpId);
  if (!followUp) return { status: 'follow_up_not_in_assessment' };

  const evidence = [...new Set(params.evidenceAttachmentIds)];
  if (evidence.length > 0) {
    const files = await admin.from('workflow_assessment_attachments').select('id')
      .eq('draft_id', row.source_submission_id).eq('organization_id', params.organizationId)
      .is('removed_at', null).in('id', evidence);
    if (files.error) return { status: 'write_failed' };
    if ((files.data ?? []).length !== evidence.length) return { status: 'evidence_not_in_submission' };
  }

  const prior = await admin.from(WORKFLOW_FOLLOW_UP_ANSWERS_TABLE).select('id, revision')
    .eq('organization_id', params.organizationId).eq('source_submission_id', row.source_submission_id).eq('follow_up_id', followUp.followUpId)
    .order('revision', { ascending: false }).limit(1);
  if (prior.error) return { status: 'write_failed' };
  const latest = ((prior.data ?? [])[0] as { id: string; revision: number } | undefined) ?? null;

  const answerId = (params.newId ?? randomUUID)();
  const revision = (latest?.revision ?? 0) + 1;
  const { error } = await admin.from(WORKFLOW_FOLLOW_UP_ANSWERS_TABLE).insert({
    id: answerId,
    organization_id: params.organizationId,
    source_submission_id: row.source_submission_id,
    assessment_id: params.assessmentId,
    assessment_version: row.assessment_version,
    follow_up_id: followUp.followUpId,
    follow_up_kind: followUp.kind,
    step_id: followUp.stepId,
    question_snapshot: followUp.question.trim().slice(0, 2000),
    answer_text: params.answer.trim(),
    answer_source: params.answerSource,
    evidence_attachment_ids: evidence,
    revision,
    supersedes_answer_id: latest?.id ?? null,
    answered_by: params.actorId,
  });
  if (error) return { status: error.code === '23505' ? 'revision_conflict' : 'write_failed' };
  return { status: 'recorded', answerId, revision };
}
