// app/api/documents/[id]/route.ts
// GET: Fetch a single document by id and organization_id using the service-role client.
// Used so the document detail page can load documents when RLS would otherwise hide them
// (e.g. development with a fallback org id the user is not a member of).

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const DOCUMENT_SELECT =
  'id, title, name, document_type, status, created_at, storage_path, project_id, projects(id, name), processing_status, processed_at, domain';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const queryOrgId = request.nextUrl.searchParams.get('orgId');

  if (!id) {
    return NextResponse.json(
      { error: 'Document id is required' },
      { status: 400 },
    );
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json(
      { error: 'Server not configured' },
      { status: 503 },
    );
  }

  const actorResult = await getActorContext(request);
  const orgId = actorResult.ok ? actorResult.actor.organizationId : queryOrgId;

  if (!orgId) {
    return NextResponse.json(
      { error: 'orgId query parameter is required' },
      { status: 400 },
    );
  }

  const { data, error } = await admin
    .from('documents')
    .select(DOCUMENT_SELECT)
    .eq('id', id)
    .eq('organization_id', orgId)
    .maybeSingle();

  if (error) {
    return NextResponse.json(
      { error: error.message },
      { status: 500 },
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: 'Document not found' },
      { status: 404 },
    );
  }

  return NextResponse.json(data);
}
