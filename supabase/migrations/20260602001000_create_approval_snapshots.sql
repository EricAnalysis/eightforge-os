-- Approval snapshot tables used by lib/server/approvalSnapshots.ts.
-- These are append-only audit snapshots; no validator truth is derived from
-- them, and validation correctness must not depend on their presence.

CREATE TABLE IF NOT EXISTS public.project_approval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  approval_status text NOT NULL CHECK (
    approval_status IN (
      'approved',
      'approved_with_exceptions',
      'needs_review',
      'blocked',
      'not_evaluated'
    )
  ),
  total_billed numeric(12, 2),
  total_supported numeric(12, 2),
  at_risk_amount numeric(12, 2),
  blocked_amount numeric(12, 2),
  invoice_count integer NOT NULL DEFAULT 0,
  blocked_invoice_count integer NOT NULL DEFAULT 0,
  needs_review_invoice_count integer NOT NULL DEFAULT 0,
  approved_invoice_count integer NOT NULL DEFAULT 0,
  finding_ids text[] NOT NULL DEFAULT '{}'::text[],
  billing_group_ids text[],
  validation_trigger_source text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.invoice_approval_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  invoice_number text,
  approval_status text NOT NULL CHECK (
    approval_status IN (
      'approved',
      'approved_with_exceptions',
      'needs_review',
      'blocked'
    )
  ),
  billed_amount numeric(12, 2),
  supported_amount numeric(12, 2),
  at_risk_amount numeric(12, 2),
  reconciliation_status text,
  blocking_reasons text[] NOT NULL DEFAULT '{}'::text[],
  billing_group_ids text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_approval_snapshots_project_created
  ON public.project_approval_snapshots (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_approval_snapshots_project_created
  ON public.invoice_approval_snapshots (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_approval_snapshots_invoice_number
  ON public.invoice_approval_snapshots (invoice_number)
  WHERE invoice_number IS NOT NULL;

ALTER TABLE public.project_approval_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invoice_approval_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS project_approval_snapshots_select_authenticated
  ON public.project_approval_snapshots;

CREATE POLICY project_approval_snapshots_select_authenticated
  ON public.project_approval_snapshots
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = project_approval_snapshots.project_id
        AND p.organization_id = public.get_current_user_org_id()
    )
  );

DROP POLICY IF EXISTS invoice_approval_snapshots_select_authenticated
  ON public.invoice_approval_snapshots;

CREATE POLICY invoice_approval_snapshots_select_authenticated
  ON public.invoice_approval_snapshots
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.projects p
      WHERE p.id = invoice_approval_snapshots.project_id
        AND p.organization_id = public.get_current_user_org_id()
    )
  );
