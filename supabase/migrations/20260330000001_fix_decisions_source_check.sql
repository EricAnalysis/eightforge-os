-- Fix decisions_source_check constraint — schema drift from IF NOT EXISTS guard.
--
-- The 20250314000000 migration used IF NOT EXISTS to add this constraint, meaning
-- if a narrower constraint already existed on the live DB, it was silently left in
-- place. The live constraint predates 'deterministic' being added to the allowed set,
-- causing every v2 decision insert (source='deterministic') to fail with a check
-- constraint violation.
--
-- Fix: drop the stale constraint unconditionally and recreate it with the full
-- current set of allowed sources.

ALTER TABLE public.decisions
  DROP CONSTRAINT IF EXISTS decisions_source_check;

ALTER TABLE public.decisions
  ADD CONSTRAINT decisions_source_check
  CHECK (source IN ('rule_engine', 'ai_model', 'human_review', 'deterministic', 'ai_enriched', 'manual'));
