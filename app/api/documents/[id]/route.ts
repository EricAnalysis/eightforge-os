// app/api/documents/[id]/route.ts
// GET: Fetch a single document by id (plus related docs in the same project) using
//      the service-role client.  Related docs include the latest of each document type
//      in the same project, along with their typed extraction blob, so the client can
//      compute cross-document intelligence without additional round-trips.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const DOCUMENT_SELECT =
  'id, title, name, document_type, status, created_at, storage_path, project_id, projects(id, name), processing_status, processing_error, processed_at, domain';

// Columns fetched for each related document
const RELATED_DOC_SELECT =
  'id, name, title, document_type, created_at';

// document_type values we care about for cross-doc checks (both families)
const RELATED_DOC_TYPES = [
  // Finance family
  'contract',
  'invoice',
  'payment_rec',
  'spreadsheet',
  // Williamson ops family
  'permit',
  'disposal_checklist',
  'dms_checklist',
  'kickoff',
  'kickoff_checklist',
  'ticket',
  'debris_ticket',
  'daily_ops',
  'ops_report',
  'williamson_contract',
];

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

  // ── Fetch primary document ─────────────────────────────────────────────────
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

  // ── Fetch related docs (same project, different id) ────────────────────────
  let relatedDocs: Array<{
    id: string;
    name: string;
    title: string | null;
    document_type: string | null;
    extraction: Record<string, unknown> | null;
  }> = [];

  const projectId = (data as Record<string, unknown>).project_id as string | null;

  if (includeRelated && projectId) {
    // Get all documents in the same project (excluding self)
    const { data: siblings, error: siblingsError } = await admin
      .from('documents')
      .select(RELATED_DOC_SELECT)
      .eq('organization_id', orgId)
      .eq('project_id', projectId)
      .neq('id', id)
      .in('document_type', RELATED_DOC_TYPES)
      .order('created_at', { ascending: false });

    if (!siblingsError && siblings && siblings.length > 0) {
      // De-duplicate: keep newest per document_type to limit payload size
      const seenTypes = new Set<string>();
      const deduplicated = siblings.filter(s => {
        const dt = s.document_type ?? '__unknown';
        if (seenTypes.has(dt)) return false;
        seenTypes.add(dt);
        return true;
      });

      // Fetch the blob extraction for each related doc from document_extractions
      const relatedIds = deduplicated.map(s => s.id);
      const { data: extractions } = await admin
        .from('document_extractions')
        .select('document_id, data, created_at')
        .in('document_id', relatedIds)
        .is('field_key', null)  // blob rows only
        .order('created_at', { ascending: false });

      // Build id → extraction map (first / newest per doc_id)
      const extractionMap = new Map<string, Record<string, unknown>>();
      for (const ex of (extractions ?? [])) {
        if (!extractionMap.has(ex.document_id)) {
          extractionMap.set(
            ex.document_id,
            ((ex as { data?: Record<string, unknown> | null }).data ?? {}) as Record<string, unknown>,
          );
        }
      }

      relatedDocs = deduplicated.map(s => ({
        id: s.id,
        name: s.name,
        title: s.title ?? null,
        document_type: s.document_type,
        extraction: extractionMap.get(s.id) ?? null,
      }));
    }
  }

  return NextResponse.json({ ...data, relatedDocs });
}
