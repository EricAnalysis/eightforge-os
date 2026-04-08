// lib/supabaseClient.ts
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

// Keep preview builds from crashing when NEXT_PUBLIC vars are missing at build time.
// A real configured environment will still use the actual project values.
const fallbackUrl = 'https://placeholder.supabase.co';
const fallbackAnonKey = 'placeholder-anon-key';

export const supabase = createClient(
  supabaseUrl && supabaseAnonKey ? supabaseUrl : fallbackUrl,
  supabaseUrl && supabaseAnonKey ? supabaseAnonKey : fallbackAnonKey,
);
