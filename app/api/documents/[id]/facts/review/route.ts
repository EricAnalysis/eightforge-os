import { NextRequest, NextResponse } from 'next/server';
import {
  isDocumentFactReviewStatus,
  isDocumentFactReviewsTableUnavailableError,
  mapDocumentFactReviewRow,
  type DocumentFactReviewRow,
} from '@/lib/documentFactReviews';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { getActorContext } from '@/lib/server/getActorContext';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';
import type { ValidationTriggerSource } from '@/types/validator';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function documentLabel(document: { title?: string | null; name?: string | null }): string {
  return document.title?.trim() || document.name || 'Document';
}

function validationTriggerSourceForReviewStatus(
  reviewStatus: DocumentFactReviewRow['review_status'],
): ValidationTriggerSource {
  switch (reviewStatus) {
    case 'confirmed':
    case 'missing_confirmed':
      return 'review_confirmed';
    case 'needs_followup':
      return 'review_flagged';
    case 'corrected':
      return 'review_corrected';
    default:
      return 'fact_override';
  }
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

  const reviewStatus = body.reviewStatus;
  if (!isDocumentFactReviewStatus(reviewStatus)) {
    return jsonError(
      'reviewStatus must be confirmed, corrected, needs_followup, or missing_confirmed',
      400,
    );
  }

  const reviewedValueJson =
    Object.prototype.hasOwnProperty.call(body, 'reviewedValueJson')
      ? body.reviewedValueJson
      : null;
  if (reviewStatus === 'corrected' && reviewedValueJson == null) {
    return jsonError('reviewedValueJson is required when reviewStatus is corrected', 400);
  }

  const notes =
    typeof body.notes === 'string' && body.notes.trim().length > 0
      ? body.notes.trim()
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

  const { data: previousReviews, error: previousReviewsError } = await admin
    .from('document_fact_reviews')
    .select('id, field_key, review_status, reviewed_value_json, notes, reviewed_at')
    .eq('organization_id', organizationId)
    .eq('document_id', documentId)
    .eq('field_key', fieldKey)
    .order('reviewed_at', { ascending: false })
    .limit(1);

  if (previousReviewsError) return jsonError(previousReviewsError.message, 500);
  const previousReview =
    (previousReviews as Array<Pick<DocumentFactReviewRow, 'id' | 'field_key' | 'review_status' | 'reviewed_value_json' | 'notes' | 'reviewed_at'>> | null)?.[0]
    ?? null;

  const { data: inserted, error: insertError } = await admin
    .from('document_fact_reviews')
    .insert({
      organization_id: organizationId,
      document_id: documentId,
      field_key: fieldKey,
      review_status: reviewStatus,
      reviewed_value_json: reviewedValueJson,
      reviewed_by: actorId,
      notes,
    })
    .select(
      'id, organization_id, document_id, field_key, review_status, reviewed_value_json, reviewed_by, reviewed_at, notes',
    )
    .single();

  if (insertError) {
    if (isDocumentFactReviewsTableUnavailableError(insertError)) {
      return jsonError(
        'Fact reviews are not available yet (table missing or not exposed in PostgREST schema cache). Apply the document_fact_reviews migration and reload the API schema.',
        503,
      );
    }
    return jsonError(insertError.message, 500);
  }

  const projectId =
    document && typeof document.project_id === 'string'
      ? document.project_id
      : null;
  if (projectId) {
    const activityResult = await logActivityEvent({
      organization_id: organizationId,
      project_id: projectId,
      entity_type: 'document',
      entity_id: documentId,
      event_type: reviewStatus === 'corrected' ? 'review_correction_applied' : 'review_recorded',
      changed_by: actorId,
      old_value: previousReview
        ? {
            review_id: previousReview.id,
            field_key: previousReview.field_key,
            review_status: previousReview.review_status,
            previous_status: previousReview.review_status,
            reviewed_value_json: previousReview.reviewed_value_json,
            notes: previousReview.notes,
            reviewed_at: previousReview.reviewed_at,
            document_id: documentId,
            document_title: documentLabel(document),
          }
        : null,
      new_value: {
        review_id: inserted.id,
        field_key: inserted.field_key,
        review_status: inserted.review_status,
        new_status: inserted.review_status,
        reviewed_value_json: inserted.reviewed_value_json,
        effective_value: inserted.reviewed_value_json,
        notes: inserted.notes,
        document_id: documentId,
        document_title: documentLabel(document),
        evidence: {
          document_id: documentId,
          field_key: inserted.field_key,
          source_label: 'fact_ledger_review',
        },
      },
    });

    if (!activityResult.ok) {
      console.error('[document-fact-review] failed to log activity event', {
        documentId,
        projectId,
        fieldKey,
        reviewStatus,
        error: activityResult.error,
      });
    }
  }

  if (projectId) {
    // Fire-and-forget so validation never blocks fact review saves.
    void triggerProjectValidation(
      projectId,
      validationTriggerSourceForReviewStatus(reviewStatus),
      actorId,
    );
  }

  return NextResponse.json({
    ok: true,
    review: mapDocumentFactReviewRow(inserted as DocumentFactReviewRow),
  });
}
