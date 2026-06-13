-- Project admin controls support:
-- 1. allow archived projects through the projects.status constraint
-- 2. widen activity_events so project/document admin mutations can be audited

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'projects'
      AND constraint_name = 'projects_status_check'
  ) THEN
    ALTER TABLE public.projects
      DROP CONSTRAINT projects_status_check;
  END IF;

  ALTER TABLE public.projects
    ADD CONSTRAINT projects_status_check
    CHECK (status IN ('active', 'inactive', 'draft', 'archived'));
END $$;

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
        'project'
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
        'project_deleted'
      )
    );
END $$;
