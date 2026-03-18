-- Migration: add_rls_document_extractions_rules_signals
-- Adds RLS to three previously unprotected tables (document_extractions,
-- rules, signals) and fills in the missing DELETE policies on decisions
-- and workflow_tasks.
--
-- All write policies are safety nets; API routes use the service role
-- which bypasses RLS. The SELECT policies are what actually enforce
-- tenant isolation for browser reads via the anon key.

-- ============================================================
-- document_extractions
-- organization_id is nullable; legacy rows (pre-fix) have NULL.
-- SELECT falls back to parent-document join for those rows.
-- ============================================================

ALTER TABLE public.document_extractions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_extractions_select_org"
  ON public.document_extractions
  FOR SELECT USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
    OR (
      organization_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM documents d
        JOIN user_profiles up ON up.organization_id = d.organization_id
        WHERE d.id = document_extractions.document_id
          AND up.id = auth.uid()
      )
    )
  );

CREATE POLICY "document_extractions_insert_org"
  ON public.document_extractions
  FOR INSERT WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "document_extractions_update_org"
  ON public.document_extractions
  FOR UPDATE
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

-- ============================================================
-- rules
-- NULL organization_id = global/system rule; visible to all.
-- Only org-owned rules can be mutated via anon key.
-- ============================================================

ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rules_select_org"
  ON public.rules
  FOR SELECT USING (
    organization_id IS NULL
    OR organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "rules_insert_org"
  ON public.rules
  FOR INSERT WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "rules_update_org"
  ON public.rules
  FOR UPDATE
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "rules_delete_org"
  ON public.rules
  FOR DELETE USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

-- ============================================================
-- signals — full org-scoped CRUD
-- ============================================================

ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "signals_select_org"
  ON public.signals
  FOR SELECT USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "signals_insert_org"
  ON public.signals
  FOR INSERT WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "signals_update_org"
  ON public.signals
  FOR UPDATE
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "signals_delete_org"
  ON public.signals
  FOR DELETE USING (
    organization_id = (
      SELECT up.organization_id
      FROM user_profiles up
      WHERE up.id = auth.uid()
    )
  );

-- ============================================================
-- Fill missing DELETE policies on decisions + workflow_tasks
-- (SELECT / INSERT / UPDATE already existed)
-- ============================================================

CREATE POLICY "decisions_delete_org"
  ON public.decisions
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = decisions.organization_id
    )
  );

CREATE POLICY "workflow_tasks_delete_org"
  ON public.workflow_tasks
  FOR DELETE USING (
    EXISTS (
      SELECT 1 FROM user_profiles up
      WHERE up.id = auth.uid()
        AND up.organization_id = workflow_tasks.organization_id
    )
  );
