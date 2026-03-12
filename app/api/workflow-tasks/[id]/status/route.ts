// app/api/workflow-tasks/[id]/status/route.ts
// PATCH: update workflow task status (org-scoped). Optionally sets resolved_at when status is resolved.

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'cancelled'] as const;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: taskId } = await params;
    if (!taskId) {
      return jsonError('Task not found', 404);
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
      .from('workflow_tasks')
      .select('id, organization_id, status')
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .single();

    if (fetchError || !existing) {
      return jsonError('Task not found', 404);
    }

    const now = new Date().toISOString();
    const updates: Record<string, unknown> = {
      status,
      updated_at: now,
    };

    const { data: updated, error: updateError } = await admin
      .from('workflow_tasks')
      .update(updates)
      .eq('id', taskId)
      .eq('organization_id', organizationId)
      .select()
      .single();

    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }

    return NextResponse.json(updated);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
