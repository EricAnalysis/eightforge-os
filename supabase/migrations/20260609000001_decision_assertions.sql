-- ============================================================================
-- MIGRATION: Operator decision assertion propagation schema
-- Date: 2026-06-09
-- Purpose: Persist structured operator decision assertions that propagate
--          across scope levels (invoice, project, contract_vehicle, client,
--          organization, global). Assertions are machine-readable — the
--          validator reads condition_json and confidence_binding directly.
--          rationale is human-facing only and MUST NOT be parsed by validator
--          logic.
-- Safety: CREATE TABLE IF NOT EXISTS. No destructive changes. No data writes.
-- Note:   operator_id references public.user_profiles (not profiles — actual
--         table name confirmed from codebase; spec used shorthand "profiles").
--         contract_vehicle_id and client_id are nullable UUID anchors only.
--         public.contracts and public.clients are not present in the deployed
--         schema, so this migration intentionally does not attach FKs to those
--         tables. Add guarded constraints later if/when those tables exist.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.decision_assertions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- Org scoping — all assertions must belong to an org
  org_id                  uuid NOT NULL REFERENCES public.organizations(id),

  -- Optional entity scope anchors
  project_id              uuid REFERENCES public.projects(id),
  contract_vehicle_id     uuid REFERENCES public.contracts(id),
  client_id               uuid REFERENCES public.clients(id),

  -- Scope level identifies what entity scope_id refers to
  scope_level             text NOT NULL,
  scope_id                uuid NOT NULL,

  -- Classification
  decision_type           text NOT NULL,

  -- Subject entity this assertion applies to
  subject_entity_type     text NOT NULL,
  subject_entity_id       uuid,

  -- Machine-readable structured conditions — never parsed as text by validator
  condition_json          jsonb NOT NULL DEFAULT '{}',

  -- Conditions under which this assertion applies
  confidence_binding      jsonb NOT NULL DEFAULT '{}',

  -- Lifecycle
  status                  text NOT NULL DEFAULT 'active',
  expiration_trigger_type text,
  expiration_trigger_id   uuid,
  superseded_by           uuid REFERENCES public.decision_assertions(id),

  -- Human-facing rationale — NEVER parsed by validator logic
  rationale               text,

  -- Attribution
  operator_id             uuid NOT NULL REFERENCES public.user_profiles(id),
  source_decision_id      uuid REFERENCES public.decisions(id)
);

-- ============================================================================
-- CHECK CONSTRAINTS
-- Wrapped in DO blocks to be idempotent on re-runs.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'decision_assertions'
      AND constraint_name = 'decision_assertions_scope_level_check'
  ) THEN
    ALTER TABLE public.decision_assertions
      ADD CONSTRAINT decision_assertions_scope_level_check
      CHECK (
        scope_level IN (
          'invoice',
          'project',
          'contract_vehicle',
          'client',
          'organization',
          'global'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'decision_assertions'
      AND constraint_name = 'decision_assertions_decision_type_check'
  ) THEN
    ALTER TABLE public.decision_assertions
      ADD CONSTRAINT decision_assertions_decision_type_check
      CHECK (
        decision_type IN (
          'contractor_alias',
          'rate_interpretation',
          'scope_exception',
          'invoice_correction',
          'business_rule'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'decision_assertions'
      AND constraint_name = 'decision_assertions_status_check'
  ) THEN
    ALTER TABLE public.decision_assertions
      ADD CONSTRAINT decision_assertions_status_check
      CHECK (
        status IN (
          'active',
          'superseded',
          'expired',
          'revoked'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'decision_assertions'
      AND constraint_name = 'decision_assertions_expiration_trigger_type_check'
  ) THEN
    ALTER TABLE public.decision_assertions
      ADD CONSTRAINT decision_assertions_expiration_trigger_type_check
      CHECK (
        expiration_trigger_type IS NULL
        OR expiration_trigger_type IN (
          'document_event',
          'time',
          'contract_end',
          'operator_revoke'
        )
      );
  END IF;
END $$;

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_decision_assertions_org_scope_status
  ON public.decision_assertions (org_id, scope_level, scope_id, status);

CREATE INDEX IF NOT EXISTS idx_decision_assertions_project_type_status
  ON public.decision_assertions (project_id, decision_type, status)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_decision_assertions_subject_status
  ON public.decision_assertions (subject_entity_type, subject_entity_id, status)
  WHERE subject_entity_id IS NOT NULL;

-- ============================================================================
-- UPDATED_AT TRIGGER
-- ============================================================================

DROP TRIGGER IF EXISTS trg_decision_assertions_updated_at ON public.decision_assertions;
CREATE TRIGGER trg_decision_assertions_updated_at
  BEFORE UPDATE ON public.decision_assertions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.decision_assertions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_assertions'
      AND policyname = 'decision_assertions_select_authenticated'
  ) THEN
    CREATE POLICY decision_assertions_select_authenticated
      ON public.decision_assertions
      FOR SELECT TO authenticated
      USING (org_id = public.get_current_user_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_assertions'
      AND policyname = 'decision_assertions_insert_authenticated'
  ) THEN
    CREATE POLICY decision_assertions_insert_authenticated
      ON public.decision_assertions
      FOR INSERT TO authenticated
      WITH CHECK (org_id = public.get_current_user_org_id());
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'decision_assertions'
      AND policyname = 'decision_assertions_update_authenticated'
  ) THEN
    CREATE POLICY decision_assertions_update_authenticated
      ON public.decision_assertions
      FOR UPDATE TO authenticated
      USING (org_id = public.get_current_user_org_id())
      WITH CHECK (org_id = public.get_current_user_org_id());
  END IF;
END $$;
