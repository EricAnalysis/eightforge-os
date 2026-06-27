-- Allow approvalActionEngine to persist its distinct audit source.

ALTER TABLE public.workflow_tasks
  DROP CONSTRAINT IF EXISTS workflow_tasks_source_check;

ALTER TABLE public.workflow_tasks
  ADD CONSTRAINT workflow_tasks_source_check
  CHECK (source IN ('decision_engine', 'manual', 'system', 'approval_engine'));
