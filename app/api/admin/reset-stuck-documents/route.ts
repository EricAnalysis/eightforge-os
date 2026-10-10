// app/api/admin/reset-stuck-documents/route.ts
// POST: resets the caller's organization's documents stuck in 'processing' for > 15 minutes.
// Requires a valid user session; scoped to the caller's organization. (The service-role
// mark_stuck_documents_failed() function has no organization parameter, so calling it here let any
// member reset every organization's documents.)

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const STUCK_THRESHOLD_MS = 15 * 60 * 1000;
// Same message mark_stuck_documents_failed() writes.
const STUCK_MESSAGE =
  'Processing timed out — document was stuck in processing state for over 15 minutes. Retry using the Reprocess button.';

export async function POST(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    const admin = getSupabaseAdmin();
    if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });

    const now = Date.now();
    const { data, error } = await admin
      .from('documents')
      .update({
        processing_status: 'failed',
        processing_error: STUCK_MESSAGE,
        updated_at: new Date(now).toISOString(),
      })
      .eq('organization_id', ctx.actor.organizationId)
      .eq('processing_status', 'processing')
      .lt('updated_at', new Date(now - STUCK_THRESHOLD_MS).toISOString())
      .select('id');

    if (error) {
      console.error('[reset-stuck-documents] update error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const resetCount = Array.isArray(data) ? data.length : 0;
    console.log('[reset-stuck-documents] reset', resetCount, 'stuck documents');

    return NextResponse.json({ ok: true, reset: resetCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
