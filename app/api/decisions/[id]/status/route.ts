// app/api/decisions/[id]/status/route.ts
// PATCH: update decision status (org-scoped). Sets resolved_at when status is resolved.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { logDecisionFeedback } from '@/lib/server/decisionFeedback';

const VALID_STATUSES = ['open', 'in_review', 'resolved', 'suppressed'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: decisionId } = await params;
    if (!decisionId) {
      return jsonError('Decision not found', 404);
    }

    const authHeader = req.headers.get('authorization');
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      return jsonError('Unauthorized', 401);
    }

    const supabaseUrl =
      process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!supabaseUrl || !anonKey) {
      return jsonError('Server not configured', 503);
    }

    const authClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const {
      data: { user },
      error: userError,
    } = await authClient.auth.getUser();
    if (userError || !user) {
      return jsonError('Unauthorized', 401);
    }

    const admin = getSupabaseAdmin();
    if (!admin) {
      return jsonError('Server not configured', 503);
    }

    const { data: profile, error: profileError } = await admin
      .from('user_profiles')
      .select('organization_id')
      .eq('id', user.id)
      .single();

    if (profileError || !profile?.organization_id) {
      return jsonError('Forbidden', 403);
    }

    const organizationId = profile.organization_id as string;

    const body = await req.json().catch(() => ({}));
    const status = typeof body?.status === 'string' ? body.status : null;
    if (!status || !VALID_STATUSES.includes(status as (typeof VALID_STATUSES)[number])) {
      return jsonError('Invalid status', 400);
    }

    const { data: existing, error: fetchError } = await admin
      .from('decisions')
      .select('id, organization_id, status')
      .eq('id', decisionId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !existing) {
      return jsonError('Decision not found', 404);
    }

    const previousStatus = (existing as { status?: string }).status ?? null;

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      status,
      updated_at: now,
    };
    if (status === 'resolved') {
      updates.resolved_at = now;
    } else {
      updates.resolved_at = null;
    }

    const { data: updated, error: updateError } = await admin
      .from('decisions')
      .update(updates)
      .eq('id', decisionId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    const feedbackResult = await logDecisionFeedback(admin, {
      organization_id: organizationId,
      decision_id: decisionId,
      new_status: status,
      previous_status: previousStatus,
      created_by: user.id,
    });
    if (!feedbackResult.ok) {
      // Do not roll back status change; log server-side only
      console.error('[decision_feedback] insert failed:', feedbackResult.error);
    }

    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
