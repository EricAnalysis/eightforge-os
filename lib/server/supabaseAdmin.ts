// lib/server/supabaseAdmin.ts
// Server-only Supabase client with service role for storage and database.
// Use only from server code (API routes, server components). Never expose to client.

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { withDocumentProcessingAdmissionHeader } from '@/lib/server/documentProcessingAdmissionContext';

const supabaseUrl =
  process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

function createAdminClient(): SupabaseClient | null {
  if (!supabaseUrl || !serviceRoleKey) return null;
  // Inside an admitted processing unit the admission header rides on every
  // request; the database fence decides whether protected writes may commit.
  return createClient(supabaseUrl, serviceRoleKey, {
    global: {
      fetch: withDocumentProcessingAdmissionHeader((input, init) => fetch(input, init)),
    },
  });
}

let _admin: SupabaseClient | null | undefined = undefined;

/**
 * Returns the server-side Supabase admin client, or null if required env vars are missing.
 * Callers should return a clean error (e.g. 503 "Server analysis is not configured") when null.
 */
export function getSupabaseAdmin(): SupabaseClient | null {
  if (_admin === undefined) {
    _admin = createAdminClient();
  }
  return _admin;
}
