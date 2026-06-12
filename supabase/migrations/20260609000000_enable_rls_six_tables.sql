-- Migration: enable_rls_six_tables
-- Date: 2026-06-09
-- Purpose: Enable RLS on 6 tables flagged by Supabase security advisor.
--          Policies only — no schema changes, no column changes.
--
-- Tables:
--   workflows           — organization_id nullable (NULL = global/system row)
--   decision_policies   — organization_id nullable (NULL = global/system row)
--   decision_rules      — organization_id NOT NULL (always org-owned)
--   project_rule_overrides — no organization_id; scope via project_id → projects.organization_id
--   workflow_templates  — organization_id nullable (NULL = global/system row)
--   document_fields     — no organization_id; global definitions, readable by all authenticated users
--
-- Pattern matches existing org-scoped tables (signals, rules, document_extractions).
-- Service role bypasses RLS automatically — no explicit bypass policy required.
-- None of these tables are queried by app code via the anon key; all writes go
-- through the admin/service role. SELECT policies enforce tenant isolation for
-- any future browser reads.

-- ============================================================
-- 1. workflows
--    organization_id nullable: NULL rows = global/system workflows
--    visible to all authenticated users.
-- ============================================================

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflows_select_org"
  ON public.workflows
  FOR SELECT
  TO authenticated
  USING (
    organization_id IS NULL
    OR organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "workflows_insert_org"
  ON public.workflows
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "workflows_update_org"
  ON public.workflows
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "workflows_delete_org"
  ON public.workflows
  FOR DELETE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );


-- ============================================================
-- 2. decision_policies
--    organization_id nullable: NULL rows = global policies
--    visible to all authenticated users.
-- ============================================================

ALTER TABLE public.decision_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "decision_policies_select_org"
  ON public.decision_policies
  FOR SELECT
  TO authenticated
  USING (
    organization_id IS NULL
    OR organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "decision_policies_insert_org"
  ON public.decision_policies
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "decision_policies_update_org"
  ON public.decision_policies
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "decision_policies_delete_org"
  ON public.decision_policies
  FOR DELETE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );


-- ============================================================
-- 3. decision_rules
--    organization_id NOT NULL — strict org scope, no global rows.
-- ============================================================

ALTER TABLE public.decision_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "decision_rules_select_org"
  ON public.decision_rules
  FOR SELECT
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "decision_rules_insert_org"
  ON public.decision_rules
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "decision_rules_update_org"
  ON public.decision_rules
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "decision_rules_delete_org"
  ON public.decision_rules
  FOR DELETE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );


-- ============================================================
-- 4. project_rule_overrides
--    No organization_id column. Scope via project_id → projects.organization_id.
--    project_id is nullable; rows with NULL project_id are not accessible
--    via browser (service role only).
-- ============================================================

ALTER TABLE public.project_rule_overrides ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_rule_overrides_select_org"
  ON public.project_rule_overrides
  FOR SELECT
  TO authenticated
  USING (
    project_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.user_profiles up ON up.organization_id = p.organization_id
      WHERE p.id = project_rule_overrides.project_id
        AND up.id = auth.uid()
    )
  );

CREATE POLICY "project_rule_overrides_insert_org"
  ON public.project_rule_overrides
  FOR INSERT
  TO authenticated
  WITH CHECK (
    project_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.user_profiles up ON up.organization_id = p.organization_id
      WHERE p.id = project_rule_overrides.project_id
        AND up.id = auth.uid()
    )
  );

CREATE POLICY "project_rule_overrides_update_org"
  ON public.project_rule_overrides
  FOR UPDATE
  TO authenticated
  USING (
    project_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.user_profiles up ON up.organization_id = p.organization_id
      WHERE p.id = project_rule_overrides.project_id
        AND up.id = auth.uid()
    )
  )
  WITH CHECK (
    project_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.user_profiles up ON up.organization_id = p.organization_id
      WHERE p.id = project_rule_overrides.project_id
        AND up.id = auth.uid()
    )
  );

CREATE POLICY "project_rule_overrides_delete_org"
  ON public.project_rule_overrides
  FOR DELETE
  TO authenticated
  USING (
    project_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.projects p
      JOIN public.user_profiles up ON up.organization_id = p.organization_id
      WHERE p.id = project_rule_overrides.project_id
        AND up.id = auth.uid()
    )
  );


-- ============================================================
-- 5. workflow_templates
--    organization_id nullable: NULL rows = global/system templates
--    visible to all authenticated users.
-- ============================================================

ALTER TABLE public.workflow_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "workflow_templates_select_org"
  ON public.workflow_templates
  FOR SELECT
  TO authenticated
  USING (
    organization_id IS NULL
    OR organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "workflow_templates_insert_org"
  ON public.workflow_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "workflow_templates_update_org"
  ON public.workflow_templates
  FOR UPDATE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  )
  WITH CHECK (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );

CREATE POLICY "workflow_templates_delete_org"
  ON public.workflow_templates
  FOR DELETE
  TO authenticated
  USING (
    organization_id = (
      SELECT up.organization_id
      FROM public.user_profiles up
      WHERE up.id = auth.uid()
    )
  );


-- ============================================================
-- 6. document_fields
--    No organization_id — global field definitions, read-only for all
--    authenticated users. Write access is service role only.
--    Matches the original intent in migration 20250314000000 which was
--    apparently not applied to the live database.
-- ============================================================

ALTER TABLE public.document_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "document_fields_select_authenticated"
  ON public.document_fields
  FOR SELECT
  TO authenticated
  USING (true);

-- No INSERT/UPDATE/DELETE policies — mutations go through service role only.
