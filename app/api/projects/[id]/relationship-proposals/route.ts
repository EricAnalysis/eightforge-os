import { NextRequest, NextResponse } from 'next/server';

import { getActorContext } from '@/lib/server/getActorContext';
import { generateRelationshipProposals, listRelationshipProposals } from '@/lib/server/relationshipProposals';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

/**
 * Relationship proposals (P3.2 V1, `amends` only).
 *
 * GET lists the project's proposals with their reviews. POST computes the
 * deterministic candidates for open referenced-amendment findings and records
 * each as an immutable, non-authoritative proposal. Neither creates a
 * relationship: the operator confirms a proposal only through the
 * document-precedence `link_relationship` action, carrying its id.
 */

async function projectInOrganization(admin: NonNullable<ReturnType<typeof getSupabaseAdmin>>, projectId: string,
  organizationId: string): Promise<boolean> {
  const { data, error } = await admin.from('projects').select('id')
    .eq('id', projectId).eq('organization_id', organizationId).maybeSingle();
  return !error && data != null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id: projectId } = await params;
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  if (!await projectInOrganization(admin, projectId, ctx.actor.organizationId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  try {
    const proposals = await listRelationshipProposals(admin, { organizationId: ctx.actor.organizationId, projectId });
    return NextResponse.json({ proposals });
  } catch {
    return NextResponse.json({ error: 'Relationship proposals unavailable' }, { status: 503 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getActorContext(req);
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status });
  const { id: projectId } = await params;
  const admin = getSupabaseAdmin();
  if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  if (!await projectInOrganization(admin, projectId, ctx.actor.organizationId)) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }
  try {
    const result = await generateRelationshipProposals(admin, {
      organizationId: ctx.actor.organizationId, projectId, requestedBy: ctx.actor.actorId,
    });
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: 'Relationship proposals unavailable' }, { status: 503 });
  }
}
