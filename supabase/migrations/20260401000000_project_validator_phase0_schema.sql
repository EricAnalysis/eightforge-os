-- ============================================================================
-- MIGRATION: Project validator phase 0 schema
-- Date: 2026-04-01
-- Purpose: Add project-scoped validator persistence and project validation
--          summary fields.
-- Safety: Incremental only. Uses IF NOT EXISTS patterns for repeated runs.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.project_validation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  triggered_by text NOT NULL,
  triggered_by_user_id uuid REFERENCES auth.users(id),
  rules_applied text[] NOT NULL DEFAULT '{}'::text[],
  rule_version text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  findings_count integer NOT NULL DEFAULT 0,
  critical_count integer NOT NULL DEFAULT 0,
  warning_count integer NOT NULL DEFAULT 0,
  info_count integer NOT NULL DEFAULT 0,
  inputs_snapshot_hash text,
  run_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.project_validation_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.project_validation_runs(id) ON DELETE CASCADE,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  check_key text NOT NULL,
  category text NOT NULL,
  severity text NOT NULL,
  status text NOT NULL DEFAULT 'open',
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  field text,
  expected text,
  actual text,
  variance numeric,
  variance_unit text,
  blocked_reason text,
  decision_eligible boolean NOT NULL DEFAULT false,
  action_eligible boolean NOT NULL DEFAULT false,
  linked_decision_id uuid,
  linked_action_id uuid,
  resolved_by_user_id uuid REFERENCES auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.project_validation_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  finding_id uuid NOT NULL REFERENCES public.project_validation_findings(id) ON DELETE CASCADE,
  evidence_type text NOT NULL,
  source_document_id uuid REFERENCES public.documents(id),
  source_page integer,
  fact_id uuid,
  record_id text,
  field_name text,
  field_value text,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.project_validation_rule_state (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  tolerance_override jsonb,
  muted_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'NOT_READY',
  ADD COLUMN IF NOT EXISTS validation_summary_json jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_runs'
      AND constraint_name = 'project_validation_runs_triggered_by_check'
  ) THEN
    ALTER TABLE public.project_validation_runs
      ADD CONSTRAINT project_validation_runs_triggered_by_check
      CHECK (
        triggered_by IN (
          'document_processed',
          'fact_override',
          'relationship_change',
          'manual'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_category_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_category_check
      CHECK (
        category IN (
          'required_sources',
          'identity_consistency',
          'financial_integrity',
          'ticket_integrity'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_severity_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_severity_check
      CHECK (severity IN ('critical', 'warning', 'info'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_status_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_status_check
      CHECK (status IN ('open', 'resolved', 'dismissed', 'muted'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_findings'
      AND constraint_name = 'project_validation_findings_check_key_format_check'
  ) THEN
    ALTER TABLE public.project_validation_findings
      ADD CONSTRAINT project_validation_findings_check_key_format_check
      CHECK (check_key = rule_id || ':' || subject_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'project_validation_rule_state'
      AND constraint_name = 'project_validation_rule_state_project_rule_unique'
  ) THEN
    ALTER TABLE public.project_validation_rule_state
      ADD CONSTRAINT project_validation_rule_state_project_rule_unique
      UNIQUE (project_id, rule_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'projects'
      AND constraint_name = 'projects_validation_status_check'
  ) THEN
    ALTER TABLE public.projects
      ADD CONSTRAINT projects_validation_status_check
      CHECK (
        validation_status IN (
          'NOT_READY',
          'BLOCKED',
          'VALIDATED',
          'FINDINGS_OPEN'
        )
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_project_validation_runs_project_run_at
  ON public.project_validation_runs (project_id, run_at DESC);

CREATE INDEX IF NOT EXISTS idx_project_validation_findings_project_status_severity
  ON public.project_validation_findings (project_id, status, severity);

CREATE INDEX IF NOT EXISTS idx_project_validation_findings_run_id
  ON public.project_validation_findings (run_id);

CREATE INDEX IF NOT EXISTS idx_project_validation_evidence_finding_id
  ON public.project_validation_evidence (finding_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_validation_findings_open_dedupe
  ON public.project_validation_findings (project_id, check_key, status)
  WHERE status = 'open';

DROP TRIGGER IF EXISTS trg_project_validation_runs_updated_at ON public.project_validation_runs;
CREATE TRIGGER trg_project_validation_runs_updated_at
  BEFORE UPDATE ON public.project_validation_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_project_validation_findings_updated_at ON public.project_validation_findings;
CREATE TRIGGER trg_project_validation_findings_updated_at
  BEFORE UPDATE ON public.project_validation_findings
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS trg_project_validation_rule_state_updated_at ON public.project_validation_rule_state;
CREATE TRIGGER trg_project_validation_rule_state_updated_at
  BEFORE UPDATE ON public.project_validation_rule_state
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.project_validation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_validation_findings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_validation_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.project_validation_rule_state ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_runs'
      AND policyname = 'project_validation_runs_select_authenticated'
  ) THEN
    CREATE POLICY project_validation_runs_select_authenticated
      ON public.project_validation_runs
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_runs.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_runs'
      AND policyname = 'project_validation_runs_insert_authenticated'
  ) THEN
    CREATE POLICY project_validation_runs_insert_authenticated
      ON public.project_validation_runs
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_runs.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_runs'
      AND policyname = 'project_validation_runs_update_authenticated'
  ) THEN
    CREATE POLICY project_validation_runs_update_authenticated
      ON public.project_validation_runs
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_runs.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_runs.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_findings'
      AND policyname = 'project_validation_findings_select_authenticated'
  ) THEN
    CREATE POLICY project_validation_findings_select_authenticated
      ON public.project_validation_findings
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_findings.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_findings'
      AND policyname = 'project_validation_findings_insert_authenticated'
  ) THEN
    CREATE POLICY project_validation_findings_insert_authenticated
      ON public.project_validation_findings
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_findings.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_findings'
      AND policyname = 'project_validation_findings_update_authenticated'
  ) THEN
    CREATE POLICY project_validation_findings_update_authenticated
      ON public.project_validation_findings
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_findings.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_findings.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_evidence'
      AND policyname = 'project_validation_evidence_select_authenticated'
  ) THEN
    CREATE POLICY project_validation_evidence_select_authenticated
      ON public.project_validation_evidence
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.project_validation_findings f
          JOIN public.projects p ON p.id = f.project_id
          WHERE f.id = project_validation_evidence.finding_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_evidence'
      AND policyname = 'project_validation_evidence_insert_authenticated'
  ) THEN
    CREATE POLICY project_validation_evidence_insert_authenticated
      ON public.project_validation_evidence
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.project_validation_findings f
          JOIN public.projects p ON p.id = f.project_id
          WHERE f.id = project_validation_evidence.finding_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_rule_state'
      AND policyname = 'project_validation_rule_state_select_authenticated'
  ) THEN
    CREATE POLICY project_validation_rule_state_select_authenticated
      ON public.project_validation_rule_state
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_rule_state.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_rule_state'
      AND policyname = 'project_validation_rule_state_insert_authenticated'
  ) THEN
    CREATE POLICY project_validation_rule_state_insert_authenticated
      ON public.project_validation_rule_state
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_rule_state.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'project_validation_rule_state'
      AND policyname = 'project_validation_rule_state_update_authenticated'
  ) THEN
    CREATE POLICY project_validation_rule_state_update_authenticated
      ON public.project_validation_rule_state
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_rule_state.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.projects p
          WHERE p.id = project_validation_rule_state.project_id
            AND p.organization_id = public.get_current_user_org_id()
        )
      );
  END IF;
END $$;
