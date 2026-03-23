import { NextRequest, NextResponse } from 'next/server';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

const DOCUMENT_SELECT =
  'id, title, name, document_type, status, created_at, storage_path, project_id, projects(id, name), processing_status, processing_error, processed_at, domain, intelligence_trace';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const queryOrgId = request.nextUrl.searchParams.get('orgId');
  const includeRelated = request.nextUrl.searchParams.get('includeRelated') !== 'false';

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

  const projectId = (data as Record<string, unknown>).project_id as string | null;
  const relatedDocs = includeRelated && projectId
    ? await loadPrecedenceAwareRelatedDocs(admin, {
        organizationId: orgId,
        projectId,
        currentDocumentId: id,
      })
    : [];

  return NextResponse.json({ ...data, relatedDocs });
}
