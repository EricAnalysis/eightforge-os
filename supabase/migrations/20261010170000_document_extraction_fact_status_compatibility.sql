-- Snapshot rows and normalized fact rows share this table. Preserve every
-- existing success/failed/partial status, while permitting the active ->
-- superseded lifecycle already used by documentExtractions.ts only for facts.
-- No rows, defaults, grants, RLS policies, or provenance are rewritten.
-- Forward fix only after fact rows exist: restoring the old constraint would
-- reject their established lifecycle and must not discard or remap history.
ALTER TABLE public.document_extractions
  DROP CONSTRAINT IF EXISTS document_extractions_status_check,
  ADD CONSTRAINT document_extractions_status_check
    CHECK (
      status IN ('success', 'failed', 'partial')
      OR (field_key IS NOT NULL AND status IN ('active', 'superseded'))
    );
