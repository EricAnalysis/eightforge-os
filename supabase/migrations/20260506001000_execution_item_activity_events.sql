-- ============================================================================
-- MIGRATION: Execution item activity event coverage
-- Date: 2026-05-06
-- Purpose: Extend activity_events so validator finding generation and
--          execution item lifecycle mutations appear in Audit Forge.
-- ============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'activity_events'
      AND constraint_name = 'activity_events_entity_type_check'
  ) THEN
    ALTER TABLE public.activity_events
      DROP CONSTRAINT activity_events_entity_type_check;
  END IF;

  ALTER TABLE public.activity_events
    ADD CONSTRAINT activity_events_entity_type_check
    CHECK (
      entity_type IN (
        'decision',
        'workflow_task',
        'document',
        'project',
        'project_validation_run',
        'project_validation_finding',
        'execution_item'
      )
    );
END $$;

DO $$
BEGIN
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
        'validation_finding_generated',
        'override_applied',
        'review_recorded',
        'review_correction_applied',
        'governing_document_changed',
        'document_relationship_created',
        'document_relationship_changed',
        'document_precedence_changed',
        'document_subtype_updated',
        'project_validation_phase_changed',
        'execution_item_created',
        'execution_item_approved',
        'execution_item_corrected',
        'execution_item_overridden'
      )
    );
END $$;
