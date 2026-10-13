// Authenticated organization-bound source intake. No provider or authority writes.
import { checkBotId } from 'botid/server';
import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';

import {
  persistWorkflowIntakeSubmission,
  validateWorkflowIntakeSubmission,
} from '@/lib/server/workflowIntake';

/** Injectable so tests exercise the route without the BotID runtime. */
export type WorkflowIntakeRouteDependencies = Readonly<{
  actor?: typeof getActorContext;
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
  const actorResult = await (dependencies.actor ?? getActorContext)(req);
  if (!actorResult.ok) return jsonError(actorResult.error, actorResult.status);

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
  if (!body || typeof body !== 'object' || Array.isArray(body)) return jsonError('Invalid request body', 400);
  const { draftId, ...answerBody } = body as Record<string, unknown>;
  if (typeof draftId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftId)) return jsonError('Valid draftId is required', 400);
  const validated = validateWorkflowIntakeSubmission(answerBody);
  if (!validated.ok) return jsonError(validated.error, 400);

  const persisted = await (dependencies.persist ?? persistWorkflowIntakeSubmission)(
    validated.answers, actorResult.actor, draftId,
  );
  if (persisted.status === 'not_configured') {
    return jsonError('Workflow intake is not configured', 503);
  }
  if (persisted.status === 'failed') {
    // The database reason may describe schema internals; log it, return a
    // generic failure to the caller.
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
