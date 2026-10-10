// app/api/admin/reset-stuck-documents/route.ts
// POST: resets the caller's organization's documents stuck in 'processing' for > 15 minutes.
// Requires a valid user session; scoped to the caller's organization.
//
// `documents` has no updated_at column, so "stuck" is measured from the start of the document's
// latest analysis job (or the document's creation when it has no job). Deleted documents are left
// alone. Job rows are not changed here.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

const STUCK_THRESHOLD_MS = 15 * 60 * 1000;
const STUCK_MESSAGE =
  'Processing timed out — document was stuck in processing state for over 15 minutes. Retry using the Reprocess button.';

type Row = Record<string, unknown>;

export async function POST(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) {
      return NextResponse.json({ error: ctx.error }, { status: ctx.status });
    }

    const admin = getSupabaseAdmin();
    if (!admin) return NextResponse.json({ error: 'Server not configured' }, { status: 503 });
    const organizationId = ctx.actor.organizationId;

    const { data: documents, error: documentsError } = await admin
      .from('documents')
      .select('id, created_at')
      .eq('organization_id', organizationId)
      .eq('processing_status', 'processing')
      .is('deleted_at', null);
    if (documentsError) {
      console.error('[reset-stuck-documents] read error:', documentsError);
      return NextResponse.json({ error: documentsError.message }, { status: 500 });
    }
    const processing = (documents ?? []) as Row[];
    if (processing.length === 0) return NextResponse.json({ ok: true, reset: 0 });

    const ids = processing.map((row) => String(row.id));
    const { data: jobs, error: jobsError } = await admin
      .from('document_analysis_jobs')
      .select('document_id, started_at, created_at')
      .eq('organization_id', organizationId)
      .in('document_id', ids);
    if (jobsError) {
      console.error('[reset-stuck-documents] job read error:', jobsError);
      return NextResponse.json({ error: jobsError.message }, { status: 500 });
    }

    const latestStart = new Map<string, number>();
    for (const job of (jobs ?? []) as Row[]) {
      const raw = job.started_at ?? job.created_at;
      const at = typeof raw === 'string' ? Date.parse(raw) : NaN;
      const id = String(job.document_id);
      if (Number.isFinite(at) && at > (latestStart.get(id) ?? -Infinity)) latestStart.set(id, at);
    }
    const cutoff = Date.now() - STUCK_THRESHOLD_MS;
    const stuck = processing.filter((row) => {
      const id = String(row.id);
      const since = latestStart.get(id)
        ?? (typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN);
      return Number.isFinite(since) && since < cutoff;
    }).map((row) => String(row.id));
    if (stuck.length === 0) return NextResponse.json({ ok: true, reset: 0 });

    const { data, error } = await admin
      .from('documents')
      .update({ processing_status: 'failed', processing_error: STUCK_MESSAGE })
      .eq('organization_id', organizationId)
      .eq('processing_status', 'processing')
      .in('id', stuck)
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
