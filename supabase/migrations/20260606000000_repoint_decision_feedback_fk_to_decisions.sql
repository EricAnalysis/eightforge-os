-- ============================================================================
-- MIGRATION: Repoint decision_feedback.decision_id to public.decisions
-- Date: 2026-06-06
-- Purpose: Correct schema drift where decision_feedback.decision_id references
--          public.document_decisions instead of public.decisions.
-- Safety: FK-only change. No document_decisions changes. No data mutation.
-- Preflight observed on project jpzeckefppmiujwajgvk:
--   decision_feedback rows: 0
--   resolves in document_decisions: 0
--   resolves in decisions: 0
--   would orphan under decisions: 0
--   current FK: decision_feedback_decision_id_fkey -> document_decisions
-- State: C (empty feedback table; safe/cosmetic repoint)
-- ============================================================================

DO $$
DECLARE
  orphan_count bigint;
BEGIN
  SELECT count(*)
  INTO orphan_count
  FROM public.decision_feedback df
  LEFT JOIN public.decisions d ON d.id = df.decision_id
  WHERE df.decision_id IS NOT NULL
    AND d.id IS NULL;

  IF orphan_count > 0 THEN
    RAISE EXCEPTION
      'Cannot repoint decision_feedback.decision_id to public.decisions: % existing feedback rows would orphan',
      orphan_count;
  END IF;
END $$;

ALTER TABLE public.decision_feedback
  DROP CONSTRAINT IF EXISTS decision_feedback_decision_id_fkey;

ALTER TABLE public.decision_feedback
  ADD CONSTRAINT decision_feedback_decision_id_fkey
  FOREIGN KEY (decision_id) REFERENCES public.decisions(id) ON DELETE CASCADE;

-- Rollback:
-- ALTER TABLE public.decision_feedback
--   DROP CONSTRAINT IF EXISTS decision_feedback_decision_id_fkey;
--
-- ALTER TABLE public.decision_feedback
--   ADD CONSTRAINT decision_feedback_decision_id_fkey
--   FOREIGN KEY (decision_id) REFERENCES public.document_decisions(id) ON DELETE CASCADE;
