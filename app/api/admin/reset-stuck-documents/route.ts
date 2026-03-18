// app/api/admin/reset-stuck-documents/route.ts
// POST: resets any documents stuck in 'processing' state for > 15 minutes.
// Requires a valid user session — can be called by any org member.
// Uses the mark_stuck_documents_failed() Postgres function via service role.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

export async function POST(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    const admin = getSupabaseAdmin();
    if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });

    const { data, error } = await admin.rpc('mark_stuck_documents_failed');

    if (error) {
      console.error('[reset-stuck-documents] rpc error:', error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const resetCount = (data as number) ?? 0;
    console.log('[reset-stuck-documents] reset', resetCount, 'stuck documents');

    return NextResponse.json({ ok: true, reset: resetCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
