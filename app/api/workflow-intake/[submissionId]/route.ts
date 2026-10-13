import { NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/** Customer reads always resolve organization from verified actor context. */
export async function handleReadOwnWorkflowAssessment(request: Request, submissionId: string,
  dependencies: { actor?: typeof getActorContext; admin?: ReturnType<typeof getSupabaseAdmin> } = {}) {
  const actor = await (dependencies.actor ?? getActorContext)(request);
  if (!actor.ok) return NextResponse.json({ error: actor.error }, { status: actor.status });
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)) {
    return NextResponse.json({ error: 'Invalid assessment identity' }, { status: 400 });
  }
  const admin = dependencies.admin === undefined ? getSupabaseAdmin() : dependencies.admin;
  if (!admin) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  try {
    const { data, error } = await admin.rpc('read_organization_workflow_assessment', {
      p_submission_id: submissionId, p_organization_id: actor.actor.organizationId,
    });
    if (error) return NextResponse.json({ error: 'Could not read assessment' }, { status: 500 });
    if (!data) return NextResponse.json({ error: 'Assessment not found' }, { status: 404 });
    return NextResponse.json({ workflow: data });
  } catch {
    return NextResponse.json({ error: 'Could not read assessment' }, { status: 500 });
  }
}

export async function GET(request: Request, { params }: { params: Promise<{ submissionId: string }> }) {
  return handleReadOwnWorkflowAssessment(request, (await params).submissionId);
}
