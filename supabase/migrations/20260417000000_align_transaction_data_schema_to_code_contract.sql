-- ============================================================================
-- MIGRATION: Align transaction data persistence schema to application contract
-- Date: 2026-04-17
-- Purpose:
--   - Ensure `transaction_data_datasets` exists for current write/read paths
--   - Ensure `transaction_data_rows` has modern JSON/key columns expected by code
--   - Preserve legacy data by backfilling from `transaction_data_summaries`
-- Safety:
--   - Incremental and idempotent (IF NOT EXISTS / guarded DO blocks)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) Canonical summary table expected by app code
-- ---------------------------------------------------------------------------
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

ALTER TABLE public.transaction_data_datasets
  ADD COLUMN IF NOT EXISTS document_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS row_count integer,
  ADD COLUMN IF NOT EXISTS total_extended_cost double precision,
  ADD COLUMN IF NOT EXISTS total_transaction_quantity double precision,
  ADD COLUMN IF NOT EXISTS date_range_start date,
  ADD COLUMN IF NOT EXISTS date_range_end date,
  ADD COLUMN IF NOT EXISTS summary_json jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

ALTER TABLE public.transaction_data_datasets
  ALTER COLUMN row_count SET DEFAULT 0,
  ALTER COLUMN total_extended_cost SET DEFAULT 0,
  ALTER COLUMN total_transaction_quantity SET DEFAULT 0,
  ALTER COLUMN summary_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN created_at SET DEFAULT now();

UPDATE public.transaction_data_datasets
SET
  row_count = COALESCE(row_count, 0),
  total_extended_cost = COALESCE(total_extended_cost, 0),
  total_transaction_quantity = COALESCE(total_transaction_quantity, 0),
  summary_json = COALESCE(summary_json, '{}'::jsonb),
  created_at = COALESCE(created_at, now())
WHERE
  row_count IS NULL
  OR total_extended_cost IS NULL
  OR total_transaction_quantity IS NULL
  OR summary_json IS NULL
  OR created_at IS NULL;

-- ---------------------------------------------------------------------------
-- 2) Backfill legacy summaries into canonical datasets (one row/doc+project)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.transaction_data_summaries') IS NOT NULL THEN
    INSERT INTO public.transaction_data_datasets (
      document_id,
      project_id,
      row_count,
      total_extended_cost,
      total_transaction_quantity,
      date_range_start,
      date_range_end,
      summary_json,
      created_at
    )
    SELECT
      s.document_id,
      s.project_id,
      COALESCE(s.row_count, 0),
      COALESCE(s.total_extended_cost::double precision, 0),
      COALESCE(s.total_transaction_quantity::double precision, 0),
      s.inferred_date_range_start,
      s.inferred_date_range_end,
      jsonb_strip_nulls(
        jsonb_build_object(
          'row_count', COALESCE(s.row_count, 0),
          'total_tickets', COALESCE(s.row_count, 0),
          'distinct_invoice_count',
            CASE
              WHEN jsonb_typeof(s.distinct_invoice_numbers) = 'array'
                THEN jsonb_array_length(s.distinct_invoice_numbers)
              ELSE 0
            END,
          'total_invoiced_amount', COALESCE(s.total_extended_cost::double precision, 0),
          'total_transaction_quantity', COALESCE(s.total_transaction_quantity::double precision, 0),
          'rows_with_missing_rate_code', COALESCE(s.rows_with_missing_rate_code, 0),
          'rows_with_missing_quantity', COALESCE(s.rows_with_missing_quantity, 0),
          'rows_with_missing_extended_cost', COALESCE(s.rows_with_missing_extended_cost, 0),
          'inferred_date_range_start', s.inferred_date_range_start,
          'inferred_date_range_end', s.inferred_date_range_end,
          'legacy_summary_v1', jsonb_build_object(
            'distinct_invoice_numbers', COALESCE(s.distinct_invoice_numbers, '[]'::jsonb),
            'distinct_rate_codes', COALESCE(s.distinct_rate_codes, '[]'::jsonb),
            'distinct_service_items', COALESCE(s.distinct_service_items, '[]'::jsonb),
            'distinct_materials', COALESCE(s.distinct_materials, '[]'::jsonb),
            'detected_header_map', COALESCE(s.detected_header_map, '{}'::jsonb),
            'detected_sheet_names', COALESCE(s.detected_sheet_names, '[]'::jsonb)
          )
        )
      ),
      COALESCE(s.updated_at, s.created_at, now())
    FROM public.transaction_data_summaries s
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.transaction_data_datasets d
      WHERE d.document_id = s.document_id
        AND d.project_id = s.project_id
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Ensure modern transaction row contract columns exist
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.transaction_data_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
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
  source_sheet_name text NOT NULL DEFAULT 'unknown',
  source_row_number integer NOT NULL DEFAULT 0,
  record_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_row_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.transaction_data_rows
  ADD COLUMN IF NOT EXISTS document_id uuid,
  ADD COLUMN IF NOT EXISTS project_id uuid,
  ADD COLUMN IF NOT EXISTS organization_id uuid,
  ADD COLUMN IF NOT EXISTS invoice_number text,
  ADD COLUMN IF NOT EXISTS transaction_number text,
  ADD COLUMN IF NOT EXISTS rate_code text,
  ADD COLUMN IF NOT EXISTS billing_rate_key text,
  ADD COLUMN IF NOT EXISTS description_match_key text,
  ADD COLUMN IF NOT EXISTS site_material_key text,
  ADD COLUMN IF NOT EXISTS invoice_rate_key text,
  ADD COLUMN IF NOT EXISTS transaction_quantity double precision,
  ADD COLUMN IF NOT EXISTS extended_cost double precision,
  ADD COLUMN IF NOT EXISTS invoice_date date,
  ADD COLUMN IF NOT EXISTS source_sheet_name text,
  ADD COLUMN IF NOT EXISTS source_row_number integer,
  ADD COLUMN IF NOT EXISTS record_json jsonb,
  ADD COLUMN IF NOT EXISTS raw_row_json jsonb,
  ADD COLUMN IF NOT EXISTS created_at timestamptz;

