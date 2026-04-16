-- Migration: Fix infinite recursion in user_profiles RLS policy
--
-- The original "user_profiles_select_org" policy used a self-referential subquery:
--   EXISTS (SELECT 1 FROM user_profiles me WHERE me.id = auth.uid() AND me.organization_id = ...)
-- Postgres detects this as infinite recursion (HTTP 500) because evaluating the policy
-- on user_profiles triggers the same policy again, endlessly.
--
-- Fix: introduce a SECURITY DEFINER helper function that reads user_profiles without
-- going through RLS (it runs as the function owner), then reference that function in
-- the policy instead of the recursive subquery.

-- 1. Create a SECURITY DEFINER function that returns the current user's org_id
--    without triggering RLS on user_profiles.
CREATE OR REPLACE FUNCTION public.get_current_user_org_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT organization_id
  FROM public.user_profiles
  WHERE id = auth.uid()
  LIMIT 1;
$$;

-- Restrict execution to authenticated users only
REVOKE ALL ON FUNCTION public.get_current_user_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_current_user_org_id() TO authenticated;

-- 2. Drop the recursive policy and replace with the non-recursive version
DROP POLICY IF EXISTS "user_profiles_select_org" ON public.user_profiles;

CREATE POLICY "user_profiles_select_org"
  ON public.user_profiles
  FOR SELECT
  USING (organization_id = public.get_current_user_org_id());
