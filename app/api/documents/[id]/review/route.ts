import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';
import { logActivityEvent } from '@/lib/server/activity/logActivityEvent';
import { triggerProjectValidation } from '@/lib/validator/triggerProjectValidation';

const VALID_STATUSES = ['not_reviewed', 'in_review', 'approved', 'needs_correction'] as const;
type ReviewStatus = (typeof VALID_STATUSES)[number];

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;

  const ctx = await getActorContext(_request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const { data, error } = await admin
    .from('document_reviews')
    .select('status, reviewed_at')
    .eq('document_id', documentId)
    .eq('organization_id', ctx.actor.organizationId)
    .maybeSingle();

  if (error) {
    // If the table doesn't exist yet, fail gracefully as "not reviewed".
    return NextResponse.json({ status: 'not_reviewed' as ReviewStatus, reviewed_at: null });
  }

  return NextResponse.json({
    status: (data?.status ?? 'not_reviewed') as ReviewStatus,
    reviewed_at: (data?.reviewed_at ?? null) as string | null,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id: documentId } = await params;

  const ctx = await getActorContext(request);
  if (!ctx.ok) return jsonError(ctx.error, ctx.status);

  const admin = getSupabaseAdmin();
  if (!admin) return jsonError('Server not configured', 503);

  const body = await request.json().catch(() => null);
  const status: ReviewStatus =
    body?.status && typeof body.status === 'string' && VALID_STATUSES.includes(body.status as ReviewStatus)
      ? (body.status as ReviewStatus)
      : 'not_reviewed';

  const now = new Date().toISOString();
  const { data: document, error: documentError } = await admin
    .from('documents')
    .select('id, organization_id, project_id, title, name, processed_at')
    .eq('id', documentId)
    .maybeSingle();

  if (documentError) return jsonError(documentError.message, 500);
  if (!document || document.organization_id !== ctx.actor.organizationId) {
    return jsonError('Document not found', 404);
  }

  const { data: previousReview, error: previousReviewError } = await admin
    .from('document_reviews')
    .select('status, reviewed_at, reviewed_by')
    .eq('document_id', documentId)
    .eq('organization_id', ctx.actor.organizationId)
    .maybeSingle();

  if (previousReviewError) return jsonError(previousReviewError.message, 500);

  const { error } = await admin.from('document_reviews').upsert(
    {
      document_id: documentId,
      organization_id: ctx.actor.organizationId,
      status,
      reviewed_by: ctx.actor.actorId,
      reviewed_at: now,
      updated_at: now,
    },
    { onConflict: 'document_id,organization_id' },
  );

  if (error) return jsonError(error.message, 500);

  const projectId = typeof document.project_id === 'string' ? document.project_id : null;
  const activityResult = await logActivityEvent({
    organization_id: ctx.actor.organizationId,
    project_id: projectId,
    entity_type: 'document',
    entity_id: documentId,
    event_type: 'review_recorded',
    changed_by: ctx.actor.actorId,
    old_value: previousReview
      ? {
          status: previousReview.status,
          previous_status: previousReview.status,
          reviewed_at: previousReview.reviewed_at,
          reviewed_by: previousReview.reviewed_by,
        }
      : null,
    new_value: {
      status,
      new_status: status,
      reviewed_at: now,
      reviewed_by: ctx.actor.actorId,
      review_scope: 'document_current_extraction',
      extraction_version: document.processed_at ?? null,
      processed_at: document.processed_at ?? null,
      document_title: document.title ?? document.name ?? null,
      validation_refresh_requested: Boolean(projectId),
      source: 'document_review',
    },
  });

  if (!activityResult.ok) {
    console.error('[document-review] failed to log activity event', {
      documentId,
      projectId,
      error: activityResult.error,
    });
  }

  if (projectId) {
    void triggerProjectValidation(projectId, 'manual', ctx.actor.actorId);
  }

  return NextResponse.json({ ok: true, status, reviewed_at: now });
}

