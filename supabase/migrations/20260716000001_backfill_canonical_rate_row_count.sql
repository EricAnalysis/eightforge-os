-- Keep facts.rate_row_count transactionally aligned with the distinct row_id values
-- in the persisted canonical contract_analysis.rate_schedule_rows array. Fail loudly
-- on duplicate row IDs; this backfill leaves row arrays and evidence anchors unchanged.
DO $$
DECLARE
  target record;
  live_rows jsonb;
  raw_count integer;
  live_count integer;
  persisted_count integer;
BEGIN
  FOR target IN
    SELECT *
    FROM (VALUES
      ('582e57b2-0c75-4d05-89b2-520b0447f94f'::uuid, 32, 'TDOT'),
      ('6866832f-5126-435d-9329-f09bade970a8'::uuid, 5, 'MDOT'),
      ('18550bfc-c057-4aae-bfa3-db896e36edb0'::uuid, 105, 'Williamson')
    ) AS expected(document_id, expected_count, label)
  LOOP
    SELECT intelligence_trace #> '{contract_analysis,rate_schedule_rows}'
    INTO live_rows
    FROM public.documents
    WHERE id = target.document_id;

    IF NOT FOUND OR jsonb_typeof(live_rows) <> 'array' THEN
      RAISE EXCEPTION
        'CS-9 rate row count backfill requires a persisted rate_schedule_rows array for % (%).',
        target.label, target.document_id;
    END IF;

    raw_count := jsonb_array_length(live_rows);
    SELECT COUNT(DISTINCT rate_row ->> 'row_id')::integer
    INTO live_count
    FROM jsonb_array_elements(live_rows) AS rate_rows(rate_row);

    IF raw_count <> live_count THEN
      RAISE EXCEPTION
        'CS-9 rate row count duplicate guard failed for contract % (%): found % raw rows but % distinct row_id values.',
        target.label, target.document_id, raw_count, live_count;
    END IF;

    IF live_count <> target.expected_count THEN
      RAISE EXCEPTION
        'CS-9 rate row count guard failed for % (%): expected %, found %.',
        target.label, target.document_id, target.expected_count, live_count;
    END IF;

    UPDATE public.documents
    SET intelligence_trace = jsonb_set(
      intelligence_trace,
      '{facts}',
      jsonb_set(
        COALESCE(intelligence_trace -> 'facts', '{}'::jsonb),
        '{rate_row_count}',
        to_jsonb(live_count),
        true
      ),
      true
    )
    WHERE id = target.document_id;

    SELECT (intelligence_trace #>> '{facts,rate_row_count}')::integer
    INTO persisted_count
    FROM public.documents
    WHERE id = target.document_id;

    IF persisted_count IS DISTINCT FROM target.expected_count THEN
      RAISE EXCEPTION
        'CS-9 rate row count post-condition failed for % (%): expected %, persisted %.',
        target.label, target.document_id, target.expected_count, persisted_count;
    END IF;
  END LOOP;
END $$;
