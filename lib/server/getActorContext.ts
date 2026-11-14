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
  /**
   * The authenticated account's email, straight from Supabase Auth. Recorded
   * for provenance; it is never taken from a request body and grants nothing.
   */
  email: string | null;
  /**
   * Whether this account is the platform owner, resolved server-side from the
   * append-only platform-owner grant ledger (public.is_platform_owner) for the
   * verified user id. False when there is no grant or the lookup fails.
   * The only authority for platform-wide tools (workflowPlatformReviewAccess).
   * Optional in the type so tenant-scoped fixtures need not mention it; absent
   * means not the platform owner (the resolver accepts only `true`).
   */
  platformOwner?: boolean;
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

  // The platform-owner lookup runs beside the profile read (no added latency)
  // and can never fail authentication: on any error the actor is simply not
  // the platform owner.
  const [{ data: profile, error: profileError }, platformOwner] = await Promise.all([
    admin
      .from('user_profiles')
      .select('organization_id, display_name, role')
      .eq('id', user.id)
      .single(),
    resolvePlatformOwner(admin, user.id),
  ]);

  if (profileError || !profile) {
    // Diagnostic: distinguish missing row (PGRST116) from admin client misconfiguration (auth error).
    // Check server logs for errorCode to determine root cause:
    //   PGRST116 → no user_profiles row for this user (data problem)
    //   401/JWT error → SUPABASE_SERVICE_ROLE_KEY is wrong or is the anon key (config problem)
    console.error('[getActorContext] user_profiles lookup failed', {
      userId: user.id,
      errorCode: profileError?.code ?? null,
      errorMessage: profileError?.message ?? null,
      profileNull: !profile,
    });
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
      email: typeof user.email === 'string' ? user.email : null,
      platformOwner,
    },
  };
}

type PlatformOwnerRpcClient = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
};

/**
 * True only when public.is_platform_owner returns exactly `true` for the
 * verified user id. Every other outcome (no grant, RPC missing before the
 * migration is applied, network error, malformed reply) is `false`.
 */
export async function resolvePlatformOwner(admin: PlatformOwnerRpcClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc('is_platform_owner', { p_user_id: userId });
    if (error) {
      console.warn('[getActorContext] platform owner lookup failed', { code: error.code ?? null });
      return false;
    }
    return data === true;
  } catch {
    return false;
  }
}
