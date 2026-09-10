import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export const FORGEWING_ENGINEERING_WORKER_ROLE = 'forgewing_engineering_worker' as const;

function jwtRole(token: string): string | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as unknown;
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      && (payload as Record<string, unknown>).role === FORGEWING_ENGINEERING_WORKER_ROLE
      ? FORGEWING_ENGINEERING_WORKER_ROLE : null;
  } catch {
    return null;
  }
}

/**
 * Creates a PostgREST client carrying only the dedicated worker JWT role.
 * A service-role token is rejected locally before any request is possible.
 */
export function createForgewingEngineeringWorkerClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL?.trim();
  const apiKey = (process.env.SUPABASE_PUBLISHABLE_KEY
    ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();
  const accessToken = process.env.FORGEWING_ENGINEERING_WORKER_ACCESS_TOKEN?.trim();
  if (!url || !apiKey || !accessToken || jwtRole(accessToken) !== FORGEWING_ENGINEERING_WORKER_ROLE) return null;
  return createClient(url, apiKey, {
    accessToken: async () => accessToken,
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
