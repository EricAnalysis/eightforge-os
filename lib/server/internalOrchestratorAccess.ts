import { createClient } from '@supabase/supabase-js';
import { getSupabaseAdmin } from '@/lib/server/supabaseAdmin';
import { hasProjectAdminRole, normalizeUserRole } from '@/lib/projectAdmin';

export type InternalOrchestratorAccessResult =
  | { ok: true; userId: string; email: string | null; role: string | null }
  | { ok: false; status: number; error: string };

function parseAllowlist(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function isAllowedInternalOrchestratorOperator(params: {
  email: string | null | undefined;
  role: string | null | undefined;
}): boolean {
  const allowedEmails = parseAllowlist(process.env.INTERNAL_ORCHESTRATOR_ALLOWED_EMAILS);
  const allowedRoles = parseAllowlist(process.env.INTERNAL_ORCHESTRATOR_ALLOWED_ROLES);
  const normalizedEmail = params.email?.trim().toLowerCase() ?? null;
  const normalizedRole = normalizeUserRole(params.role);

  if (normalizedEmail && allowedEmails.includes(normalizedEmail)) return true;
  if (normalizedRole && allowedRoles.includes(normalizedRole)) return true;

  return hasProjectAdminRole(normalizedRole);
}

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

  const { data: profile, error: profileError } = await admin
    .from('user_profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError || !profile) {
    return { ok: false, status: 403, error: 'User profile not found' };
  }

  const email = typeof user.email === 'string' ? user.email : null;
  const role = typeof profile.role === 'string' ? profile.role : null;

  if (!isAllowedInternalOrchestratorOperator({ email, role })) {
    return { ok: false, status: 403, error: 'Forbidden' };
  }

  return {
    ok: true,
    userId: user.id,
    email,
    role,
  };
}
