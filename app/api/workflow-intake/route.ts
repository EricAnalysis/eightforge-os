// app/api/workflow-intake/route.ts
// POST: accept one anonymous public Forgewing workflow intake submission.
//
// This is the only unauthenticated write path in the application, so the
// security model is stated explicitly:
//
//   1. The browser never touches Supabase. It posts JSON here.
//   2. Vercel BotID gates the request before any parsing or persistence.
//   3. All six answers are validated server-side.
//   4. The insert goes through the trusted admin seam into a table that grants
//      INSERT and nothing else, with an immutability trigger behind it.
//   5. The response carries a submission id and nothing more.
//
// Request throttling is enforced at the platform edge by a Vercel WAF
// rate_limit rule on this path, not in process: a per-instance counter would be
// nondeterministic across serverless invocations.
//
// V1 persists and acknowledges. No provider call, no notification, no derived
// assessment, no read path.

import { checkBotId } from 'botid/server';
import { NextResponse } from 'next/server';

import {
  persistWorkflowIntakeSubmission,
  validateWorkflowIntakeSubmission,
} from '@/lib/server/workflowIntake';

/** Injectable so tests exercise the route without the BotID runtime. */
export type WorkflowIntakeRouteDependencies = Readonly<{
  verify?: () => Promise<{ isBot: boolean }>;
  persist?: typeof persistWorkflowIntakeSubmission;
}>;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function handleWorkflowIntakeRequest(
  req: Request,
  dependencies: WorkflowIntakeRouteDependencies = {},
): Promise<NextResponse> {
  // Bot check first: an unverified client must not reach parsing or the database.
  // A failure to classify is treated as a bot, so the gate fails closed.
  let isBot: boolean;
  try {
    const verification = await (dependencies.verify ?? checkBotId)();
    isBot = verification.isBot;
  } catch {
    return jsonError('Access denied', 403);
  }
  if (isBot) return jsonError('Access denied', 403);

  const body = await req.json().catch(() => null);
  const validated = validateWorkflowIntakeSubmission(body);
  if (!validated.ok) return jsonError(validated.error, 400);

  const persisted = await (dependencies.persist ?? persistWorkflowIntakeSubmission)(
    validated.answers,
  );
  if (persisted.status === 'not_configured') {
    return jsonError('Workflow intake is not configured', 503);
  }
  if (persisted.status === 'failed') {
    // The database reason may describe schema internals; log it, return a
    // generic failure to an anonymous caller.
    console.error('[workflowIntake] submission persistence failed', {
      reason: persisted.reason,
    });
    return jsonError('Could not record submission', 500);
  }

  return NextResponse.json({ submissionId: persisted.submissionId }, { status: 201 });
}

export async function POST(req: Request) {
  return handleWorkflowIntakeRequest(req);
}
