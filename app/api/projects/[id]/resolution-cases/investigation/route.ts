import { NextRequest, NextResponse } from 'next/server';

import { createClaudeCaseInvestigationProvider } from '@/lib/forgewing/runtime/caseInvestigationClient';
import { isForgewingModelQualified, resolveForgewingModel } from '@/lib/forgewing/runtime/modelConfig';
import { runProviderCaseInvestigation } from '@/lib/server/caseInvestigationRunner';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Operator-invoked Forgewing investigation of one Validator finding (P3b).
 *
 * The runner applies every gate before any provider call: supported case kind
 * (Validator findings), data policy for exactly what would be sent,
 * entitlement, the case_investigation qualification ceiling (disabled until a
 * pre-registered qualification passes) and the durable budget. This route adds
 * only the qualified-model check and server-derived identity.
 *
 * The answer is returned to the operator and never stored: it is a
 * non-authoritative explanation that ranks the case's own navigation and
 * typed actions. It writes nothing, clears nothing and approves nothing; the
 * operator still acts through the case's existing routes.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id: projectId } = await params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'caseId')
    || typeof body.caseId !== 'string' || !body.caseId.trim() || body.caseId.length > 500) {
    return NextResponse.json({ error: 'caseId is required' }, { status: 400 });
  }
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });

  // An unqualified model is no provider: the runner then reports it.
  const model = resolveForgewingModel();
  const provider = process.env.ANTHROPIC_API_KEY?.trim() && isForgewingModelQualified(model.model)
    ? createClaudeCaseInvestigationProvider({ model: model.model }) : null;
  try {
    const result = await runProviderCaseInvestigation({
      organizationId: ctx.actor.organizationId, projectId, caseId: body.caseId, requestedBy: ctx.actor.actorId,
    }, { admin, provider });
    switch (result.status) {
      case 'proposed':
        return NextResponse.json({ status: 'proposed', investigation: result.investigation });
      case 'not_found':
        return NextResponse.json({ error: 'Case not found' }, { status: 404 });
      case 'not_configured':
        return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
      case 'read_failed':
        return NextResponse.json({ error: 'Investigation context could not be read' }, { status: 503 });
      case 'budget_exhausted':
        return NextResponse.json({ status: result.status }, { status: 429 });
      case 'case_kind_not_supported':
        return NextResponse.json({ status: result.status }, { status: 409 });
      default:
        // gated, nothing_to_send, provider_not_configured, reservation_failed,
        // provider_failed, output_invalid: typed reason codes only.
        return NextResponse.json({ status: result.status, ...('reason' in result ? { reason: result.reason } : {}) },
          { status: 503 });
    }
  } catch {
    return NextResponse.json({ error: 'Investigation unavailable' }, { status: 503 });
  }
}
