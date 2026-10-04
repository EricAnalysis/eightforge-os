-- Field-level fact rows (field_key set) share public.document_extractions with
-- extraction snapshot rows (field_key NULL). The fact columns were added in
-- 20250314000000_deterministic_decision_backbone, but data stayed NOT NULL, so
-- every fact-row insert has failed and production holds no fact rows.
--
-- Fact rows carry their value in the field_value_* columns, not in data.
-- Snapshot rows must still always carry data; the CHECK constraint keeps that
-- invariant explicit now that the column itself allows NULL.

ALTER TABLE public.document_extractions
  ALTER COLUMN data DROP NOT NULL;

ALTER TABLE public.document_extractions
  DROP CONSTRAINT IF EXISTS document_extractions_snapshot_requires_data,
  ADD CONSTRAINT document_extractions_snapshot_requires_data
    CHECK (field_key IS NOT NULL OR data IS NOT NULL);
