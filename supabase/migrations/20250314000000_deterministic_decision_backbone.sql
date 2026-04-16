-- ============================================================================
-- MIGRATION: Deterministic Decision Backbone for EightForge
-- Date: 2025-03-14
-- Purpose: Extend and normalize schema for rule-based document evaluation
-- Safety: Uses ALTER TABLE ADD COLUMN IF NOT EXISTS for existing tables,
--         CREATE TABLE IF NOT EXISTS for new tables. No destructive changes.
-- ============================================================================


-- ============================================================================
-- SECTION 1: Extend public.documents with classification & processing fields
-- ============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS domain text,
  ADD COLUMN IF NOT EXISTS document_type text,
  ADD COLUMN IF NOT EXISTS source_type text DEFAULT 'upload',
  ADD COLUMN IF NOT EXISTS mime_type text,
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'uploaded',
  ADD COLUMN IF NOT EXISTS processing_error text,
  ADD COLUMN IF NOT EXISTS processed_at timestamptz,
  ADD COLUMN IF NOT EXISTS file_path text;

-- Check constraint for processing_status (safe: skip if already exists)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_processing_status_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_processing_status_check
      CHECK (processing_status IN ('uploaded', 'processing', 'extracted', 'decisioned', 'failed'));
  END IF;
END $$;

-- Index for processing_status queries
CREATE INDEX IF NOT EXISTS idx_documents_processing_status
  ON public.documents (processing_status);

-- Index for domain + document_type filtering
CREATE INDEX IF NOT EXISTS idx_documents_domain_type
  ON public.documents (domain, document_type)
  WHERE domain IS NOT NULL;


-- ============================================================================
-- SECTION 2: Extend public.document_extractions for normalized fact rows
-- ============================================================================
-- Existing columns preserved: id, document_id, data (jsonb), fields (jsonb),
-- extraction (jsonb), ai_enrichment (jsonb), status, created_at, updated_at, organization_id
-- We ADD new typed-value columns for deterministic rule evaluation.

ALTER TABLE public.document_extractions
  ADD COLUMN IF NOT EXISTS field_key text,
  ADD COLUMN IF NOT EXISTS field_value_text text,
  ADD COLUMN IF NOT EXISTS field_value_number numeric,
  ADD COLUMN IF NOT EXISTS field_value_date date,
  ADD COLUMN IF NOT EXISTS field_value_boolean boolean,
  ADD COLUMN IF NOT EXISTS field_type text,
  ADD COLUMN IF NOT EXISTS source text,
  ADD COLUMN IF NOT EXISTS confidence numeric,
  ADD COLUMN IF NOT EXISTS created_by uuid;

-- Ensure organization_id exists (may already be present)
ALTER TABLE public.document_extractions
  ADD COLUMN IF NOT EXISTS organization_id uuid;

-- Ensure status column exists with default (may already exist with different default)
-- We don't change existing default if column already exists
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'document_extractions'
      AND column_name = 'status'
  ) THEN
    ALTER TABLE public.document_extractions
      ADD COLUMN status text DEFAULT 'active';
  END IF;
END $$;

-- Indexes for rule engine lookups
CREATE INDEX IF NOT EXISTS idx_document_extractions_document_id
  ON public.document_extractions (document_id);

CREATE INDEX IF NOT EXISTS idx_document_extractions_organization_id
  ON public.document_extractions (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_extractions_field_key
  ON public.document_extractions (field_key)
  WHERE field_key IS NOT NULL;

-- Composite index for rule engine fact loading
CREATE INDEX IF NOT EXISTS idx_document_extractions_doc_field
  ON public.document_extractions (document_id, field_key)
  WHERE field_key IS NOT NULL;


-- ============================================================================
-- SECTION 3: Create public.document_fields (controlled rule builder fields)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.document_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text NOT NULL,
  document_type text NOT NULL,
  field_key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Unique constraint: one field definition per domain + document_type + field_key
CREATE UNIQUE INDEX IF NOT EXISTS idx_document_fields_domain_type_key
  ON public.document_fields (domain, document_type, field_key);


-- ============================================================================
-- SECTION 4: Create public.rules (deterministic rule definitions)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid,
  domain text NOT NULL,
  document_type text NOT NULL,
  rule_group text,
  name text NOT NULL,
  description text,
  decision_type text NOT NULL,
  severity text NOT NULL DEFAULT 'medium',
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL DEFAULT 'active',
  condition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  action_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  updated_by uuid
);

