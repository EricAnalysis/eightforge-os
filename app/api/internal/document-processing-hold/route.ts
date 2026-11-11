// app/api/internal/document-processing-hold/route.ts
//
// Operator control for the platform-wide document processing hold.
//
//   GET  -> current hold state and drain state (read-only)
//   POST -> { action: 'hold' | 'release', requestKey: uuid, reason: string }
//
// Authority: the platform-operator allowlist (INTERNAL_ORCHESTRATOR_ALLOWED_*),
// fail-closed when unconfigured. Organization admins are not operators: the
// hold stops processing for every tenant. The actor comes from the verified
// session, never the body; the body schema is strict.
//
// Every POST is recorded in document_processing_hold_transitions, including
// no-op repeats. Re-sending the same requestKey with the same request replays
// the recorded result; with a different request it is a 409. Nothing here
// releases a hold implicitly, and nothing touches jobs, documents or output.

import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';
import {
  readDocumentProcessingHoldState,
  setDocumentProcessingHold,
} from '@/lib/server/documentProcessingHold';

export const runtime = 'nodejs';
export const maxDuration = 30;

const HoldTransitionSchema = z.object({
  action: z.enum(['hold', 'release']),
  requestKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
}).strict();

async function authorize(request: Request) {
  const actor = await getActorContext(request);
  if (!actor.ok) {
    return { ok: false as const, response: Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status }) };
  }
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return {
      ok: false as const,
      response: Response.json({ ok: false, error: 'operator_not_eligible', reason: access.reason }, { status: 403 }),
    };
  }
  return { ok: true as const, actor: actor.actor };
}

export async function GET(request: Request): Promise<Response> {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;
  const result = await readDocumentProcessingHoldState(getSupabaseAdmin());
  if (result.status === 'ok') return Response.json({ ok: true, state: result.state });
  console.error('[document-processing-hold] state read failed', { message: result.message });
  return Response.json(
    { ok: false, error: result.status === 'not_configured' ? 'not_configured' : 'hold_state_unavailable' },
    { status: result.status === 'not_configured' ? 503 : 502 },
  );
}

export async function POST(request: Request): Promise<Response> {
  const auth = await authorize(request);
  if (!auth.ok) return auth.response;

  const body = HoldTransitionSchema.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 });
  }

  const result = await setDocumentProcessingHold(getSupabaseAdmin(), {
    requestKey: body.data.requestKey,
    action: body.data.action,
    reason: body.data.reason,
    actorId: auth.actor.actorId,
    actorEmail: auth.actor.email,
  });
  switch (result.status) {
    case 'ok':
      return Response.json({ ok: true, transition: result.transition });
    case 'replay_conflict':
      return Response.json({ ok: false, error: 'request_key_conflict' }, { status: 409 });
    case 'invalid_input':
      return Response.json({ ok: false, error: 'invalid_request' }, { status: 400 });
    case 'not_configured':
      return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
    case 'failed': {
      const incident = randomUUID();
      console.error('[document-processing-hold] transition failed', { incident, message: result.message });
      return Response.json({ ok: false, error: 'hold_transition_failed', incident }, { status: 502 });
    }
  }
}
