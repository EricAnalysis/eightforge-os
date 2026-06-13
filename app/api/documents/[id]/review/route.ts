import { NextRequest, NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

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

  return NextResponse.json({ ok: true, status, reviewed_at: now });
}

