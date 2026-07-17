-- A repeated report of the same record mismatch on the same resolver surface is one finding.
-- This makes the shadow evidence endpoint safe to retry without losing its stable identity.
CREATE UNIQUE INDEX IF NOT EXISTS idx_state_projection_shadow_mismatches_natural_key
  ON public.state_projection_shadow_mismatches (record_type, record_id, project_id, surface);
