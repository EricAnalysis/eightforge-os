// app/api/projects/route.ts
// POST: Create a new project scoped to the authenticated user's organization.

import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { getActorContext } from '@/lib/server/getActorContext';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: Request) {
  try {
    const ctx = await getActorContext(req);
    if (!ctx.ok) return jsonError(ctx.error, ctx.status);
    const { organizationId } = ctx.actor;

    const admin = getSupabaseAdmin();
    if (!admin) return jsonError('Server not configured', 503);

    const body = await req.json().catch(() => ({}));
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    const code = typeof body?.code === 'string' ? body.code.trim().toUpperCase() : '';

    if (!name) return jsonError('name is required', 400);
    if (!code) return jsonError('code is required', 400);
    if (code.length > 12) return jsonError('code must be 12 characters or fewer', 400);

    const { data, error } = await admin
      .from('projects')
      .insert({
        organization_id: organizationId,
        name,
        code,
        status: 'active',
      })
      .select('id, name, code, status, created_at')
      .single();

    if (error) {
      // Unique violation on code
      if (error.code === '23505') {
        return jsonError(`A project with code "${code}" already exists`, 409);
      }
      return jsonError(error.message, 500);
    }

    return NextResponse.json({ ok: true, project: data }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 },
    );
  }
}