-- Check constraints for rules
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'rules_severity_check'
  ) THEN
    ALTER TABLE public.rules
      ADD CONSTRAINT rules_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'critical'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'rules_status_check'
  ) THEN
    ALTER TABLE public.rules
      ADD CONSTRAINT rules_status_check
      CHECK (status IN ('active', 'inactive', 'draft'));
  END IF;
END $$;

-- Indexes for rule loading
CREATE INDEX IF NOT EXISTS idx_rules_organization_id
  ON public.rules (organization_id)
  WHERE organization_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rules_domain
  ON public.rules (domain);

CREATE INDEX IF NOT EXISTS idx_rules_document_type
  ON public.rules (document_type);

CREATE INDEX IF NOT EXISTS idx_rules_status
  ON public.rules (status);

CREATE INDEX IF NOT EXISTS idx_rules_priority
  ON public.rules (priority);

-- Composite index for typical rule loading query
CREATE INDEX IF NOT EXISTS idx_rules_domain_type_status
  ON public.rules (domain, document_type, status, priority)
  WHERE status = 'active';


-- ============================================================================
-- SECTION 5: Extend public.decisions for rule engine compatibility
-- ============================================================================
-- The decisions table already exists with: id, document_id, organization_id,
-- decision_type, title, summary, severity, status, confidence, details (jsonb),
-- source, decision_rule_id, first_detected_at, last_detected_at, created_at,
-- updated_at, resolved_at, assigned_to, assigned_at, assigned_by.
-- We add missing columns needed by the new rule engine.

ALTER TABLE public.decisions
  ADD COLUMN IF NOT EXISTS rule_id uuid,
  ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS resolved_by uuid;

-- Add check constraints if not already present
DO $$ BEGIN
  -- severity check (may already exist)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'decisions_severity_check'
  ) THEN
    -- Use a permissive set that covers both old and new values
    ALTER TABLE public.decisions
      ADD CONSTRAINT decisions_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'critical'));
  END IF;
END $$;

DO $$ BEGIN
  -- source check
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'decisions_source_check'
  ) THEN
    -- Include all existing sources plus the new rule_engine source
    ALTER TABLE public.decisions
      ADD CONSTRAINT decisions_source_check
      CHECK (source IN ('rule_engine', 'ai_model', 'human_review', 'deterministic', 'ai_enriched', 'manual'));
  END IF;
END $$;

DO $$ BEGIN
  -- status check
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'decisions_status_check'
  ) THEN
    -- Include all existing statuses plus new ones
    ALTER TABLE public.decisions
      ADD CONSTRAINT decisions_status_check
      CHECK (status IN ('open', 'in_review', 'resolved', 'dismissed', 'suppressed'));
  END IF;
END $$;

-- Indexes (create if missing)
CREATE INDEX IF NOT EXISTS idx_decisions_organization_id
  ON public.decisions (organization_id);

CREATE INDEX IF NOT EXISTS idx_decisions_document_id
  ON public.decisions (document_id);

CREATE INDEX IF NOT EXISTS idx_decisions_status
  ON public.decisions (status);

CREATE INDEX IF NOT EXISTS idx_decisions_decision_type
  ON public.decisions (decision_type);

CREATE INDEX IF NOT EXISTS idx_decisions_created_at
  ON public.decisions (created_at DESC);

