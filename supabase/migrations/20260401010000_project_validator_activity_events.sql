-- Project validator audit support:
-- 1. ensure activity_events can be scoped directly to a project
-- 2. widen activity event constraints for validator run audit entries

ALTER TABLE public.activity_events
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES public.projects(id);

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
        'project_validation_run'
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
        'status_changed',
        'assignment_changed',
        'due_date_changed',
        'document_removed_from_project',
        'document_moved_to_project',
        'project_archived',
        'project_deleted',
        'validation_run_completed'
      )
    );
END $$;
