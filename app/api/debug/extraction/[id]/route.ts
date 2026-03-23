// app/api/debug/extraction/[id]/route.ts
// Debug-only endpoint to inspect the latest blob extraction evidence.
// Guarded by env flag to avoid exposing sensitive document contents.

import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import {
  hasUsableExtractionBlobData,
  pickPreferredExtractionBlob,
} from '@/lib/blobExtractionSelection';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (process.env.EIGHTFORGE_EVIDENCE_DEBUG !== '1') {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const { id: documentId } = await params;
  if (!documentId) {
    return NextResponse.json({ error: 'document id required' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
  }

  const actor = await getActorContext(request);
  if (!actor.ok) {
    return NextResponse.json({ error: actor.error }, { status: actor.status });
  }

  // Verify org ownership (defense-in-depth)
  const { data: docRow } = await admin
    .from('documents')
    .select('id, organization_id')
    .eq('id', documentId)
    .maybeSingle();

  const orgId = (docRow as { organization_id?: string } | null)?.organization_id ?? null;
  if (!orgId || orgId !== actor.actor.organizationId) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  const full = request.nextUrl.searchParams.get('full') === '1';

  const { data: extractionRows } = await admin
    .from('document_extractions')
    .select('id, created_at, data')
    .eq('document_id', documentId)
    .is('field_key', null)
    .order('created_at', { ascending: false })
    .limit(10);

  const latestExtractionRow = (extractionRows?.[0] ?? null) as
    | { id?: string; created_at?: string; data?: Record<string, unknown> | null }
    | null;
  const preferredExtractionRow = pickPreferredExtractionBlob(
    (extractionRows ?? []) as Array<{
      id?: string | null;
      created_at?: string | null;
      data?: Record<string, unknown> | null;
    }>,
  );
  const blob = (preferredExtractionRow?.data ?? null) as Record<string, unknown> | null;
  const extraction = (blob?.extraction as Record<string, unknown> | null) ?? null;
  const ev = (extraction?.evidence_v1 as Record<string, unknown> | null) ?? null;
  const pageText = (ev?.page_text as Array<{ page_number: number; text: string; source_method: string }> | null) ?? null;
  const signals = (ev?.section_signals as Record<string, unknown> | null) ?? null;
  const structured = (ev?.structured_fields as Record<string, unknown> | null) ?? null;

  const pageSummaries = (pageText ?? []).map((p) => ({
    page_number: p.page_number,
    source_method: p.source_method,
    length: p.text?.length ?? 0,
    preview: full ? undefined : (p.text ?? '').slice(0, 240),
    text: full ? p.text : undefined,
  }));

  return NextResponse.json({
    document_id: documentId,
    latest_extraction_id: latestExtractionRow?.id ?? null,
    latest_created_at: latestExtractionRow?.created_at ?? null,
    latest_usable: hasUsableExtractionBlobData(latestExtractionRow?.data ?? null),
    preferred_extraction_id: preferredExtractionRow?.id ?? null,
    preferred_created_at: preferredExtractionRow?.created_at ?? null,
    extraction_mode: extraction?.mode ?? null,
    has_evidence_v1: !!ev,
    section_signals: signals,
    structured_fields: structured,
    page_text: pageSummaries,
  });
}

