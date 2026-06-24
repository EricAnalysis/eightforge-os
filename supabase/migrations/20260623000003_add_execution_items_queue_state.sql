-- ============================================================
-- Phase B Step 4: Persist queue_state on execution_items
-- ============================================================
-- Codifies the output of deriveQueueState() in
-- lib/server/executionQueue.ts as a persisted column.
-- Values (from types/executionQueue.ts ActionableItemQueueState):
--   blocked | needs_review | needs_verification | resolved
-- NOTE: 'ready' is excluded — it is not reachable from deriveQueueState().
--
-- This derivation is FULLY SELF-CONTAINED within execution_items columns
-- (status, outcome, severity) — no joins required.
--
-- Derivation trace from deriveQueueState():
--   status='resolved'                              → 'resolved'
--   outcome='overridden' AND status≠'resolved'     → 'needs_verification'
--     (data anomaly post-constraint; new constraint prevents future occurrence)
--   status='open'                                  → 'blocked'
--     (executionItemBlocksApproval = status==='open')
--   status='resolvable' AND severity='critical'    → 'blocked'
--   status='resolvable' AND severity='high'        → 'needs_review'
--   status='resolvable' AND severity IN {med,low}  → 'needs_verification'
--   default                                        → 'needs_review'
--
-- ZERO-DIFF REQUIREMENT:
-- Before switching any reader, run this comparison against live data:
--
--   SELECT id, status, outcome, severity, queue_state AS persisted,
--     CASE
--       WHEN status = 'resolved'                         THEN 'resolved'
--       WHEN outcome = 'overridden'                      THEN 'needs_verification'
--       WHEN status = 'open'                             THEN 'blocked'
--       WHEN status = 'resolvable' AND severity = 'critical' THEN 'blocked'
--       WHEN status = 'resolvable' AND severity = 'high' THEN 'needs_review'
--       WHEN status = 'resolvable'                       THEN 'needs_verification'
--       ELSE 'needs_review'
--     END AS derived
--   FROM execution_items
--   WHERE queue_state IS DISTINCT FROM (
--     CASE
--       WHEN status = 'resolved'                         THEN 'resolved'
--       WHEN outcome = 'overridden'                      THEN 'needs_verification'
--       WHEN status = 'open'                             THEN 'blocked'
--       WHEN status = 'resolvable' AND severity = 'critical' THEN 'blocked'
--       WHEN status = 'resolvable' AND severity = 'high' THEN 'needs_review'
--       WHEN status = 'resolvable'                       THEN 'needs_verification'
--       ELSE 'needs_review'
--     END
--   );
-- Must return 0 rows.
-- ============================================================

-- Add the column
ALTER TABLE public.execution_items
  ADD COLUMN IF NOT EXISTS queue_state text;

-- Compute function
CREATE OR REPLACE FUNCTION public.compute_execution_item_queue_state(
  p_status text,
  p_outcome text,
  p_severity text
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_status = 'resolved'                                 THEN 'resolved'
    WHEN p_outcome = 'overridden'                              THEN 'needs_verification'
    WHEN p_status = 'open'                                     THEN 'blocked'
    WHEN p_status = 'resolvable' AND p_severity = 'critical'  THEN 'blocked'
    WHEN p_status = 'resolvable' AND p_severity = 'high'      THEN 'needs_review'
    WHEN p_status = 'resolvable'                               THEN 'needs_verification'
    ELSE                                                            'needs_review'
  END;
$$;

-- Backfill
UPDATE public.execution_items
SET queue_state = public.compute_execution_item_queue_state(status, outcome, severity)
WHERE queue_state IS NULL;

-- Trigger: keep queue_state current on every relevant column change
CREATE OR REPLACE FUNCTION public.trg_execution_items_queue_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.queue_state := public.compute_execution_item_queue_state(
    NEW.status, NEW.outcome, NEW.severity
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_execution_items_queue_state ON public.execution_items;
CREATE TRIGGER tr_execution_items_queue_state
  BEFORE INSERT OR UPDATE OF status, outcome, severity
  ON public.execution_items
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_execution_items_queue_state();
