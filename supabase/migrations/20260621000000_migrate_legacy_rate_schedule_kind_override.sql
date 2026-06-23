-- Migrate the Golden Project's sole legacy rate schedule kind override to the
-- canonical fact key while preserving its identity, value, and attribution.
DO $$
DECLARE
  legacy_override public.document_fact_overrides%ROWTYPE;
  legacy_count bigint;
  canonical_count bigint;
BEGIN
  SELECT count(*)
  INTO legacy_count
  FROM public.document_fact_overrides
  WHERE field_key = 'canonical_contract_rate_schedule_assembly_schedule_kind';

  SELECT count(*)
  INTO canonical_count
  FROM public.document_fact_overrides
  WHERE document_id = '18550bfc-c057-4aae-bfa3-db896e36edb0'::uuid
    AND field_key = 'rate_schedule_kind';

  IF legacy_count = 0 AND canonical_count = 1 THEN
    RAISE NOTICE 'Golden Project rate schedule kind override is already canonical';
    RETURN;
  END IF;

  IF legacy_count = 0 AND canonical_count = 0 THEN
    RAISE NOTICE 'No legacy or canonical rate schedule kind override found; fresh install, nothing to migrate';
    RETURN;
  END IF;

  IF legacy_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one legacy rate schedule kind override, found %',
      legacy_count;
  END IF;

  IF canonical_count <> 0 THEN
    RAISE EXCEPTION
      'Canonical rate schedule kind override conflict: found % row(s)',
      canonical_count;
  END IF;

  SELECT dfo.*
  INTO STRICT legacy_override
  FROM public.document_fact_overrides AS dfo
  JOIN public.documents AS d ON d.id = dfo.document_id
  WHERE d.project_id = '437502f2-d46d-447f-81e3-f26fa7ba0c14'::uuid
    AND dfo.document_id = '18550bfc-c057-4aae-bfa3-db896e36edb0'::uuid
    AND dfo.field_key = 'canonical_contract_rate_schedule_assembly_schedule_kind';

  DELETE FROM public.document_fact_overrides
  WHERE id = legacy_override.id;

  legacy_override.field_key := 'rate_schedule_kind';

  INSERT INTO public.document_fact_overrides
  SELECT legacy_override.*;

  IF EXISTS (
    SELECT 1
    FROM public.document_fact_overrides
    WHERE field_key = 'canonical_contract_rate_schedule_assembly_schedule_kind'
  ) THEN
    RAISE EXCEPTION 'Legacy rate schedule kind overrides remain after migration';
  END IF;
END
$$;
