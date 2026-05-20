-- ============================================================================
-- MIGRATION: Canonical execution items
-- Date: 2026-05-06
-- Purpose: Add one project-scoped operational resolution layer for approval-
--          impacting work created from validator findings and finalized in
--          Execution Forge.
-- Safety: Incremental only. Uses IF NOT EXISTS patterns for repeated runs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.execution_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_id uuid NOT NULL,
  source_key text NOT NULL,
  severity text NOT NULL,
  title text NOT NULL,
  problem text NOT NULL,
  expected_value text,
  actual_value text,
  impact text NOT NULL,
  required_action text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  outcome text,
  evidence_refs text[] NOT NULL DEFAULT '{}'::text[],
  fact_refs text[] NOT NULL DEFAULT '{}'::text[],
  validator_rule_key text,
  override_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'execution_items'
      AND constraint_name = 'execution_items_source_type_check'
  ) THEN
    ALTER TABLE public.execution_items
      ADD CONSTRAINT execution_items_source_type_check
      CHECK (source_type IN ('validator_finding'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'execution_items'
      AND constraint_name = 'execution_items_severity_check'
  ) THEN
    ALTER TABLE public.execution_items
      ADD CONSTRAINT execution_items_severity_check
      CHECK (severity IN ('critical', 'high', 'medium', 'low'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'execution_items'
      AND constraint_name = 'execution_items_status_check'
  ) THEN
    ALTER TABLE public.execution_items
      ADD CONSTRAINT execution_items_status_check
      CHECK (status IN ('open', 'resolvable', 'resolved'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'execution_items'
      AND constraint_name = 'execution_items_outcome_check'
  ) THEN
    ALTER TABLE public.execution_items
      ADD CONSTRAINT execution_items_outcome_check
      CHECK (outcome IS NULL OR outcome IN ('confirmed', 'resolved', 'overridden'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_items_project_source_key
  ON public.execution_items (project_id, source_type, source_key);

CREATE INDEX IF NOT EXISTS idx_execution_items_project_status
  ON public.execution_items (project_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_execution_items_project_updated
  ON public.execution_items (project_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_execution_items_source
  ON public.execution_items (source_type, source_id);

CREATE INDEX IF NOT EXISTS idx_execution_items_organization_updated
  ON public.execution_items (organization_id, updated_at DESC);

DROP TRIGGER IF EXISTS trg_execution_items_updated_at ON public.execution_items;
CREATE TRIGGER trg_execution_items_updated_at
  BEFORE UPDATE ON public.execution_items
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.execution_items ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'execution_items'
      AND policyname = 'execution_items_select_authenticated'
  ) THEN
    CREATE POLICY execution_items_select_authenticated
      ON public.execution_items
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = execution_items.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'execution_items'
      AND policyname = 'execution_items_insert_authenticated'
  ) THEN
    CREATE POLICY execution_items_insert_authenticated
      ON public.execution_items
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = execution_items.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'execution_items'
      AND policyname = 'execution_items_update_authenticated'
  ) THEN
    CREATE POLICY execution_items_update_authenticated
      ON public.execution_items
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = execution_items.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = execution_items.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;
END $$;
