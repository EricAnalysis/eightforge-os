-- ============================================================================
-- MIGRATION: Fix decision status 'dismissed' constraints
-- Date: 2026-06-30
--
-- Purpose:
--   1. decisions table: Remove legacy decisions_status_allowed_check (suppressed-only)
--      that coexists with decisions_status_check and together blocks any write of
--      status='dismissed' (intersection of both constraints = {open,in_review,resolved}).
--      Canonicalize decisions_status_check to exactly ('open','in_review','resolved','dismissed').
--
--   2. decision_feedback table: Add 'dismissed' to
--      decision_feedback_decision_status_at_feedback_check so audit rows written by
--      logDecisionFeedback (decision_status_at_feedback = new_status) succeed when
--      new_status = 'dismissed'. Retain 'suppressed' as a historical audit value.
--
-- Live production state verified via direct query (2026-06-30):
--   decisions_status_check:                              ('open','in_review','resolved','dismissed') CORRECT — no-op recreate
--   decisions_status_allowed_check:                      ('open','in_review','resolved','suppressed') LEGACY BLOCKER — drop
--   decision_feedback_decision_status_at_feedback_check: (NULL,'open','in_review','resolved','suppressed') — add 'dismissed'
--
-- Data safety:
--   decisions:         25 open, 1 in_review, 4 resolved — zero 'suppressed', zero 'dismissed'
--   decision_feedback: 2 rows, both decision_status_at_feedback = NULL
--   No backfill needed.
--
-- Downstream callers fixed:
--   lib/server/decisionClosure.ts  finalizeDecision → decisions.update(status)
--   lib/server/decisionFeedback.ts logDecisionFeedback → decision_feedback.insert(decision_status_at_feedback)
-- ============================================================================

-- ============================================================================
-- SECTION 1: decisions — retire legacy suppressed constraint, canonicalize status check
-- ============================================================================

-- Drop legacy suppressed-only constraint that prevents writing status='dismissed'
ALTER TABLE public.decisions
  DROP CONSTRAINT IF EXISTS decisions_status_allowed_check;

-- Recreate decisions_status_check with canonical allowed set.
-- On production this is a no-op (same definition already exists);
-- on a fresh build it supersedes the 20250310 baseline + 20250314 IF-NOT-EXISTS definition.
ALTER TABLE public.decisions
  DROP CONSTRAINT IF EXISTS decisions_status_check;

ALTER TABLE public.decisions
  ADD CONSTRAINT decisions_status_check
  CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed'));

-- ============================================================================
-- SECTION 2: decision_feedback — add 'dismissed' to audit status check
-- ============================================================================

-- 'suppressed' retained: legitimate historical audit value even though zero rows
-- currently carry it. 'dismissed' added to unblock logDecisionFeedback writes.
ALTER TABLE public.decision_feedback
  DROP CONSTRAINT IF EXISTS decision_feedback_decision_status_at_feedback_check;

ALTER TABLE public.decision_feedback
  ADD CONSTRAINT decision_feedback_decision_status_at_feedback_check
  CHECK (
    decision_status_at_feedback IS NULL
    OR decision_status_at_feedback IN ('open', 'in_review', 'resolved', 'suppressed', 'dismissed')
  );
