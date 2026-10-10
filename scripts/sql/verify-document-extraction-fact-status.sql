-- Disposable replay database only. ROLLBACK keeps fixtures and repeated DDL
-- out of the subsequent authority checks and preserves all pre-existing rows.
BEGIN;

INSERT INTO public.document_extractions (id, data, status, field_key)
SELECT ('99000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  jsonb_build_object('preserved_fixture', n), state,
  CASE WHEN n > 3 THEN 'legacy_fact_' || n ELSE NULL END
FROM (VALUES
  (1, 'success'), (2, 'failed'), (3, 'partial'),
  (4, 'success'), (5, 'failed'), (6, 'partial')
) AS legacy(n, state);

CREATE TEMP TABLE preserved_extraction_status_rows AS
SELECT id, to_jsonb(extraction) AS original_row
FROM public.document_extractions extraction;

\ir ../../supabase/migrations/20261010170000_document_extraction_fact_status_compatibility.sql
\ir ../../supabase/migrations/20261010170000_document_extraction_fact_status_compatibility.sql

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM preserved_extraction_status_rows old
    FULL JOIN public.document_extractions current USING (id)
    WHERE old.original_row IS DISTINCT FROM to_jsonb(current)
  ) THEN
    RAISE EXCEPTION 'repeated compatibility migration changed existing rows';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.document_extractions'::regclass
        AND conname = 'document_extractions_status_check'
        AND contype = 'c' AND convalidated) <> 1 THEN
    RAISE EXCEPTION 'status constraint is not uniquely validated';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = 'public.document_extractions'::regclass
        AND conname = 'document_extractions_snapshot_requires_data'
        AND convalidated) THEN
    RAISE EXCEPTION 'snapshot data constraint was lost';
  END IF;
END $$;

INSERT INTO public.document_extractions (id, data, status, field_key)
VALUES ('99000000-0000-4000-8000-000000000007', NULL, 'active', 'new_fact');
UPDATE public.document_extractions SET status = 'superseded'
WHERE id = '99000000-0000-4000-8000-000000000007';
INSERT INTO public.document_extractions (id, data, status, field_key)
VALUES ('99000000-0000-4000-8000-000000000008', NULL, 'active', 'new_fact');

DO $$
DECLARE
  sample record;
  rejected integer := 0;
BEGIN
  IF (SELECT count(*) FROM public.document_extractions
      WHERE id IN ('99000000-0000-4000-8000-000000000007',
                   '99000000-0000-4000-8000-000000000008')
        AND data IS NULL AND field_key = 'new_fact'
        AND status IN ('active', 'superseded')) <> 2 THEN
    RAISE EXCEPTION 'normalized fact lifecycle did not persist';
  END IF;
  FOR sample IN SELECT * FROM (VALUES
    ('active', NULL::text, '{}'::jsonb),
    ('superseded', NULL::text, '{}'::jsonb),
    ('pending', NULL::text, '{}'::jsonb),
    ('pending', 'invalid_fact', NULL::jsonb),
    ('success', NULL::text, NULL::jsonb),
    ('failed', NULL::text, NULL::jsonb),
    ('partial', NULL::text, NULL::jsonb)
  ) AS invalid(state, key, blob)
  LOOP
    BEGIN
      INSERT INTO public.document_extractions (data, status, field_key)
      VALUES (sample.blob, sample.state, sample.key);
    EXCEPTION WHEN check_violation THEN
      rejected := rejected + 1;
      CONTINUE;
    END;
    RAISE EXCEPTION 'invalid row unexpectedly accepted: %', row_to_json(sample);
  END LOOP;
  IF rejected <> 7 THEN
    RAISE EXCEPTION 'expected seven check violations, got %', rejected;
  END IF;
END $$;

ROLLBACK;
\echo DOCUMENT EXTRACTION FACT STATUS: PASS (six preserved rows; migration twice; fact lifecycle; seven 23514 rejections)
