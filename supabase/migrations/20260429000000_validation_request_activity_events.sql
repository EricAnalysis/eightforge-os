-- Approval-gate audit support:
-- widen activity_events to capture validator rerun requests and system decision refreshes.

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
        'override_applied',
        'review_recorded',
        'review_correction_applied',
        'governing_document_changed',
        'document_relationship_changed',
        'document_precedence_changed'
      )
    );
END $$;
