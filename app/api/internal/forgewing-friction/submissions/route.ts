import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { submitImprovementSignal } from '@/lib/server/improvementSignalSubmissions';
import { requireProjectAdminRole } from '@/lib/server/projectAdmin';

/**
 * Submits one of the caller's organization's friction signals for platform
 * triage (B8.3b). Organization owners and admins only.
 *
 * The body names a signal (`{ "signalId": "<kind>:<code>" }`) and nothing else:
 * the server recomputes the report and persists only that signal's allowlisted
 * payload, so no client-supplied content is ever written.
 */
export async function POST(req: NextRequest) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const permission = requireProjectAdminRole(ctx.actor.role);
  if (!permission.ok) return NextResponse.json({ error: permission.error }, { status: permission.status });

  const body = await req.json().catch(() => null) as unknown;
  const keys = body != null && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
  const signalId = keys?.length === 1 ? (body as { signalId?: unknown }).signalId : undefined;
  if (typeof signalId !== 'string' || signalId.length === 0 || signalId.length > 200) {
    return NextResponse.json({ error: 'Body must be exactly { "signalId": string }' }, { status: 400 });
  }

  const result = await submitImprovementSignal({
    organizationId: ctx.actor.organizationId, actorId: ctx.actor.actorId, signalId,
  });
  switch (result.status) {
    case 'submitted':
      return NextResponse.json(result, { status: 201 });
    case 'already_submitted':
      return NextResponse.json(result, { status: 200 });
    case 'signal_not_found':
      return NextResponse.json({ error: 'No current signal with that id', code: result.status }, { status: 404 });
    case 'not_submittable':
      return NextResponse.json({ error: 'This signal is a policy decision, not an engineering item', code: result.status }, { status: 422 });
    case 'not_configured':
      return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
    default:
      return NextResponse.json({ error: 'Signal could not be submitted', code: result.reason }, { status: 500 });
  }
}
