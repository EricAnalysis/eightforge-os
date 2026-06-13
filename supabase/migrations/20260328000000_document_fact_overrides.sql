-- ============================================================================
-- MIGRATION: Document fact overrides
-- Date: 2026-03-28
-- Purpose: Preserve machine-extracted facts while allowing audited human
--          add/correct overrides per document field.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_fact_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  value_json jsonb NOT NULL,
  raw_value text,
  action_type text NOT NULL,
  reason text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  is_active boolean NOT NULL DEFAULT true,
  supersedes_override_id uuid REFERENCES public.document_fact_overrides(id) ON DELETE SET NULL
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.check_constraints
    WHERE constraint_name = 'document_fact_overrides_action_type_check'
  ) THEN
    ALTER TABLE public.document_fact_overrides
      ADD CONSTRAINT document_fact_overrides_action_type_check
      CHECK (action_type IN ('add', 'correct'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_document_fact_overrides_organization_id
  ON public.document_fact_overrides (organization_id);

CREATE INDEX IF NOT EXISTS idx_document_fact_overrides_document_field_created_at
  ON public.document_fact_overrides (document_id, field_key, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_fact_overrides_one_active_per_field
  ON public.document_fact_overrides (organization_id, document_id, field_key)
  WHERE is_active = true;

ALTER TABLE public.document_fact_overrides ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_overrides_select_authenticated'
  ) THEN
    CREATE POLICY document_fact_overrides_select_authenticated
      ON public.document_fact_overrides
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_overrides.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_overrides_insert_authenticated'
  ) THEN
    CREATE POLICY document_fact_overrides_insert_authenticated
      ON public.document_fact_overrides
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_overrides.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_fact_overrides_update_authenticated'
  ) THEN
    CREATE POLICY document_fact_overrides_update_authenticated
      ON public.document_fact_overrides
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_overrides.organization_id
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_fact_overrides.organization_id
        )
      );
  END IF;
END $$;
