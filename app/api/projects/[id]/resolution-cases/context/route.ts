import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { readInvestigationContext } from '@/lib/server/investigationContextRead';

/**
 * One case's investigation context (Forgewing generalization, phase 3), for
 * the operator: every slice EightForge holds for the case, where each came
 * from, and why any relevant slice is absent. Read-only, and local only: this
 * route never transmits anything and never offers the provider purpose.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: projectId } = await params;
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const caseId = req.nextUrl.searchParams.get('caseId')?.trim();
  if (!caseId) return NextResponse.json({ error: 'caseId is required' }, { status: 400 });

  const result = await readInvestigationContext({
    organizationId: ctx.actor.organizationId, projectId, caseId, purpose: 'operator_review',
  });
  switch (result.status) {
    case 'ok':
      return NextResponse.json(result.context);
    case 'not_found':
      return NextResponse.json({ error: 'Case not found' }, { status: 404 });
    case 'not_configured':
      return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
    default:
      return NextResponse.json({ error: 'Investigation context could not be read', code: result.reason }, { status: 500 });
  }
}
