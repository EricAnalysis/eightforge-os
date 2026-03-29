import { NextRequest, NextResponse } from 'next/server';
import {
  isDocumentFactAnchorsTableUnavailableError,
  mapDocumentFactAnchorRow,
  type DocumentFactAnchorRow,
} from '@/lib/documentFactAnchors';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function rateScheduleSnippet(startPage: number, endPage: number, hasRegion: boolean): string {
  const pageLabel =
    startPage === endPage ? `page ${startPage}` : `pages ${startPage}-${endPage}`;
  return hasRegion
    ? `Rate schedule table region marked for ${pageLabel}.`
    : `Rate schedule marked for ${pageLabel}.`;
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;

  const ctx = await getActorContext(req);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);
  const { actorId, organizationId } = ctx.actor;

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object') {
    return jsonError('Invalid request body', 400);
  }

  const startPage =
    typeof body.startPage === 'number' &&
    Number.isInteger(body.startPage) &&
    body.startPage >= 1
      ? body.startPage
      : null;
  const endPage =
    typeof body.endPage === 'number' &&
    Number.isInteger(body.endPage) &&
    body.endPage >= 1
      ? body.endPage
      : null;

  if (!startPage) return jsonError('startPage must be a positive integer', 400);
  if (!endPage) return jsonError('endPage must be a positive integer', 400);
  if (endPage < startPage) {
    return jsonError('endPage must be greater than or equal to startPage', 400);
  }

  const rectJson =
    body.rectJson && typeof body.rectJson === 'object'
      ? (body.rectJson as Record<string, unknown>)
      : null;

  const { data: document, error: documentError } = await admin
    .from('documents')
    .select('id, organization_id')
    .eq('id', documentId)
    .maybeSingle();

  if (documentError) return jsonError(documentError.message, 500);
  if (!document || document.organization_id !== organizationId) {
    return jsonError('Document not found', 404);
  }

  const anchorType = rectJson ? 'table_region' : 'page_range';
  const fieldKey = 'rate_schedule_pages';

  const resetPrimary = await admin
    .from('document_fact_anchors')
    .update({ is_primary: false })
    .eq('organization_id', organizationId)
    .eq('document_id', documentId)
    .eq('field_key', fieldKey)
    .is('override_id', null)
    .in('anchor_type', ['page_range', 'table_region'])
    .eq('is_primary', true);

  if (resetPrimary.error) {
    if (isDocumentFactAnchorsTableUnavailableError(resetPrimary.error)) {
      return jsonError(
        'Rate schedule anchors require document_fact_anchors (table missing or not exposed in PostgREST schema cache). Apply migrations and reload the API schema.',
        503,
      );
    }
    return jsonError(resetPrimary.error.message, 500);
  }

  const snippet = rateScheduleSnippet(startPage, endPage, Boolean(rectJson));
  const { data: inserted, error: insertError } = await admin
    .from('document_fact_anchors')
    .insert({
      organization_id: organizationId,
      document_id: documentId,
      field_key: fieldKey,
      override_id: null,
      anchor_type: anchorType,
      page_number: startPage,
      start_page: startPage,
      end_page: endPage,
      snippet,
      quote_text: null,
      rect_json: rectJson,
      anchor_json: {
        source: 'rate_schedule_control',
        startPage,
        endPage,
        hasRegion: Boolean(rectJson),
      },
      created_by: actorId,
      is_primary: true,
    })
    .select(
      'id, organization_id, document_id, field_key, override_id, anchor_type, page_number, start_page, end_page, snippet, quote_text, rect_json, anchor_json, created_by, created_at, is_primary',
    )
    .single();

  if (insertError) {
    if (isDocumentFactAnchorsTableUnavailableError(insertError)) {
      return jsonError(
        'Rate schedule anchors require document_fact_anchors (table missing or not exposed in PostgREST schema cache). Apply migrations and reload the API schema.',
        503,
      );
    }
    return jsonError(insertError.message, 500);
  }

  return NextResponse.json({
    ok: true,
    anchor: mapDocumentFactAnchorRow(inserted as DocumentFactAnchorRow),
  });
}
