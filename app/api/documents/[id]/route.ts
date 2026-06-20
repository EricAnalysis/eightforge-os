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
import { isTransactionDataTableUnavailableError } from '@/lib/server/transactionDataPersistence';
import { UPLOAD_DOCUMENT_TYPES } from '@/lib/documentTypes';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { getActorContext } from '@/lib/server/getActorContext';
import { loadPrecedenceAwareRelatedDocs } from '@/lib/server/documentPrecedence';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

const DOCUMENT_SELECT =
  'id, title, name, document_type, document_subtype, status, created_at, storage_path, project_id, projects(id, name), processing_status, processing_error, processed_at, domain, intelligence_trace';
const LEGACY_DOCUMENT_SELECT =
  'id, title, name, document_type, status, created_at, storage_path, project_id, projects(id, name), processing_status, processing_error, processed_at, domain, intelligence_trace';
const MUTATION_DOCUMENT_SELECT =
  'id, title, name, document_type, processing_status, project_id, deleted_at';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isMissingDocumentSubtypeColumnError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  const message = (error?.message ?? '').toLowerCase();
  return (
    (error?.code === '42703' || error?.code === 'PGRST204')
    && message.includes('document_subtype')
  );
}

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

  const baseQuery = admin
    .from('documents')
    .select(DOCUMENT_SELECT)
    .eq('id', id)
    .eq('organization_id', orgId)
    .is('deleted_at', null);
  let { data, error } = await baseQuery.maybeSingle();

  if (error && isMissingDocumentSubtypeColumnError(error)) {
    ({ data, error } = await admin
      .from('documents')
      .select(LEGACY_DOCUMENT_SELECT)
      .eq('id', id)
      .eq('organization_id', orgId)
      .is('deleted_at', null)
      .maybeSingle());
  }

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

  const isSpreadsheetTransactionDataDocument =
    typeof (data as Record<string, unknown>).document_type === 'string' &&
    ((data as Record<string, unknown>).document_type as string).trim().toLowerCase() === 'transaction_data';

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

  let transactionDatasets: Record<string, unknown>[] = [];
  let transactionRows: Record<string, unknown>[] = [];

  if (isSpreadsheetTransactionDataDocument) {
    const [datasetResult, rowResult] = await Promise.all([
      admin
        .from('transaction_data_datasets')
        .select('id, document_id, project_id, row_count, total_extended_cost, total_transaction_quantity, date_range_start, date_range_end, summary_json, created_at')
        .eq('document_id', id)
        .order('created_at', { ascending: false }),
      admin
        .from('transaction_data_rows')
        .select('id, document_id, project_id, invoice_number, transaction_number, rate_code, billing_rate_key, description_match_key, site_material_key, invoice_rate_key, transaction_quantity, extended_cost, invoice_date, source_sheet_name, source_row_number, record_json, raw_row_json, created_at')
        .eq('document_id', id)
        .order('invoice_date', { ascending: true })
        .order('source_sheet_name', { ascending: true })
        .order('source_row_number', { ascending: true }),
    ]);

    if (datasetResult.error || rowResult.error) {
      if (
        isTransactionDataTableUnavailableError(datasetResult.error) ||
        isTransactionDataTableUnavailableError(rowResult.error)
      ) {
        console.warn(
          `[document GET] transaction_data tables unavailable; continuing with empty transaction datasets/rows. documentId=${id} datasetError=${datasetResult.error?.message ?? 'none'} rowError=${rowResult.error?.message ?? 'none'}`,
        );
      } else {
        return NextResponse.json(
          { error: datasetResult.error?.message ?? rowResult.error?.message ?? 'Failed to load transaction data.' },
          { status: 500 },
        );
      }
    } else {
      transactionDatasets = (datasetResult.data ?? []) as Record<string, unknown>[];
      transactionRows = (rowResult.data ?? []) as Record<string, unknown>[];
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
    transactionDatasets,
    transactionRows,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return jsonError('Document id is required', 400);

  const actorResult = await getActorContext(request);
  if (!actorResult.ok) return jsonError(actorResult.error, actorResult.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await request.json().catch(() => ({}));
  const documentType =
    typeof body?.document_type === 'string' ? body.document_type.trim() : '';

  if (!UPLOAD_DOCUMENT_TYPES.includes(documentType as (typeof UPLOAD_DOCUMENT_TYPES)[number])) {
    return jsonError('document_type is not allowed', 400);
  }

  const { data: existing, error: loadError } = await admin
    .from('documents')
    .select(MUTATION_DOCUMENT_SELECT)
    .eq('id', id)
    .eq('organization_id', actorResult.actor.organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadError) return jsonError(loadError.message, 500);
  if (!existing) return jsonError('Document not found', 404);

  const { data: updated, error: updateError } = await admin
    .from('documents')
    .update({
      document_type: documentType,
      processing_status: 'uploaded',
      processing_error: null,
      processed_at: null,
    })
    .eq('id', id)
    .eq('organization_id', actorResult.actor.organizationId)
    .is('deleted_at', null)
    .select(MUTATION_DOCUMENT_SELECT)
    .single();

  if (updateError) return jsonError(updateError.message, 500);

  const activityResult = await logActivityEvent({
    organization_id: actorResult.actor.organizationId,
    project_id: (updated as { project_id?: string | null }).project_id ?? null,
    entity_type: 'document',
    entity_id: id,
    event_type: 'updated',
    changed_by: actorResult.actor.actorId,
    old_value: {
      document_type: (existing as { document_type?: string | null }).document_type ?? null,
      processing_status: (existing as { processing_status?: string | null }).processing_status ?? null,
      document_title:
        (existing as { title?: string | null }).title ??
        (existing as { name?: string | null }).name ??
        null,
    },
    new_value: {
      document_type: documentType,
      processing_status: 'uploaded',
      requires_reprocess: true,
      document_title:
        (updated as { title?: string | null }).title ??
        (updated as { name?: string | null }).name ??
        null,
    },
  });
  if (!activityResult.ok) {
    console.error('[documents] type update audit log failed:', activityResult.error);
  }

  return NextResponse.json({
    ok: true,
    document: updated,
    requiresReprocess: true,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id) return jsonError('Document id is required', 400);

  const actorResult = await getActorContext(request);
  if (!actorResult.ok) return jsonError(actorResult.error, actorResult.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const { data: existing, error: loadError } = await admin
    .from('documents')
    .select(MUTATION_DOCUMENT_SELECT)
    .eq('id', id)
    .eq('organization_id', actorResult.actor.organizationId)
    .is('deleted_at', null)
    .maybeSingle();

  if (loadError) return jsonError(loadError.message, 500);
  if (!existing) return jsonError('Document not found', 404);

  const deletedAt = new Date().toISOString();
  const { data: updated, error: updateError } = await admin
    .from('documents')
    .update({ deleted_at: deletedAt })
    .eq('id', id)
    .eq('organization_id', actorResult.actor.organizationId)
    .is('deleted_at', null)
    .select(MUTATION_DOCUMENT_SELECT)
    .single();

  if (updateError) return jsonError(updateError.message, 500);

  // Scoped soft-delete only: the storage object is intentionally preserved.
  const activityResult = await logActivityEvent({
    organization_id: actorResult.actor.organizationId,
    project_id: (existing as { project_id?: string | null }).project_id ?? null,
    entity_type: 'document',
    entity_id: id,
    event_type: 'updated',
    changed_by: actorResult.actor.actorId,
    old_value: {
      deleted_at: null,
      document_type: (existing as { document_type?: string | null }).document_type ?? null,
      document_title:
        (existing as { title?: string | null }).title ??
        (existing as { name?: string | null }).name ??
        null,
    },
    new_value: {
      deleted_at: deletedAt,
      soft_deleted: true,
      document_title:
        (existing as { title?: string | null }).title ??
        (existing as { name?: string | null }).name ??
        null,
    },
  });
  if (!activityResult.ok) {
    console.error('[documents] soft-delete audit log failed:', activityResult.error);
  }

  return NextResponse.json({
    ok: true,
    deletedDocumentId: id,
    document: updated,
  });
}
