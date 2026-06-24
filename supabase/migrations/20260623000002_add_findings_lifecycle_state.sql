-- ============================================================
-- Phase B Step 3: Persist lifecycle_state on project_validation_findings
-- ============================================================
-- Codifies the output of lifecycleForIssue() in
-- lib/resolveProjectIssueObjects.ts as a persisted column.
-- Values: open | blocked | needs_verification | ready_for_authorization
--         | escalated | resolved
-- (Post Step-0 rename: ready_for_auth → ready_for_authorization throughout)
--
-- AUTHORITATIVE SOURCE DECISION (overridden reconciliation):
-- Phase A found that executionQueue.ts checks `outcome = 'overridden'`
-- independently, while resolveProjectIssueObjects.ts does not.
-- Decision: resolveProjectIssueObjects.ts is authoritative for this column
-- because it drives the operator-facing UI (ProjectIssueBoard.tsx,
-- ProjectDecisionQueueFrame.tsx).
-- Resolution: The new execution_items_status_outcome_pairing_check constraint
-- (migration 20260623000000) enforces that outcome='overridden' only occurs
-- with status='resolved'. Since status='resolved' already maps to 'resolved'
-- lifecycle_state (first branch in both paths), the executionQueue.ts
-- divergence is structurally eliminated by the constraint — no special
-- outcome='overridden' handling is needed here.
--
-- SQL APPROXIMATION NOTES:
-- - findings.details JSONB does not exist in the DB schema; therefore
--   isEscalated(finding) from the finding side is always false in SQL.
--   Escalation is only detected from decisions.details.escalated.
-- - isBlocker() uses severity='critical' only (the two soft checks —
--   approval_gate_effect and finding_disposition — are computed client-side
--   from normalized findings and are not stored columns).
-- - These approximations affect only escalated and blocked edge cases.
--   The comparison query below surfaces any divergence before readers switch.
--
-- ZERO-DIFF REQUIREMENT:
-- Run this comparison query BEFORE switching any reader to this column.
-- It must return 0 rows for all open projects (Williamson, Goodlettsville):
--
--   SELECT
--     f.id, f.project_id, f.check_key,
--     f.lifecycle_state AS persisted,
--     -- compute live derivation in your test environment
--     -- (see docs/runbooks/phase-b-backfill.sql for full comparison script)
--     d.status AS decision_status,
--     ei.status AS ei_status
--   FROM project_validation_findings f
--   LEFT JOIN decisions d ON d.id = f.linked_decision_id
--   LEFT JOIN execution_items ei ON ei.id = f.linked_action_id
--   WHERE f.project_id IN (
--     SELECT id FROM projects WHERE code IN ('williamson', 'goodlettsville')
--   )
--   AND f.lifecycle_state IS DISTINCT FROM (
--     -- inline the derivation here for comparison
--     CASE
--       WHEN f.status != 'open'                                          THEN 'resolved'
--       WHEN (d.details->>'escalated')::boolean = true
--         OR (d.details->>'escalation_required')::boolean = true         THEN 'escalated'
--       WHEN d.id IS NULL AND f.severity = 'critical'                   THEN 'blocked'
--       WHEN d.id IS NULL                                                THEN 'open'
--       WHEN lower(d.status) IN ('in_review','needs_review','flagged')
--         OR upper(d.details->>'decision_status') = 'PENDING_VERIFICATION'
--         OR upper(d.details->>'operator_status') = 'PENDING_VERIFICATION'
--                                                                        THEN 'needs_verification'
--       WHEN lower(d.status) IN ('open','pending')
--         OR upper(d.details->>'decision_status') = 'PENDING_OPERATOR_DECISION'
--         OR upper(d.details->>'operator_status') = 'PENDING_OPERATOR_DECISION'
--                                                                        THEN 'ready_for_authorization'
--       WHEN lower(d.status) IN ('resolved','dismissed','suppressed')   THEN 'resolved'
--       WHEN ei.id IS NOT NULL                                           THEN 'needs_verification'
--       ELSE                                                                  'ready_for_authorization'
--     END
--   );
-- ============================================================

