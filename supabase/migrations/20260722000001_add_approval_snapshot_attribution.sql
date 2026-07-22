-- Approval snapshots are append-only historical audit evidence. No validator
-- truth is derived from these columns or from project_approval_snapshots.
-- Attribution is nullable because not every validation run has a causal entity.

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