-- Composite index for deduplication check
CREATE INDEX IF NOT EXISTS idx_decisions_doc_rule_status
  ON public.decisions (document_id, rule_id, status)
  WHERE rule_id IS NOT NULL AND status IN ('open', 'in_review');


-- ============================================================================
-- SECTION 6: Extend public.workflow_tasks for rule engine compatibility
-- ============================================================================
-- workflow_tasks already exists with: id, organization_id, decision_id,
-- document_id, task_type, title, description, priority, status, source,
-- source_metadata (jsonb), details (jsonb), assigned_to, assigned_at,
-- assigned_by, due_at, created_at, updated_at.
-- Add missing columns and check constraints.

ALTER TABLE public.workflow_tasks
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

-- Check constraints for workflow_tasks
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'workflow_tasks_priority_check'
  ) THEN
    ALTER TABLE public.workflow_tasks
      ADD CONSTRAINT workflow_tasks_priority_check
      CHECK (priority IN ('low', 'medium', 'high', 'critical'));
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'workflow_tasks_status_check'
  ) THEN
    -- Include all existing values plus new constrained set
    ALTER TABLE public.workflow_tasks
      ADD CONSTRAINT workflow_tasks_status_check
      CHECK (status IN ('open', 'in_progress', 'completed', 'canceled', 'blocked', 'resolved', 'cancelled'));
  END IF;
END $$;

-- Indexes (create if missing)
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_organization_id
  ON public.workflow_tasks (organization_id);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_decision_id
  ON public.workflow_tasks (decision_id)
  WHERE decision_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_status
  ON public.workflow_tasks (status);

CREATE INDEX IF NOT EXISTS idx_workflow_tasks_created_at
  ON public.workflow_tasks (created_at DESC);

-- Composite dedup index
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_decision_type_status
  ON public.workflow_tasks (decision_id, task_type, status)
  WHERE decision_id IS NOT NULL AND status IN ('open', 'in_progress');


-- ============================================================================
-- SECTION 7: Extend public.decision_feedback for rule engine feedback
-- ============================================================================
-- decision_feedback already exists with: id, organization_id, decision_id,
-- feedback_type, is_correct, disposition, notes, created_by, created_at,
-- updated_at, decision_status_at_feedback, metadata (jsonb).
-- Add missing columns from the new spec.

ALTER TABLE public.decision_feedback
  ADD COLUMN IF NOT EXISTS reviewer_id uuid,
  ADD COLUMN IF NOT EXISTS correction_type text,
  ADD COLUMN IF NOT EXISTS corrected_value jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Indexes (create if missing)
CREATE INDEX IF NOT EXISTS idx_decision_feedback_decision_id
  ON public.decision_feedback (decision_id);

CREATE INDEX IF NOT EXISTS idx_decision_feedback_organization_id
  ON public.decision_feedback (organization_id);

CREATE INDEX IF NOT EXISTS idx_decision_feedback_created_at
  ON public.decision_feedback (created_at DESC);