-- Add the column
ALTER TABLE public.project_validation_findings
  ADD COLUMN IF NOT EXISTS lifecycle_state text;

-- Compute function — pure SQL derivation
CREATE OR REPLACE FUNCTION public.compute_finding_lifecycle_state(
  p_finding_status text,
  p_finding_severity text,
  p_decision_id uuid,
  p_decision_status text DEFAULT NULL,
  p_decision_details jsonb DEFAULT NULL,
  p_execution_item_id uuid DEFAULT NULL
) RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    -- Resolved finding (any status other than 'open')
    WHEN p_finding_status != 'open'                                          THEN 'resolved'
    -- Escalated via decision details
    WHEN (p_decision_details->>'escalated')::boolean = true
      OR (p_decision_details->>'escalation_required')::boolean = true        THEN 'escalated'
    -- No decision: use finding severity for blocked detection
    WHEN p_decision_id IS NULL AND p_finding_severity = 'critical'           THEN 'blocked'
    WHEN p_decision_id IS NULL                                               THEN 'open'
    -- Decision present — check status
    WHEN lower(p_decision_status) IN ('in_review','needs_review','flagged')
      OR upper(coalesce(
           p_decision_details->>'decision_status',
           p_decision_details->>'operator_status', ''))
         IN ('PENDING_VERIFICATION')                                         THEN 'needs_verification'
    WHEN lower(p_decision_status) IN ('open','pending')
      OR upper(coalesce(
           p_decision_details->>'decision_status',
           p_decision_details->>'operator_status', ''))
         IN ('PENDING_OPERATOR_DECISION')                                    THEN 'ready_for_authorization'
    WHEN lower(p_decision_status) IN ('resolved','dismissed','suppressed')   THEN 'resolved'
    -- Fallback: execution item present → EXECUTING → needs_verification
    WHEN p_execution_item_id IS NOT NULL                                     THEN 'needs_verification'
    ELSE                                                                          'ready_for_authorization'
  END;
$$;

-- Backfill via JOIN to decisions and execution_items
UPDATE public.project_validation_findings f
SET lifecycle_state = public.compute_finding_lifecycle_state(
  f.status,
  f.severity,
  f.linked_decision_id,
  d.status,
  d.details,
  f.linked_action_id
)
FROM (
  SELECT id, status, details
  FROM public.decisions
) d
WHERE d.id = f.linked_decision_id
  AND f.lifecycle_state IS NULL;

-- Backfill rows with no linked decision
UPDATE public.project_validation_findings f
SET lifecycle_state = public.compute_finding_lifecycle_state(
  f.status,
  f.severity,
  NULL,
  NULL,
  NULL,
  f.linked_action_id
)
WHERE f.linked_decision_id IS NULL
  AND f.lifecycle_state IS NULL;

-- Trigger: keep lifecycle_state current on finding status/decision link changes
CREATE OR REPLACE FUNCTION public.trg_findings_lifecycle_state()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_decision_status text;
  v_decision_details jsonb;
BEGIN
  IF NEW.linked_decision_id IS NOT NULL THEN
    SELECT status, details
    INTO v_decision_status, v_decision_details
    FROM public.decisions
    WHERE id = NEW.linked_decision_id;
  END IF;

  NEW.lifecycle_state := public.compute_finding_lifecycle_state(
    NEW.status,
    NEW.severity,
    NEW.linked_decision_id,
    v_decision_status,
    v_decision_details,
    NEW.linked_action_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_findings_lifecycle_state ON public.project_validation_findings;
CREATE TRIGGER tr_findings_lifecycle_state
  BEFORE INSERT OR UPDATE OF status, severity, linked_decision_id, linked_action_id
  ON public.project_validation_findings
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_findings_lifecycle_state();
