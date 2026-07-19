-- CS-11: preserve prior execution-item generations when validator findings reopen.
--
-- Live preflight on 2026-07-19 confirmed:
--   execution_items_status_check:
--     status IN ('open', 'resolvable', 'resolved')
--   execution_items_status_outcome_pairing_check:
--     open/resolvable require NULL outcome; resolved requires
--     confirmed/resolved/overridden.
--
-- `superseded` is terminal queue history, but its existing outcome is intentionally
-- unconstrained beyond execution_items_outcome_check. This preserves NULL,
-- resolved, and overridden history rather than rewriting it during supersession.

ALTER TABLE public.execution_items
  ADD COLUMN IF NOT EXISTS superseded_by_run_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.execution_items'::regclass
      AND conname = 'execution_items_superseded_by_run_id_fkey'
  ) THEN
    ALTER TABLE public.execution_items
      ADD CONSTRAINT execution_items_superseded_by_run_id_fkey
      FOREIGN KEY (superseded_by_run_id)
      REFERENCES public.project_validation_runs(id)
      ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE public.execution_items
  DROP CONSTRAINT IF EXISTS execution_items_status_check;

ALTER TABLE public.execution_items
  ADD CONSTRAINT execution_items_status_check
  CHECK (status IN ('open', 'resolvable', 'resolved', 'superseded'))
  NOT VALID;

ALTER TABLE public.execution_items
  VALIDATE CONSTRAINT execution_items_status_check;

ALTER TABLE public.execution_items
  DROP CONSTRAINT IF EXISTS execution_items_status_outcome_pairing_check;

ALTER TABLE public.execution_items
  ADD CONSTRAINT execution_items_status_outcome_pairing_check
  CHECK (
    (status IN ('open', 'resolvable') AND outcome IS NULL)
    OR
    (status = 'resolved' AND outcome IN ('confirmed', 'resolved', 'overridden'))
    OR
    status = 'superseded'
  )
  NOT VALID;

ALTER TABLE public.execution_items
  VALIDATE CONSTRAINT execution_items_status_outcome_pairing_check;

CREATE OR REPLACE FUNCTION public.compute_execution_item_queue_state(
  p_status text,
  p_outcome text,
  p_severity text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_status IN ('resolved', 'superseded')                    THEN 'resolved'
    WHEN p_outcome = 'overridden'                                 THEN 'needs_verification'
    WHEN p_status = 'open'                                        THEN 'blocked'
    WHEN p_status = 'resolvable' AND p_severity = 'critical'      THEN 'blocked'
    WHEN p_status = 'resolvable' AND p_severity = 'high'          THEN 'needs_review'
    WHEN p_status = 'resolvable'                                  THEN 'needs_verification'
    ELSE                                                               'needs_review'
  END;
$$;

-- A source key is unique only among current generations. Historical superseded
-- generations intentionally retain the same source key and immutable evidence.
DROP INDEX IF EXISTS public.idx_execution_items_project_source_key;

CREATE UNIQUE INDEX idx_execution_items_project_active_source_key
  ON public.execution_items (project_id, source_type, source_key)
  WHERE status <> 'superseded';

CREATE INDEX IF NOT EXISTS idx_execution_items_superseded_by_run
  ON public.execution_items (superseded_by_run_id)
  WHERE superseded_by_run_id IS NOT NULL;

-- Provenance-safe, idempotent backfill: only attach a run when an existing
-- execution-item activity event already records that exact run id. Historical
-- rows carrying only "Superseded by latest validation run." do not identify the
-- causative run and are deliberately left unchanged rather than guessed.
WITH proven_supersessions AS (
  SELECT
    event.entity_id AS execution_item_id,
    min(event.new_value->>'superseded_by_run_id')::uuid AS run_id
  FROM public.activity_events AS event
  WHERE event.entity_type = 'execution_item'
    AND event.new_value->>'status' = 'superseded'
    AND event.new_value->>'superseded_by_run_id'
        ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  GROUP BY event.entity_id
  HAVING count(DISTINCT event.new_value->>'superseded_by_run_id') = 1
)
UPDATE public.execution_items AS item
SET superseded_by_run_id = proven.run_id
FROM proven_supersessions AS proven
WHERE item.superseded_by_run_id IS NULL
  AND proven.execution_item_id = item.id
  AND EXISTS (
    SELECT 1
    FROM public.project_validation_runs AS run
    WHERE run.id = proven.run_id
      AND run.project_id = item.project_id
  );
