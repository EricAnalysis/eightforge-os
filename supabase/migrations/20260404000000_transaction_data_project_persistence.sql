-- ============================================================================
-- MIGRATION: Project-scoped transaction data persistence
-- Date: 2026-04-04
-- Purpose: Persist normalized transaction-data datasets and rows so project
--          validators can query them without re-running extraction.
-- Safety: Incremental only. Uses IF NOT EXISTS patterns for repeated runs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.transaction_data_datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  row_count integer NOT NULL DEFAULT 0,
  total_extended_cost double precision NOT NULL DEFAULT 0,
  total_transaction_quantity double precision NOT NULL DEFAULT 0,
  date_range_start date,
  date_range_end date,
  summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.transaction_data_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  invoice_number text,
  transaction_number text,
  rate_code text,
  billing_rate_key text,
  description_match_key text,
  site_material_key text,
  invoice_rate_key text,
  transaction_quantity double precision,
  extended_cost double precision,
  invoice_date date,
  source_sheet_name text NOT NULL,
  source_row_number integer NOT NULL,
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_row_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.transaction_data_rows
  ADD COLUMN IF NOT EXISTS description_match_key text,
  ADD COLUMN IF NOT EXISTS invoice_rate_key text;

CREATE INDEX IF NOT EXISTS idx_transaction_data_datasets_document_id
  ON public.transaction_data_datasets (document_id);

CREATE INDEX IF NOT EXISTS idx_transaction_data_datasets_project_id
  ON public.transaction_data_datasets (project_id);

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_document_id
  ON public.transaction_data_rows (document_id);

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_project_invoice_number
  ON public.transaction_data_rows (project_id, invoice_number)
  WHERE invoice_number IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_project_rate_code
  ON public.transaction_data_rows (project_id, rate_code)
  WHERE rate_code IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_project_billing_rate_key
  ON public.transaction_data_rows (project_id, billing_rate_key)
  WHERE billing_rate_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_project_description_match_key
  ON public.transaction_data_rows (project_id, description_match_key)
  WHERE description_match_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_project_site_material_key
  ON public.transaction_data_rows (project_id, site_material_key)
  WHERE site_material_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_transaction_data_rows_project_invoice_rate_key
  ON public.transaction_data_rows (project_id, invoice_rate_key)
  WHERE invoice_rate_key IS NOT NULL;

ALTER TABLE public.transaction_data_datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transaction_data_rows ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transaction_data_datasets'
      AND policyname = 'transaction_data_datasets_select_authenticated'
  ) THEN
    CREATE POLICY transaction_data_datasets_select_authenticated
      ON public.transaction_data_datasets
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = transaction_data_datasets.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'transaction_data_rows'
      AND policyname = 'transaction_data_rows_select_authenticated'
  ) THEN
    CREATE POLICY transaction_data_rows_select_authenticated
      ON public.transaction_data_rows
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = transaction_data_rows.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;
END $$;
