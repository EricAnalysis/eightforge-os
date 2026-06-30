-- ============================================================================
-- MIGRATION: Create invoice_line_rate_links table
-- Date: 2026-06-30
-- Purpose: Persist operator-chosen manual links between invoice lines and
--          contract rate rows, for cases where the automated matcher fails.
--          Provides the persistence anchor for Pass 1 one-time closure of
--          CROSS_DOCUMENT_CONTRACT_RATE_EXISTS findings.
-- Safety: Additive only. No existing table, column, constraint, or index is
--         touched. CREATE TABLE IF NOT EXISTS and IF NOT EXISTS guards throughout.
-- Pass 2 note: This table is the lookup target for Pass 2's validation-time
--              injection into matchRateScheduleItemForInvoiceLine. Pass 1 only
--              closes the finding once; re-validation will reopen it until
--              Pass 2 ships.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.invoice_line_rate_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,

  -- Stability anchors for the invoice line
  invoice_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  invoice_line_subject_id text NOT NULL,
  invoice_line_number text,
  invoice_line_description text,
  invoice_line_billing_code text,

  -- Stability anchors for the matched contract rate row
  contract_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  contract_rate_row_id text NOT NULL,
  rate_row_description text,
  rate_row_unit_type text,
  rate_row_rate_amount numeric,

  -- Provenance
  actor_id uuid NOT NULL REFERENCES auth.users(id),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Supersession chain
  is_active boolean NOT NULL DEFAULT true,
  superseded_by uuid REFERENCES public.invoice_line_rate_links(id) ON DELETE SET NULL
);

-- One active link per invoice line (enforced as a unique partial index).
-- Supersession: deactivate old link before inserting new one; the unique
-- constraint is vacated the moment is_active flips to false.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_line_rate_links_one_active_per_line
  ON public.invoice_line_rate_links (organization_id, project_id, invoice_document_id, invoice_line_subject_id)
  WHERE is_active = true;

-- Fast lookup for all active links on an invoice document.
CREATE INDEX IF NOT EXISTS idx_invoice_line_rate_links_active_by_invoice_document
  ON public.invoice_line_rate_links (organization_id, project_id, invoice_document_id)
  WHERE is_active = true;

ALTER TABLE public.invoice_line_rate_links ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'invoice_line_rate_links'
      AND policyname = 'invoice_line_rate_links_select_authenticated'
  ) THEN
    CREATE POLICY invoice_line_rate_links_select_authenticated
      ON public.invoice_line_rate_links
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = invoice_line_rate_links.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'invoice_line_rate_links'
      AND policyname = 'invoice_line_rate_links_insert_authenticated'
  ) THEN
    CREATE POLICY invoice_line_rate_links_insert_authenticated
      ON public.invoice_line_rate_links
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = invoice_line_rate_links.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'invoice_line_rate_links'
      AND policyname = 'invoice_line_rate_links_update_authenticated'
  ) THEN
    CREATE POLICY invoice_line_rate_links_update_authenticated
      ON public.invoice_line_rate_links
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = invoice_line_rate_links.organization_id
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = invoice_line_rate_links.organization_id
        )
      );
  END IF;
END $$;
