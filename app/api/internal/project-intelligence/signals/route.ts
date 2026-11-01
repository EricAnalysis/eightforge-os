// Product improvement signals for one project (project intelligence, internal
// side output). Read-only, no provider, and separate from anything an operator
// receives: gated by the existing platform-review allowlist, and scoped to the
// reviewer's own organization. A signal holds codes and record references only.

import { getActorContext } from '@/lib/server/getActorContext';
import { planProjectContext } from '@/lib/projectIntelligence/contextPlan';
import { assessProjectEvidence } from '@/lib/projectIntelligence/evidenceAssessment';
import { deriveProductImprovementSignals } from '@/lib/projectIntelligence/improvementSignal';
import { readProjectIntelligenceSources } from '@/lib/server/projectIntelligenceRead';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolveWorkflowPlatformReviewAccess } from '@/lib/server/workflowPlatformReviewAccess';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const actor = await getActorContext(request);
  if (!actor.ok) return Response.json({ ok: false, error: 'unauthorized' }, { status: actor.status });
  const access = resolveWorkflowPlatformReviewAccess(actor.actor);
  if (!access.allowed) {
    return Response.json({ ok: false, error: 'reviewer_not_eligible', reason: access.reason }, { status: 403 });
  }
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (!projectId) return Response.json({ ok: false, error: 'project_id_required' }, { status: 400 });
  const admin = getSupabaseAdmin();
  if (!admin) return Response.json({ ok: false, error: 'not_configured' }, { status: 503 });
  const { data, error } = await admin.from('projects')
    .select('id, name, validation_status, validation_summary_json')
    .eq('organization_id', actor.actor.organizationId).eq('id', projectId).maybeSingle();
  if (error || !data) return Response.json({ ok: false, error: 'project_not_found' }, { status: 404 });

  try {
    const plan = planProjectContext('need_document');
    const read = await readProjectIntelligenceSources({
      admin, organizationId: actor.actor.organizationId, project: data, question: '', plan,
    });
    if (read.status !== 'ok') return Response.json({ ok: false, error: 'project_not_found' }, { status: 404 });
    const assessment = assessProjectEvidence({ intent: plan.intent, focusFindingId: null, sources: read.sources });
    return Response.json({ ok: true, signals: deriveProductImprovementSignals(assessment) });
  } catch (err) {
    console.error('[projectIntelligenceSignals] read failed', { errorClass: err instanceof Error ? err.name : typeof err });
    return Response.json({ ok: false, error: 'signals_unavailable' }, { status: 500 });
  }
}
