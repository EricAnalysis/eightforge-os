-- ============================================================================
-- MIGRATION: Execution item override suppression metadata
-- Date: 2026-05-06
-- Purpose: Preserve operator overrides across validator reruns by storing a
--          stable suppression signature plus override timestamps.
-- Safety: Incremental only. Uses IF NOT EXISTS patterns for repeated runs.
-- ============================================================================

ALTER TABLE public.execution_items
  ADD COLUMN IF NOT EXISTS suppression_signature text,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz,
  ADD COLUMN IF NOT EXISTS overridden_at timestamptz;

UPDATE public.execution_items
SET last_seen_at = COALESCE(last_seen_at, updated_at, created_at)
WHERE last_seen_at IS NULL;

UPDATE public.execution_items
SET overridden_at = COALESCE(overridden_at, resolved_at, updated_at)
WHERE outcome = 'overridden'
  AND overridden_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_execution_items_project_signature
  ON public.execution_items (project_id, suppression_signature)
  WHERE suppression_signature IS NOT NULL;
