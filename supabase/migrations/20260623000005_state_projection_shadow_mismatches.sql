-- Durable evidence sink for server-side state-projection shadow mismatches.
-- Phase 1 intentionally captures only trusted server/admin writes.

CREATE TABLE IF NOT EXISTS public.state_projection_shadow_mismatches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  record_type text NOT NULL,
  record_id text NOT NULL,
  project_id text,
  organization_id text,
  legacy_value text,
  persisted_value text,
  surface text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_state_projection_shadow_mismatches_record_type_created_at
  ON public.state_projection_shadow_mismatches (record_type, created_at);

CREATE INDEX IF NOT EXISTS idx_state_projection_shadow_mismatches_project_id_created_at
  ON public.state_projection_shadow_mismatches (project_id, created_at);

ALTER TABLE public.state_projection_shadow_mismatches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.state_projection_shadow_mismatches FROM anon;
REVOKE ALL ON TABLE public.state_projection_shadow_mismatches FROM authenticated;
GRANT INSERT ON TABLE public.state_projection_shadow_mismatches TO service_role;
