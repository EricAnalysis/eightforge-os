-- ============================================================================
-- MIGRATION: Approval action execution log
-- Date: 2026-04-07
-- Purpose: Persist operator graph action execution traces for audit and debug.
--          Each row records one action taken by executeApprovalActions() —
--          the task that was created/updated, the reason, and any error.
-- Safety: Incremental only. Uses IF NOT EXISTS patterns for repeated runs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.approval_action_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       UUID NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id  UUID NOT NULL,
  -- Status that triggered this action
  approval_status  TEXT NOT NULL,
  -- Action type from ApprovalActionType enum
  action_type      TEXT NOT NULL,
  -- Invoice this action applies to (null for project-level actions)
  invoice_number   TEXT,
  -- Amount in cents (null when not applicable)
  amount           BIGINT,
  -- Human-readable reason for this action
  reason           TEXT,
  -- Priority assigned to the resulting task
  priority         TEXT NOT NULL,
  -- The workflow_task row that was created or updated
  task_id          UUID REFERENCES public.workflow_tasks(id) ON DELETE SET NULL,
  -- Outcome: created | updated | failed
  task_outcome     TEXT NOT NULL CHECK (task_outcome IN ('created', 'updated', 'failed')),
  -- Error message when task_outcome = 'failed'
  error            TEXT,
  -- When this action was executed
  executed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup by project (time-ordered for audit view)
CREATE INDEX IF NOT EXISTS idx_approval_action_log_project
  ON public.approval_action_log (project_id, executed_at DESC);

-- Fast lookup by org (portfolio-level execution history)
CREATE INDEX IF NOT EXISTS idx_approval_action_log_org
  ON public.approval_action_log (organization_id, executed_at DESC);

-- Filter to failed actions only (operations dashboard)
CREATE INDEX IF NOT EXISTS idx_approval_action_log_failed
  ON public.approval_action_log (project_id, task_outcome)
  WHERE task_outcome = 'failed';

-- ============================================================================
-- Row-Level Security
-- ============================================================================
ALTER TABLE public.approval_action_log ENABLE ROW LEVEL SECURITY;

-- Org members can read their own action log
CREATE POLICY "approval_action_log_select_own_org"
  ON public.approval_action_log
  FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id
      FROM public.user_profiles
      WHERE user_id = auth.uid()
    )
  );

-- Only the service role (server) may insert — no client writes
-- (INSERT is blocked for authenticated users by default when no policy exists)
