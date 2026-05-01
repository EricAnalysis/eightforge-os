import { NextRequest, NextResponse } from 'next/server';
import {
  isDocumentFactOverrideActionType,
  mapDocumentFactOverrideRow,
  type DocumentFactOverrideRow,
} from '@/lib/documentFactOverrides';
import { buildDocumentOverrideActivityInput } from '@/lib/documentFactActivity';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { requestFactOverrideRevalidation } from '@/lib/validator/revalidationRequests';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
  if (!fieldKey) {
    return jsonError('fieldKey is required', 400);
  }

  if (!('valueJson' in body) || body.valueJson === undefined || body.valueJson === null) {
    return jsonError('valueJson is required', 400);
  }

  const actionType = body.actionType;
  if (!isDocumentFactOverrideActionType(actionType)) {
    return jsonError('actionType must be add or correct', 400);
  }

  const rawValue =
    typeof body.rawValue === 'string' && body.rawValue.trim().length > 0
      ? body.rawValue.trim()
      : null;
  const reason =
    typeof body.reason === 'string' && body.reason.trim().length > 0
      ? body.reason.trim()
      : null;

  const { data: document, error: documentError } = await admin
    .from('documents')
    .select('id, organization_id, project_id, title, name')
    .eq('id', documentId)
    .maybeSingle();

  if (documentError) return jsonError(documentError.message, 500);
  if (!document || document.organization_id !== organizationId) {
    return jsonError('Document not found', 404);
  }

  const { data: activeOverrides, error: activeOverridesError } = await admin
    .from('document_fact_overrides')
    .select('id, field_key, value_json, raw_value, action_type, reason')
    .eq('organization_id', organizationId)
    .eq('document_id', documentId)
    .eq('field_key', fieldKey)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (activeOverridesError) return jsonError(activeOverridesError.message, 500);

  const supersedesOverrideId =
    (activeOverrides as Array<Pick<DocumentFactOverrideRow, 'id' | 'field_key' | 'value_json' | 'raw_value' | 'action_type' | 'reason'>> | null)?.[0]?.id ?? null;
  const previousOverride =
    (activeOverrides as Array<Pick<DocumentFactOverrideRow, 'id' | 'field_key' | 'value_json' | 'raw_value' | 'action_type' | 'reason'>> | null)?.[0] ?? null;

  if ((activeOverrides?.length ?? 0) > 0) {
    const { error: deactivateError } = await admin
      .from('document_fact_overrides')
      .update({ is_active: false })
      .eq('organization_id', organizationId)
      .eq('document_id', documentId)
      .eq('field_key', fieldKey)
      .eq('is_active', true);

    if (deactivateError) return jsonError(deactivateError.message, 500);
  }

  const { data: inserted, error: insertError } = await admin
    .from('document_fact_overrides')
    .insert({
      organization_id: organizationId,
      document_id: documentId,
      field_key: fieldKey,
      value_json: body.valueJson,
      raw_value: rawValue,
      action_type: actionType,
      reason,
      created_by: actorId,
      is_active: true,
      supersedes_override_id: supersedesOverrideId,
    })
    .select(
      'id, organization_id, document_id, field_key, value_json, raw_value, action_type, reason, created_by, created_at, is_active, supersedes_override_id',
    )
    .single();

  if (insertError) return jsonError(insertError.message, 500);

  const projectId =
    document && typeof document.project_id === 'string'
      ? document.project_id
      : null;
  if (projectId) {
    const activityResult = await logActivityEvent(
      buildDocumentOverrideActivityInput({
        organizationId,
        actorId,
        projectId,
        document: {
          id: documentId,
          title: document.title,
          name: document.name,
        },
        previousOverride,
        insertedOverride: {
          id: inserted.id,
          field_key: inserted.field_key,
          value_json: inserted.value_json,
          raw_value: inserted.raw_value,
          action_type: inserted.action_type,
          reason: inserted.reason,
          supersedes_override_id: inserted.supersedes_override_id,
        },
      }),
    );

    if (!activityResult.ok) {
      console.error('[document-fact-override] failed to log activity event', {
        documentId,
        projectId,
        fieldKey,
        error: activityResult.error,
      });
    }
  }

  if (projectId) {
    // Fire-and-forget so validation never blocks fact override saves.
    void requestFactOverrideRevalidation({
      projectId,
      actorId,
    });
  }

  return NextResponse.json({
    ok: true,
    override: mapDocumentFactOverrideRow(inserted as DocumentFactOverrideRow),
  });
}