-- ============================================================================
-- SECTION 8: Create public.signals (operational signals / anomaly tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  signal_type text NOT NULL,
  entity_type text,
  entity_id uuid,
  title text NOT NULL,
  description text,
  severity text NOT NULL DEFAULT 'medium',
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Check constraints for signals
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'signals_severity_check'
  ) THEN
    ALTER TABLE public.signals
      ADD CONSTRAINT signals_severity_check
      CHECK (severity IN ('low', 'medium', 'high', 'critical'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'signals_status_check'
  ) THEN
    ALTER TABLE public.signals
      ADD CONSTRAINT signals_status_check
      CHECK (status IN ('active', 'resolved', 'ignored'));
  END IF;
END $$;

-- Indexes for signals
CREATE INDEX IF NOT EXISTS idx_signals_organization_id
  ON public.signals (organization_id);

CREATE INDEX IF NOT EXISTS idx_signals_signal_type
  ON public.signals (signal_type);

CREATE INDEX IF NOT EXISTS idx_signals_status
  ON public.signals (status);

CREATE INDEX IF NOT EXISTS idx_signals_created_at
  ON public.signals (created_at DESC);


-- ============================================================================
-- SECTION 9: Updated_at trigger for public.rules
-- ============================================================================

-- Create a reusable trigger function if it doesn't exist
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to rules table
DROP TRIGGER IF EXISTS trg_rules_updated_at ON public.rules;
CREATE TRIGGER trg_rules_updated_at
  BEFORE UPDATE ON public.rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- SECTION 10: Foreign keys (conservative, safe additions)
-- ============================================================================

-- document_extractions.document_id → documents.id (SET NULL on delete — preserve extraction history)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'document_extractions_document_id_fkey'
      AND table_name = 'document_extractions'
  ) THEN
    -- Only add if not already constrained
    ALTER TABLE public.document_extractions
      ADD CONSTRAINT document_extractions_document_id_fkey
      FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE SET NULL;
  END IF;
END $$;

-- decisions.document_id → documents.id (CASCADE — decisions are meaningless without the document)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'decisions_document_id_fkey'
      AND table_name = 'decisions'
  ) THEN
    ALTER TABLE public.decisions
      ADD CONSTRAINT decisions_document_id_fkey
      FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;
  END IF;
END $$;

-- decisions.rule_id → rules.id (SET NULL — keep decision even if rule is deleted)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'decisions_rule_id_fkey'
      AND table_name = 'decisions'
  ) THEN
    ALTER TABLE public.decisions
      ADD CONSTRAINT decisions_rule_id_fkey
      FOREIGN KEY (rule_id) REFERENCES public.rules(id) ON DELETE SET NULL;
  END IF;
END $$;

-- workflow_tasks.decision_id → decisions.id (CASCADE — task loses meaning without decision)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'workflow_tasks_decision_id_fkey'
      AND table_name = 'workflow_tasks'
  ) THEN
    ALTER TABLE public.workflow_tasks
      ADD CONSTRAINT workflow_tasks_decision_id_fkey
      FOREIGN KEY (decision_id) REFERENCES public.decisions(id) ON DELETE CASCADE;
  END IF;
END $$;

-- decision_feedback.decision_id → decisions.id (CASCADE — feedback for deleted decision is irrelevant)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'decision_feedback_decision_id_fkey'
      AND table_name = 'decision_feedback'
  ) THEN
    ALTER TABLE public.decision_feedback
      ADD CONSTRAINT decision_feedback_decision_id_fkey
      FOREIGN KEY (decision_id) REFERENCES public.decisions(id) ON DELETE CASCADE;
  END IF;
END $$;


-- ============================================================================
-- SECTION 11: RLS policies for new tables
-- ============================================================================

-- document_fields: read-only for authenticated users (no org scoping, these are global definitions)
ALTER TABLE public.document_fields ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'document_fields_select_authenticated'
  ) THEN
    CREATE POLICY document_fields_select_authenticated
      ON public.document_fields FOR SELECT TO authenticated
      USING (true);
  END IF;
END $$;

-- rules: org-scoped reads (global rules where organization_id IS NULL are visible to all)
ALTER TABLE public.rules ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'rules_select_org'
  ) THEN
    CREATE POLICY rules_select_org
      ON public.rules FOR SELECT TO authenticated
      USING (
        organization_id IS NULL
        OR EXISTS (
          SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid() AND up.organization_id = rules.organization_id
        )
      );
  END IF;
END $$;

-- signals: org-scoped reads
ALTER TABLE public.signals ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'signals_select_org'
  ) THEN
    CREATE POLICY signals_select_org
      ON public.signals FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.user_profiles up
          WHERE up.id = auth.uid() AND up.organization_id = signals.organization_id
        )
      );
  END IF;
END $$;


-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
