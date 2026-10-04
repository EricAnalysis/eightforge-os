-- Restore project_approval_snapshots attribution columns.
--
-- These columns were first added in 20260722000001_add_approval_snapshot_attribution,
-- but that migration never reached production. lib/server/approvalSnapshots.ts
-- writes all three columns, so on production every snapshot insert fails.
-- 20260811170000_reconcile_production_schema drops them so that a fresh build
-- matches production. This migration adds them back on both paths.

ALTER TABLE public.project_approval_snapshots
  ADD COLUMN IF NOT EXISTS run_id uuid,
  ADD COLUMN IF NOT EXISTS triggering_decision_id uuid,
  ADD COLUMN IF NOT EXISTS created_by uuid;

CREATE INDEX IF NOT EXISTS idx_project_approval_snapshots_run_id
  ON public.project_approval_snapshots (run_id)
  WHERE run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_project_approval_snapshots_triggering_decision
  ON public.project_approval_snapshots (triggering_decision_id)
  WHERE triggering_decision_id IS NOT NULL;
