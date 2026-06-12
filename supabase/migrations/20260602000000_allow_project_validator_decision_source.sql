-- Allow validator decision sync to persist records with source='project_validator'.
-- The application reads and writes this source explicitly for project-scoped
-- validator decisions, but the live check constraint only allowed older values.

ALTER TABLE public.decisions
  DROP CONSTRAINT IF EXISTS decisions_source_check;

ALTER TABLE public.decisions
  ADD CONSTRAINT decisions_source_check
  CHECK (
    source IN (
      'rule_engine',
      'ai_model',
      'human_review',
      'deterministic',
      'ai_enriched',
      'manual',
      'project_validator'
    )
  );
