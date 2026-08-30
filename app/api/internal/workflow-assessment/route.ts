// app/api/internal/workflow-assessment/route.ts
// Internal-only trigger for one bounded Forgewing workflow assessment.
//
// Deliberately NOT wired to public submission. An anonymous visitor must never
// be able to cause a provider call, so intake persistence and assessment
// generation are separate steps and only an operator holding the internal
// secret can start the second one.
//
// There is no GET: assessments describe a visitor's business process and have
// no read path in V1, public or otherwise.

import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { runAndRecordWorkflowAssessment } from '@/lib/server/workflowAssessment';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get('authorization') ?? '');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const requestSchema = z.object({
  submissionId: z.string().trim().regex(UUID),
}).strict();

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'assessment_not_configured' }, { status: 503 });
  }
  if (!authorized(request, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const body = requestSchema.safeParse(await request.json().catch(() => null));
  // Only an id is accepted. Prose supplied by a caller is never assessed: the
  // persisted submission is the input authority.
  if (!body.success) {
    return Response.json({ ok: false, error: 'invalid assessment request' }, { status: 400 });
  }

  const result = await runAndRecordWorkflowAssessment(body.data.submissionId);

  switch (result.status) {
    case 'assessment_recorded':
      return Response.json({
        ok: true,
        assessmentId: result.assessmentId,
        sourceSubmissionId: result.sourceSubmissionId,
        assessmentVersion: result.assessmentVersion,
        authority: result.authority,
        requiresHumanReview: result.requiresHumanReview,
      }, { status: 201 });
    case 'submission_not_found':
      return Response.json({ ok: false, error: 'submission_not_found' }, { status: 404 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'assessment_not_configured' }, { status: 503 });
    case 'assessment_not_produced':
      return Response.json({ ok: false, error: result.reason }, { status: 422 });
    case 'persist_failed':
      console.error('[workflowAssessment] persistence failed', { reason: result.reason });
      return Response.json({ ok: false, error: 'assessment_not_recorded' }, { status: 500 });
  }
}
