-- CS-16: restore projects.validation_phase, which drifted from
-- 20260430000000_document_truth_governance_phase (never applied to this database).
--
-- Scoped deliberately: this migration restores ONLY the validation_phase objects.
-- It intentionally does NOT replay that migration's activity_events_event_type_check
-- rewrite, because later migrations expanded the allowed event-type list and replaying
-- the April version would reject newer event types.

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS validation_phase text NOT NULL DEFAULT 'contract_setup';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'projects'
      AND constraint_name = 'projects_validation_phase_check'
  ) THEN
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
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_projects_validation_phase
  ON public.projects (validation_phase);
