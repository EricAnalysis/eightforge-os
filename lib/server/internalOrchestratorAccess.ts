// lib/server/internalOrchestratorAccess.ts
// Who may use the Improvement Orchestrator (/api/internal/orchestrator): the
// engineering-facing, advisory AI that analyzes internal diagnostics and
// drafts implementation prompts for EightForge itself.
//
// One authority: the PLATFORM OWNER, from the append-only grant ledger
// (public.is_platform_owner, migration 20261105120200), resolved server-side
// for the verified session's user id. The same identity governs every other
// platform-wide tool (workflowPlatformReviewAccess).
//
// What does NOT grant access: organization roles (owner/admin), emails, and
// the retired INTERNAL_ORCHESTRATOR_ALLOWED_* environment allowlists. The
// former "any organization administrator" fallback is gone: the orchestrator
// works at platform level, not inside one tenant.
//
// This grants access only. It does not relax the orchestrator's own
// protections, which stay independent: the route is unavailable in
// production builds, output is advisory text and a prompt file, and provider
// configuration is checked separately.

import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { resolvePlatformOwner } from '@/lib/server/getActorContext';

export type InternalOrchestratorAccessResult =
  | { ok: true; userId: string; email: string | null; role: string | null }
  | { ok: false; status: number; error: string };

export async function getInternalOrchestratorAccess(
  req: Request,
): Promise<InternalOrchestratorAccessResult> {
  const authHeader = req.headers.get('authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
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

  // Role and email are kept for provenance only; they grant nothing here.
  const [{ data: profile, error: profileError }, platformOwner] = await Promise.all([
    admin.from('user_profiles').select('role').eq('id', user.id).single(),
    resolvePlatformOwner(admin, user.id),
  ]);

  if (profileError || !profile) {
    return { ok: false, status: 403, error: 'User profile not found' };
  }

  if (!platformOwner) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  return {
    ok: true,
    userId: user.id,
    email: typeof user.email === 'string' ? user.email : null,
    role: typeof profile.role === 'string' ? profile.role : null,
  };
}
