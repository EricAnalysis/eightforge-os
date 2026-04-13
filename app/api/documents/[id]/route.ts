import { NextRequest, NextResponse } from 'next/server';
import {
  isDocumentFactAnchorsTableUnavailableError,
  mapDocumentFactAnchorRow,
  type DocumentFactAnchorRow,
} from '@/lib/documentFactAnchors';
import {
  isDocumentFactReviewsTableUnavailableError,
  mapDocumentFactReviewRow,
  type DocumentFactReviewRow,
} from '@/lib/documentFactReviews';
import {
  isDocumentFactOverridesTableUnavailableError,
  mapDocumentFactOverrideRow,
  type DocumentFactOverrideRow,
} from '@/lib/documentFactOverrides';
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

  const { data: factOverrideRows, error: factOverrideError } = await admin
    .from('document_fact_overrides')
    .select(
      'id, organization_id, document_id, field_key, value_json, raw_value, action_type, reason, created_by, created_at, is_active, supersedes_override_id',
    )
    .eq('organization_id', orgId)
    .eq('document_id', id)
    .order('created_at', { ascending: false });

  let resolvedFactOverrideRows = factOverrideRows ?? [];
  if (factOverrideError) {
    if (isDocumentFactOverridesTableUnavailableError(factOverrideError)) {
      console.warn(
        `[document GET] document_fact_overrides unavailable; continuing with empty factOverrides. documentId=${id} error=${JSON.stringify({
          code: factOverrideError.code,
          message: factOverrideError.message,
          details: factOverrideError.details,
          hint: factOverrideError.hint,
        })}`,
      );
      resolvedFactOverrideRows = [];
    } else {
      return NextResponse.json(
        { error: factOverrideError.message },
        { status: 500 },
      );
    }
  }

  const { data: factAnchorRows, error: factAnchorError } = await admin
    .from('document_fact_anchors')
    .select(
      'id, organization_id, document_id, field_key, override_id, anchor_type, page_number, start_page, end_page, snippet, quote_text, rect_json, anchor_json, created_by, created_at, is_primary',
    )
    .eq('organization_id', orgId)
    .eq('document_id', id)
    .order('created_at', { ascending: false });

  let resolvedFactAnchorRows = factAnchorRows ?? [];
  if (factAnchorError) {
    if (isDocumentFactAnchorsTableUnavailableError(factAnchorError)) {
      console.warn(
        `[document GET] document_fact_anchors unavailable; continuing with empty factAnchors. documentId=${id} error=${JSON.stringify({
          code: factAnchorError.code,
          message: factAnchorError.message,
          details: factAnchorError.details,
          hint: factAnchorError.hint,
        })}`,
      );
      resolvedFactAnchorRows = [];
    } else {
      return NextResponse.json(
        { error: factAnchorError.message },
        { status: 500 },
      );
    }
  }

  const { data: factReviewRows, error: factReviewError } = await admin
    .from('document_fact_reviews')
    .select(
      'id, organization_id, document_id, field_key, review_status, reviewed_value_json, reviewed_by, reviewed_at, notes',
    )
    .eq('organization_id', orgId)
    .eq('document_id', id)
    .order('reviewed_at', { ascending: false });

  let resolvedFactReviewRows = factReviewRows ?? [];
  if (factReviewError) {
    if (isDocumentFactReviewsTableUnavailableError(factReviewError)) {
      console.warn(
        `[document GET] document_fact_reviews unavailable; continuing with empty factReviews. documentId=${id} error=${JSON.stringify({
          code: factReviewError.code,
          message: factReviewError.message,
          details: factReviewError.details,
          hint: factReviewError.hint,
        })}`,
      );
      resolvedFactReviewRows = [];
    } else {
      return NextResponse.json(
        { error: factReviewError.message },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({
    ...data,
    relatedDocs,
    factOverrides: resolvedFactOverrideRows.map((row) =>
      mapDocumentFactOverrideRow(row as DocumentFactOverrideRow),
    ),
    factAnchors: resolvedFactAnchorRows.map((row) =>
      mapDocumentFactAnchorRow(row as DocumentFactAnchorRow),
    ),
    factReviews: resolvedFactReviewRows.map((row) =>
      mapDocumentFactReviewRow(row as DocumentFactReviewRow),
    ),
  });
}
