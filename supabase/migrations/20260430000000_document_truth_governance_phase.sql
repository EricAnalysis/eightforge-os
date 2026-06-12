-- Canonical document truth governance:
-- add document_subtype, project validation phases, and activity event coverage
-- so relationships, subtype resolution, and validator phases share one truth cycle.

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS document_subtype text;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS validation_phase text NOT NULL DEFAULT 'contract_setup';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'documents'
      AND constraint_name = 'documents_document_subtype_check'
  ) THEN
    ALTER TABLE public.documents
      DROP CONSTRAINT documents_document_subtype_check;
  END IF;

  ALTER TABLE public.documents
    ADD CONSTRAINT documents_document_subtype_check
    CHECK (
      document_subtype IS NULL OR document_subtype IN (
        'base_contract',
        'pricing_schedule',
        'compliance_requirements',
        'amendment',
        'replacement_contract',
        'supporting_document',
        'invoice',
        'transaction_data',
        'reference'
      )
    );

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'document_relationships'
      AND constraint_name = 'document_relationships_relationship_type_check'
  ) THEN
    ALTER TABLE public.document_relationships
      DROP CONSTRAINT document_relationships_relationship_type_check;
  END IF;

  ALTER TABLE public.document_relationships
    ADD CONSTRAINT document_relationships_relationship_type_check
    CHECK (
      relationship_type IN (
        'attached_to',
        'supplements',
        'amends',
        'supersedes',
        'governs',
        'replaces',
        'supports',
        'applies_to'
      )
    );

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'projects'
      AND constraint_name = 'projects_validation_phase_check'
  ) THEN
    ALTER TABLE public.projects
      DROP CONSTRAINT projects_validation_phase_check;
  END IF;

  ALTER TABLE public.projects
    ADD CONSTRAINT projects_validation_phase_check
    CHECK (
      validation_phase IN (
        'contract_setup',
        'execution',
        'billing_review',
        'closeout'
      )
    );

  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'activity_events'
      AND constraint_name = 'activity_events_event_type_check'
  ) THEN
    ALTER TABLE public.activity_events
      DROP CONSTRAINT activity_events_event_type_check;
  END IF;

  ALTER TABLE public.activity_events
    ADD CONSTRAINT activity_events_event_type_check
    CHECK (
      event_type IN (
        'created',
        'updated',
        'status_changed',
        'assignment_changed',
        'due_date_changed',
        'document_removed_from_project',
        'document_moved_to_project',
        'project_archived',
        'project_deleted',
        'validation_run_requested',
        'validation_run_completed',
        'override_applied',
        'review_recorded',
        'review_correction_applied',
        'governing_document_changed',
        'document_relationship_created',
        'document_relationship_changed',
        'document_precedence_changed',
        'document_subtype_updated',
        'project_validation_phase_changed'
      )
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_documents_project_document_subtype
  ON public.documents (project_id, document_subtype)
  WHERE project_id IS NOT NULL AND document_subtype IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_projects_validation_phase
  ON public.projects (validation_phase);
