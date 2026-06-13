-- ============================================================================
-- MIGRATION: Document precedence and governing document relationships
-- Date: 2026-03-23
-- Purpose: Add explicit precedence metadata so projects can resolve governing
--          documents without relying on upload recency alone.
-- Safety: Incremental only. Adds nullable columns and a new relationship table.
-- ============================================================================

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS document_role text,
  ADD COLUMN IF NOT EXISTS authority_status text,
  ADD COLUMN IF NOT EXISTS effective_date date,
  ADD COLUMN IF NOT EXISTS precedence_rank integer,
  ADD COLUMN IF NOT EXISTS operator_override_precedence boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_document_role_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_document_role_check
      CHECK (
        document_role IN (
          'base_contract',
          'contract_amendment',
          'rate_sheet',
          'permit',
          'ticket_export',
          'invoice',
          'invoice_revision',
          'supporting_attachment',
          'other'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_authority_status_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_authority_status_check
      CHECK (
        authority_status IN (
          'active',
          'superseded',
          'draft',
          'archived',
          'reference_only'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'documents_precedence_rank_nonnegative_check'
  ) THEN
    ALTER TABLE public.documents
      ADD CONSTRAINT documents_precedence_rank_nonnegative_check
      CHECK (precedence_rank IS NULL OR precedence_rank >= 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_project_document_role
  ON public.documents (project_id, document_role)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_project_authority_status
  ON public.documents (project_id, authority_status)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_project_precedence_rank
  ON public.documents (project_id, precedence_rank)
  WHERE project_id IS NOT NULL AND precedence_rank IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_project_effective_date
  ON public.documents (project_id, effective_date DESC)
  WHERE project_id IS NOT NULL AND effective_date IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.document_relationships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  source_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  target_document_id uuid NOT NULL REFERENCES public.documents(id) ON DELETE CASCADE,
  relationship_type text NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_relationships_source_target_check
    CHECK (source_document_id <> target_document_id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'document_relationships_relationship_type_check'
  ) THEN
    ALTER TABLE public.document_relationships
      ADD CONSTRAINT document_relationships_relationship_type_check
      CHECK (
        relationship_type IN (
          'supersedes',
          'amends',
          'governs',
          'replaces',
          'supports',
          'applies_to'
        )
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_document_relationships_unique_edge
  ON public.document_relationships (
    project_id,
    source_document_id,
    target_document_id,
    relationship_type
  );

CREATE INDEX IF NOT EXISTS idx_document_relationships_organization_id
  ON public.document_relationships (organization_id);

CREATE INDEX IF NOT EXISTS idx_document_relationships_project_id
  ON public.document_relationships (project_id);

CREATE INDEX IF NOT EXISTS idx_document_relationships_source_document_id
  ON public.document_relationships (source_document_id);

CREATE INDEX IF NOT EXISTS idx_document_relationships_target_document_id
  ON public.document_relationships (target_document_id);

CREATE INDEX IF NOT EXISTS idx_document_relationships_relationship_type
  ON public.document_relationships (relationship_type);

ALTER TABLE public.document_relationships ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_relationships_select_authenticated'
  ) THEN
    CREATE POLICY document_relationships_select_authenticated
      ON public.document_relationships
      FOR SELECT TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_relationships.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_relationships_insert_authenticated'
  ) THEN
    CREATE POLICY document_relationships_insert_authenticated
      ON public.document_relationships
      FOR INSERT TO authenticated
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_relationships.organization_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'document_relationships_update_authenticated'
  ) THEN
    CREATE POLICY document_relationships_update_authenticated
      ON public.document_relationships
      FOR UPDATE TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.user_profiles up
          WHERE up.id = auth.uid()
            AND up.organization_id = document_relationships.organization_id
        )
      );
  END IF;
END $$;
