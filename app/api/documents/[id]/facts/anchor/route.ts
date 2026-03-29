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

/** Reject JSON/string noise so Postgres uuid columns never receive the literal "null". */
function parseOptionalUuid(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (t.length === 0) return null;
  const lower = t.toLowerCase();
  if (lower === 'null' || lower === 'undefined') return null;
  return t;
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

  const fieldKey =
    typeof body.fieldKey === 'string' && body.fieldKey.trim().length > 0
      ? body.fieldKey.trim()
      : null;
  if (!fieldKey) return jsonError('fieldKey is required', 400);

  const anchorType = body.anchorType;
  if (anchorType !== 'text' && anchorType !== 'region') {
    return jsonError('anchorType must be text or region', 400);
  }

  const pageNumber =
    typeof body.pageNumber === 'number' &&
    Number.isInteger(body.pageNumber) &&
    body.pageNumber >= 1
      ? body.pageNumber
      : null;
  if (!pageNumber) return jsonError('pageNumber must be a positive integer', 400);

  const overrideId = parseOptionalUuid(
    Object.prototype.hasOwnProperty.call(body, 'overrideId')
      ? (body as { overrideId?: unknown }).overrideId
      : undefined,
  );
  const snippet =
    typeof body.snippet === 'string' && body.snippet.trim().length > 0
      ? body.snippet.trim()
      : null;
  const quoteText =
    typeof body.quoteText === 'string' && body.quoteText.trim().length > 0
      ? body.quoteText.trim()
      : null;
  const rectJson =
    body.rectJson && typeof body.rectJson === 'object'
      ? (body.rectJson as Record<string, unknown>)
      : null;
  const anchorJson =
    body.anchorJson && typeof body.anchorJson === 'object'
      ? (body.anchorJson as Record<string, unknown>)
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

  if (overrideId) {
    const { data: override, error: overrideError } = await admin
      .from('document_fact_overrides')
      .select('id, organization_id, document_id')
      .eq('id', overrideId)
      .maybeSingle();

    if (overrideError) return jsonError(overrideError.message, 500);
    if (
      !override ||
      override.organization_id !== organizationId ||
      override.document_id !== documentId
    ) {
      return jsonError('Override not found', 404);
    }
  }

  const resetPrimary = await admin
    .from('document_fact_anchors')
    .update({ is_primary: false })
    .eq('organization_id', organizationId)
    .eq('document_id', documentId)
    .eq('field_key', fieldKey)
    .match(overrideId ? { override_id: overrideId } : { override_id: null })
    .eq('is_primary', true);

  if (resetPrimary.error) {
    if (isDocumentFactAnchorsTableUnavailableError(resetPrimary.error)) {
      return jsonError(
        'Fact anchors are not available yet (table missing or not exposed in PostgREST schema cache). Apply the document_fact_anchors migration and reload the API schema.',
        503,
      );
    }
    return jsonError(resetPrimary.error.message, 500);
  }

  const { data: inserted, error: insertError } = await admin
    .from('document_fact_anchors')
    .insert({
      organization_id: organizationId,
      document_id: documentId,
      field_key: fieldKey,
      override_id: overrideId,
      anchor_type: anchorType,
      page_number: pageNumber,
      start_page: pageNumber,
      end_page: pageNumber,
      snippet,
      quote_text: quoteText,
      rect_json: rectJson,
      anchor_json: anchorJson,
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
        'Fact anchors are not available yet (table missing or not exposed in PostgREST schema cache). Apply the document_fact_anchors migration and reload the API schema.',
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
