-- ============================================================================
-- MIGRATION: Create contract_upload_guidance table
-- Date: 2026-07-01
-- Purpose: Persist the operator's pre-extraction hint about where a contract's
--          rate schedule lives (page ranges, location type, presence) so the
--          extraction pipeline can try those pages first. Guidance only —
--          never a restriction on which pages get extracted.
-- Distinct from document_fact_anchors: document_fact_anchors is a post-hoc
--          structured UI-drawn region anchor tied to a specific extracted
--          fact; contract_upload_guidance is free-text-range guidance
--          captured before extraction ever runs, with no fact linkage.
-- Safety: Additive only. No existing table, column, constraint, or index is
--         touched. CREATE TABLE IF NOT EXISTS and IF NOT EXISTS guards throughout.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.contract_upload_guidance (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,

  rate_schedule_included text NOT NULL CHECK (rate_schedule_included IN ('yes', 'no', 'unsure')),
  rate_schedule_page_ranges jsonb,
  rate_schedule_location_type text CHECK (
    rate_schedule_location_type IN ('main_contract', 'exhibit', 'attachment', 'price_sheet', 'unsure')
  ),
  operator_note text,

  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_upload_guidance_document_id
  ON public.contract_upload_guidance (document_id);

CREATE INDEX IF NOT EXISTS idx_contract_upload_guidance_organization_id
  ON public.contract_upload_guidance (organization_id);

CREATE INDEX IF NOT EXISTS idx_contract_upload_guidance_project_id
  ON public.contract_upload_guidance (project_id)
  WHERE project_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_contract_upload_guidance_updated_at
  ON public.contract_upload_guidance;
CREATE TRIGGER trg_contract_upload_guidance_updated_at
  BEFORE UPDATE ON public.contract_upload_guidance
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.contract_upload_guidance ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'contract_upload_guidance'
      AND policyname = 'contract_upload_guidance_select_authenticated'
  ) THEN
    CREATE POLICY contract_upload_guidance_select_authenticated
      ON public.contract_upload_guidance
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = contract_upload_guidance.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'contract_upload_guidance'
      AND policyname = 'contract_upload_guidance_insert_authenticated'
  ) THEN
    CREATE POLICY contract_upload_guidance_insert_authenticated
      ON public.contract_upload_guidance
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = contract_upload_guidance.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'contract_upload_guidance'
      AND policyname = 'contract_upload_guidance_update_authenticated'
  ) THEN
    CREATE POLICY contract_upload_guidance_update_authenticated
      ON public.contract_upload_guidance
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = contract_upload_guidance.organization_id
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = contract_upload_guidance.organization_id
        )
      );
  END IF;
END $$;
