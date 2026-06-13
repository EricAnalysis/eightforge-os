-- Add role column to user_profiles.
-- This column was present in app code (getActorContext, useCurrentOrg) but never
-- captured in a migration. The live DB was missing it, causing every actor resolution
-- to fail with a Postgres 42703 "column does not exist" error, which surfaced as
-- the misleading "User profile not found" 403 on /api/documents/process.
--
-- Safe: ADD COLUMN IF NOT EXISTS, nullable text. Code already handles null role.

alter table public.user_profiles
  add column if not exists role text;
