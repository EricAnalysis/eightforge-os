// Records an answer to a follow-up the assessment left open. Platform-gated and scoped
// to the reviewer's own organization. Append-only: it edits neither the intake nor the
// assessment, and an answer is input for a reviewer, never truth. No provider is called.

import { z } from 'zod';

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { FOLLOW_UP_ANSWER_SOURCES, recordWorkflowFollowUpAnswer } from '@/lib/server/workflowFollowUpAnswers';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const Body = z.object({
  followUpId: z.string().regex(/^[0-9a-f]{64}$/u),
  answer: z.string().trim().min(1).max(4000),
  answerSource: z.enum(FOLLOW_UP_ANSWER_SOURCES),
  evidenceAttachmentIds: z.array(z.string().regex(UUID)).max(5).default([]),
}).strict();

const STATUS: Readonly<Record<string, number>> = {
  assessment_not_found: 404,
  follow_up_not_in_assessment: 404,
  evidence_not_in_submission: 400,
  revision_conflict: 409,
  write_failed: 500,
};

export async function POST(request: Request, context: { params: Promise<{ assessmentId: string }> }): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const { assessmentId } = await context.params;
  if (!UUID.test(assessmentId ?? '')) return Response.json({ ok: false, error: 'invalid_assessment_id' }, { status: 400 });
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ ok: false, error: 'invalid_answer' }, { status: 400 });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });

  const result = await recordWorkflowFollowUpAnswer(admin, {
    organizationId: actor.actor.organizationId, actorId: actor.actor.actorId, assessmentId, ...body.data,
  });
  if (result.status === 'recorded') return Response.json({ ok: true, answerId: result.answerId, revision: result.revision });
  return Response.json({ ok: false, error: result.status }, { status: STATUS[result.status] ?? 500 });
}
