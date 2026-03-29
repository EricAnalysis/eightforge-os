-- ============================================================================
-- MIGRATION: Document fact anchors
-- Date: 2026-03-28
-- Purpose: Persist human-selected PDF anchors for document facts and overrides
--          without modifying machine extraction evidence.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_fact_anchors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  override_id uuid REFERENCES public.document_fact_overrides(id) ON DELETE SET NULL,
  anchor_type text NOT NULL,
  page_number integer NOT NULL,
  snippet text,
  quote_text text,
  rect_json jsonb,
  anchor_json jsonb,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_primary boolean NOT NULL DEFAULT true
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_name = 'document_fact_anchors_anchor_type_check'
  ) THEN
    ALTER TABLE public.document_fact_anchors
      ADD CONSTRAINT document_fact_anchors_anchor_type_check
      CHECK (anchor_type IN ('text', 'region'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_name = 'document_fact_anchors_page_number_check'
  ) THEN
    ALTER TABLE public.document_fact_anchors
      ADD CONSTRAINT document_fact_anchors_page_number_check
      CHECK (page_number >= 1);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_fact_anchors_organization_id
  ON public.document_fact_anchors (organization_id);

CREATE INDEX IF NOT EXISTS idx_document_fact_anchors_document_field_created_at
  ON public.document_fact_anchors (document_id, field_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_document_fact_anchors_override_id
  ON public.document_fact_anchors (override_id)
  WHERE override_id IS NOT NULL;

ALTER TABLE public.document_fact_anchors ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_anchors_select_authenticated'
  ) THEN
    CREATE POLICY document_fact_anchors_select_authenticated
      ON public.document_fact_anchors
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_anchors.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_anchors_insert_authenticated'
  ) THEN
    CREATE POLICY document_fact_anchors_insert_authenticated
      ON public.document_fact_anchors
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_anchors.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_anchors_update_authenticated'
  ) THEN
    CREATE POLICY document_fact_anchors_update_authenticated
      ON public.document_fact_anchors
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_anchors.organization_id
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_anchors.organization_id
        )
      );
  END IF;
END $$;
