-- A repeated report of the same record mismatch on the same resolver surface is one finding.
-- Remove pre-fix duplicates before constraining the table, retaining the first-seen
-- evidence row by created_at and then id so its stable provenance remains canonical.
DELETE FROM public.state_projection_shadow_mismatches AS duplicate
USING public.state_projection_shadow_mismatches AS retained
WHERE duplicate.record_type IS NOT DISTINCT FROM retained.record_type
  AND duplicate.record_id IS NOT DISTINCT FROM retained.record_id
  AND duplicate.project_id IS NOT DISTINCT FROM retained.project_id
  AND duplicate.surface IS NOT DISTINCT FROM retained.surface
  AND (duplicate.created_at, duplicate.id) > (retained.created_at, retained.id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_state_projection_shadow_mismatches_natural_key
  ON public.state_projection_shadow_mismatches (record_type, record_id, project_id, surface);
