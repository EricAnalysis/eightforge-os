// lib/server/getActorContext.ts
// Resolves the authenticated actor and their organization context from a request.
// Use in API routes to eliminate repeated auth + profile lookup boilerplate.

import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';

export type ActorContext = {
  actorId: string;
  organizationId: string;
  displayName: string | null;
  role: string | null;
};

export type ActorContextResult =
  | { ok: true; actor: ActorContext }
  | { ok: false; status: number; error: string };

/**
 * Extracts a Bearer token from the request, validates the user via Supabase Auth,
 * loads the matching user_profiles row, and returns the actor's id, organization,
 * and display name.
 *
 * Returns a discriminated union so callers can forward the error directly:
 *
 *   const result = await getActorContext(req);
 *   if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
 *   const { actorId, organizationId, displayName } = result.actor;
 */
export async function getActorContext(req: Request): Promise<ActorContextResult> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const supabaseUrl =
    process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!supabaseUrl || !anonKey) {
    return { ok: false, status: 503, error: 'Server not configured' };
  }

  const authClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const {
    data: { user },
    error: userError,
  } = await authClient.auth.getUser();

  if (userError || !user) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const admin = getSupabaseAdmin();
  if (!admin) {
    return { ok: false, status: 503, error: 'Server not configured' };
  }

  const { data: profile, error: profileError } = await admin
    .from('user_profiles')
    .select('organization_id, display_name, role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return { ok: false, status: 403, error: 'User profile not found' };
  }

  const organizationId = profile.organization_id as string | null;
  if (!organizationId) {
    return { ok: false, status: 403, error: 'No organization associated with user' };
  }

  return {
    ok: true,
    actor: {
      actorId: user.id,
      organizationId,
      displayName: (profile.display_name as string) ?? null,
      role: typeof profile.role === 'string' ? profile.role : null,
    },
  };
}