ALTER TABLE public.transaction_data_rows
  ALTER COLUMN source_sheet_name SET DEFAULT 'unknown',
  ALTER COLUMN source_row_number SET DEFAULT 0,
  ALTER COLUMN record_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN raw_row_json SET DEFAULT '{}'::jsonb,
  ALTER COLUMN created_at SET DEFAULT now();

UPDATE public.transaction_data_rows
SET
  organization_id = COALESCE(
    transaction_data_rows.organization_id,
    d.organization_id
  ),
  source_sheet_name = COALESCE(source_sheet_name, 'unknown'),
  source_row_number = COALESCE(source_row_number, 0),
  record_json = COALESCE(record_json, '{}'::jsonb),
  raw_row_json = COALESCE(raw_row_json, '{}'::jsonb),
  created_at = COALESCE(created_at, now())
FROM public.documents d
WHERE
  transaction_data_rows.document_id = d.id
  AND (
    transaction_data_rows.organization_id IS NULL
    OR source_sheet_name IS NULL
    OR source_row_number IS NULL
    OR record_json IS NULL
    OR raw_row_json IS NULL
    OR created_at IS NULL
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transaction_data_rows'
      AND column_name = 'organization_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'transaction_data_rows_organization_id_fkey'
  ) THEN
    ALTER TABLE public.transaction_data_rows
      ADD CONSTRAINT transaction_data_rows_organization_id_fkey
      FOREIGN KEY (organization_id)
      REFERENCES public.organizations(id)
      ON DELETE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transaction_data_rows'
      AND column_name = 'organization_id'
  ) AND NOT EXISTS (
    SELECT 1
    FROM public.transaction_data_rows
    WHERE organization_id IS NULL
  ) THEN
    ALTER TABLE public.transaction_data_rows
      ALTER COLUMN organization_id SET NOT NULL;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'transaction_data_rows'
      AND column_name = 'raw_row'
  ) THEN
    UPDATE public.transaction_data_rows
    SET
      raw_row_json = COALESCE(raw_row_json, raw_row, '{}'::jsonb),
      record_json = COALESCE(record_json, raw_row, '{}'::jsonb)
    WHERE
      raw_row_json IS NULL
      OR record_json IS NULL
      OR raw_row_json = '{}'::jsonb
      OR record_json = '{}'::jsonb;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) Indexes for code query patterns
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5) RLS enablement + policy expected by app migration lineage
-- ---------------------------------------------------------------------------
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
