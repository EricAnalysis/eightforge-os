-- Restore the state_projection_shadow_mismatches write contract.
--
-- app/api/projects/[id]/shadow-mismatches/route.ts upserts through the
-- service-role client with onConflict (record_type, record_id, project_id,
-- surface) and ignoreDuplicates, i.e.
--   INSERT ... ON CONFLICT (record_type, record_id, project_id, surface) DO NOTHING
-- That needs two things production lacks:
--
--   1. A unique index matching the conflict target. It was first created in
--      20260716000000_state_projection_shadow_mismatches_unique, which never
--      reached production. 20260811170000_reconcile_production_schema drops it
--      so that a fresh build matches production, and this migration restores it
--      on both paths.
--
--   2. SELECT on the conflict-target columns. PostgreSQL requires it to infer
--      the arbiter index, even for DO NOTHING. Production grants service_role
--      INSERT only on this table, so the targeted upsert fails with
--      "permission denied". The grant is column-level: service_role can read
--      the four natural-key columns and still cannot read the evidence columns
--      (legacy_value, persisted_value, organization_id, created_at).
--
-- Production held no duplicate natural keys when this was written
-- (5 rows, 5 distinct keys), so no deduplication is performed here. If
-- duplicates exist, index creation fails loudly instead of deleting evidence.

CREATE UNIQUE INDEX IF NOT EXISTS idx_state_projection_shadow_mismatches_natural_key
  ON public.state_projection_shadow_mismatches (record_type, record_id, project_id, surface);

GRANT SELECT (record_type, record_id, project_id, surface)
  ON TABLE public.state_projection_shadow_mismatches TO service_role;
