-- ============================================================================
-- MIGRATION: Minimal document-level review persistence
-- Date: 2026-03-18
-- Purpose: Persist operator review state (approve/in-review/request-correction)
-- across refreshes without introducing a workflow engine.
-- ============================================================================

-- Create a single review row per (document_id, organization_id).
CREATE TABLE IF NOT EXISTS public.document_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'not_reviewed',
  reviewed_by uuid,
  reviewed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Status check for operator workflow states.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'document_reviews_status_check'
  ) THEN
    ALTER TABLE public.document_reviews
      ADD CONSTRAINT document_reviews_status_check
      CHECK (status IN ('not_reviewed', 'in_review', 'approved', 'needs_correction'));
  END IF;
END $$;

-- Upsert conflict target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_reviews_document_org_unique
  ON public.document_reviews (document_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_document_reviews_org
  ON public.document_reviews (organization_id);

-- RLS (best-effort; API uses service role, but keep policies consistent).
ALTER TABLE public.document_reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'document_reviews_select_authenticated'
  ) THEN
    CREATE POLICY document_reviews_select_authenticated
      ON public.document_reviews
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_reviews.organization_id
        )
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'document_reviews_write_authenticated'
  ) THEN
    CREATE POLICY document_reviews_write_authenticated
      ON public.document_reviews
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_reviews.organization_id
        )
      );

    CREATE POLICY document_reviews_update_authenticated
      ON public.document_reviews
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_reviews.organization_id
        )
      );
  END IF;
END $$;

