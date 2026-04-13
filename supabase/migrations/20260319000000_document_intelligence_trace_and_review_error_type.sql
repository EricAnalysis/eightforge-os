-- ============================================================================
-- MIGRATION: Document intelligence trace + review error taxonomy
-- Date: 2026-03-19
-- Purpose: Persist stable document-level execution traces and capture structured
--          human review error reasons for incorrect decisions.
-- ============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS intelligence_trace jsonb;

ALTER TABLE public.decision_feedback
  ADD COLUMN IF NOT EXISTS review_error_type text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'decision_feedback_review_error_type_check'
  ) THEN
    ALTER TABLE public.decision_feedback
      ADD CONSTRAINT decision_feedback_review_error_type_check
      CHECK (
        review_error_type IS NULL OR
        review_error_type IN ('extraction_error', 'rule_error', 'edge_case')
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_decision_feedback_review_error_type
  ON public.decision_feedback (review_error_type)
  WHERE review_error_type IS NOT NULL;
