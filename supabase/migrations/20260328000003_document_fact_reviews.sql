-- ============================================================================
-- MIGRATION: Document fact reviews
-- Date: 2026-03-28
-- Purpose: Persist lightweight operator review state for normalized document
--          facts without modifying extraction or override tables.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_fact_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  review_status text NOT NULL,
  reviewed_value_json jsonb,
  reviewed_by uuid NOT NULL,
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  notes text
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_name = 'document_fact_reviews_review_status_check'
  ) THEN
    ALTER TABLE public.document_fact_reviews
      ADD CONSTRAINT document_fact_reviews_review_status_check
      CHECK (review_status IN ('confirmed', 'corrected', 'needs_followup', 'missing_confirmed'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_fact_reviews_organization_id
  ON public.document_fact_reviews (organization_id);

CREATE INDEX IF NOT EXISTS idx_document_fact_reviews_document_field_reviewed_at
  ON public.document_fact_reviews (document_id, field_key, reviewed_at DESC);

ALTER TABLE public.document_fact_reviews ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_reviews_select_authenticated'
  ) THEN
    CREATE POLICY document_fact_reviews_select_authenticated
      ON public.document_fact_reviews
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_reviews.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_reviews_insert_authenticated'
  ) THEN
    CREATE POLICY document_fact_reviews_insert_authenticated
      ON public.document_fact_reviews
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_reviews.organization_id
        )
      );
  END IF;
END $$;
