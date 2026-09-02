// app/api/internal/workflow-assessment-sweep/route.ts
// The production caller that was missing between intake and assessment.
//
// Public intake persisted submissions that nothing ever assessed. This closes
// that gap using the pattern the repository already uses for internal work: a
// Vercel cron hitting a CRON_SECRET-gated internal route, exactly as
// forgewing-shadow-cleanup does.
//
// Anonymous submission still cannot cause provider spend. A visitor's request
// persists a row and returns; provider work happens only when this secret-gated
// caller runs, and even then:
//
//   - the assessment task is feature-flagged and provider-disabled by default,
//     so an unconfigured deployment sweeps and does nothing;
//   - one submission is assessed per invocation, so a backlog drains at the
//     cron's rate rather than in one unbounded burst;
//   - the task's own call budget bounds it to a single provider call.
//
// Nothing here writes canonical truth, Validator state, Project Truth,
// decisions, actions, or any executable rule. It produces a non-authoritative
// assessment that still requires human review.

import { timingSafeEqual } from 'node:crypto';

import { readPendingWorkflowAssessments } from '@/lib/server/workflowAssessmentPending';
import {
  isWorkflowAssessmentEnabled,
  runAndRecordWorkflowAssessment,
} from '@/lib/server/workflowAssessment';

export const runtime = 'nodejs';
export const maxDuration = 60;

function authorized(request: Request, secret: string): boolean {
  const provided = request.headers.get('authorization') ?? '';
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json({ ok: false, error: 'sweep_not_configured' }, { status: 503 });
  }
  if (!authorized(request, secret)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  // Checked before any read: a disabled deployment must not even look at
  // pending work, let alone approach the provider.
  if (!isWorkflowAssessmentEnabled()) {
    return Response.json({ ok: true, assessed: 0, reason: 'assessment_disabled' });
  }

  const pending = await readPendingWorkflowAssessments(1);
  if (pending.status !== 'ok') {
    return Response.json({ ok: false, error: pending.status }, { status: 503 });
  }
  const next = pending.pending[0];
  if (!next) {
    return Response.json({ ok: true, assessed: 0, reason: 'nothing_pending' });
  }

  // Exactly one submission per invocation. Bounded by construction rather than
  // by trusting a loop to stop.
  const result = await runAndRecordWorkflowAssessment(next.submissionId);

  return Response.json({
    ok: result.status === 'assessment_recorded',
    assessed: result.status === 'assessment_recorded' ? 1 : 0,
    // Reason codes only; the six intake answers describe a visitor's business
    // process and are never logged or returned from here.
    reason: result.status,
  }, { status: 200 });
}
