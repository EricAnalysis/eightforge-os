-- ============================================================================
-- MIGRATION: Resolution lifecycle for approval-generated workflow tasks
-- Date: 2026-04-07
-- Purpose: Extend workflow_tasks with resolution fields so operators can
--          resolve verification tasks or accept exceptions.
--          Phase 12 of the EightForge approval enforcement stack.
--
-- Design:
--   status         — operational state (open → in_review → resolved)
--   resolution_state — HOW it was closed (resolved | accepted_exception)
--   resolved_by    — which user closed it
--   resolved_at    — when it was closed
--   resolution_note — optional operator note explaining the resolution
--
-- Extend only: no existing columns are modified.
-- Safety: all additions use IF NOT EXISTS / DO $$ patterns for re-runnability.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Add in_review to the status CHECK constraint
--    The existing constraint allows:
--      open | in_progress | completed | canceled | blocked | resolved | cancelled
--    We add in_review as a valid intermediate state.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  -- Drop the old constraint if it exists (we will recreate it with the new value)
  IF EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'workflow_tasks_status_check'
      AND table_name = 'workflow_tasks'
      AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.workflow_tasks
      DROP CONSTRAINT workflow_tasks_status_check;
  END IF;

  -- Re-add with in_review included
  ALTER TABLE public.workflow_tasks
    ADD CONSTRAINT workflow_tasks_status_check
    CHECK (status IN (
      'open',
      'in_review',
      'in_progress',
      'completed',
      'canceled',
      'cancelled',
      'blocked',
      'resolved'
    ));
END $$;

-- ---------------------------------------------------------------------------
-- 2. Add resolution columns (extend only — no column drops)
-- ---------------------------------------------------------------------------

ALTER TABLE public.workflow_tasks
  ADD COLUMN IF NOT EXISTS resolution_state TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS resolved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS resolution_note  TEXT;

-- ---------------------------------------------------------------------------
-- 3. Check constraint on resolution_state
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'workflow_tasks_resolution_state_check'
      AND table_name = 'workflow_tasks'
      AND table_schema = 'public'
  ) THEN
    ALTER TABLE public.workflow_tasks
      ADD CONSTRAINT workflow_tasks_resolution_state_check
      CHECK (
        resolution_state IS NULL
        OR resolution_state IN ('resolved', 'accepted_exception')
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Indexes for efficient resolution queries
-- ---------------------------------------------------------------------------

-- Look up all tasks resolved by a specific user
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_resolved_by
  ON public.workflow_tasks (resolved_by)
  WHERE resolved_by IS NOT NULL;

-- Find all accepted-exception tasks per project (exception report)
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_resolution_state
  ON public.workflow_tasks (project_id, resolution_state)
  WHERE resolution_state IS NOT NULL;

-- ============================================================================
-- Comments
-- ============================================================================
COMMENT ON COLUMN public.workflow_tasks.resolution_state IS
  'How the task was closed: resolved (normal) or accepted_exception (operator override). NULL while open.';

COMMENT ON COLUMN public.workflow_tasks.resolved_by IS
  'User who resolved or accepted the exception. NULL while open.';

COMMENT ON COLUMN public.workflow_tasks.resolved_at IS
  'Timestamp when the task was closed. NULL while open.';

COMMENT ON COLUMN public.workflow_tasks.resolution_note IS
  'Optional operator note explaining how or why the task was resolved.';
