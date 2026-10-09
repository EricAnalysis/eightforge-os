import { NextRequest, NextResponse } from 'next/server';

import { orchestratorPrefillHref } from '@/lib/resolution/frictionReport';
import { readFrictionReport } from '@/lib/server/frictionReportRead';
import { getActorContext } from '@/lib/server/getActorContext';

/**
 * The caller's organization's Forgewing friction report (Forgewing
 * generalization, phase 5). Read-only. A recurring signal carries a link to
 * the existing Improvement Orchestrator, prefilled with codes, counts and
 * record ids only; a person reviews and submits it there.
 */
export async function GET(req: NextRequest) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const result = await readFrictionReport({ organizationId: ctx.actor.organizationId });
  switch (result.status) {
    case 'ok':
      return NextResponse.json({
        ...result.report,
        signals: result.report.signals.map((signal) => ({
          ...signal,
          orchestratorHref: signal.orchestratorPrefill ? orchestratorPrefillHref(signal.orchestratorPrefill) : null,
        })),
      });
    case 'not_configured':
      return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
    default:
      return NextResponse.json({ error: 'Friction report could not be read', code: result.reason }, { status: 500 });
  }
}
