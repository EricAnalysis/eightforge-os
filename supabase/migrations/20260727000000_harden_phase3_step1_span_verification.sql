-- Phase 3 Step 1 hardening: make the database independently verify the
-- source-span and transformation properties enforced by verifyFieldCandidate.
-- The constraint trigger is deferred because candidate dependency rows are
-- inserted after the candidate inside the transactional publisher.

CREATE OR REPLACE FUNCTION public.verify_extraction_candidate_content()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  concatenated_raw_text text;
  fragment_count integer;
  transformation_count integer;
  transformation_index integer := 0;
  transformation jsonb;
  replayed text;
  operation text;
  output_text text;
  expected_normalized jsonb;
  decimal_input text;
  decimal_negative boolean;
  decimal_whole text;
  decimal_fraction text;
  date_match text[];
  date_value date;
BEGIN
  SELECT
    count(*),
    string_agg(fragment.raw_text, '' ORDER BY source.sequence)
  INTO fragment_count, concatenated_raw_text
  FROM public.extraction_field_candidate_sources source
  JOIN public.extraction_fragment_artifacts fragment
    ON fragment.organization_id = source.organization_id
   AND fragment.extraction_run_id = source.extraction_run_id
   AND fragment.id = source.fragment_artifact_id
  WHERE source.organization_id = NEW.organization_id
    AND source.extraction_run_id = NEW.extraction_run_id
    AND source.field_candidate_id = NEW.id;

  IF fragment_count = 0 OR concatenated_raw_text IS DISTINCT FROM NEW.raw_text THEN
    RAISE EXCEPTION 'candidate raw_text must equal its ordered source fragments'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.extraction_field_candidate_sources source
    JOIN public.extraction_fragment_artifacts fragment
      ON fragment.organization_id = source.organization_id
     AND fragment.extraction_run_id = source.extraction_run_id
     AND fragment.id = source.fragment_artifact_id
    WHERE source.organization_id = NEW.organization_id
      AND source.extraction_run_id = NEW.extraction_run_id
      AND source.field_candidate_id = NEW.id
      AND NOT (
        fragment.bbox_x0 >= 0
        AND fragment.bbox_x0 < fragment.bbox_x1
        AND fragment.bbox_x1 <= 1
        AND fragment.bbox_y0 >= 0
        AND fragment.bbox_y0 < fragment.bbox_y1
        AND fragment.bbox_y1 <= 1
      )
  ) THEN
    RAISE EXCEPTION 'candidate source fragment has an invalid normalized bounding box'
      USING ERRCODE = '23514';
  END IF;

  transformation_count := jsonb_array_length(NEW.transformations);
  replayed := NEW.raw_text;
  FOR transformation IN
    SELECT value
    FROM jsonb_array_elements(NEW.transformations)
    ORDER BY (value->>'sequence')::integer
  LOOP
    transformation_index := transformation_index + 1;
    IF (transformation->>'sequence')::integer <> transformation_index
      OR transformation->>'input_text' IS DISTINCT FROM replayed
      OR transformation->>'input_sha256' IS DISTINCT FROM
        encode(sha256(convert_to(replayed, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'candidate transformation % has an invalid input trace',
        transformation_index
        USING ERRCODE = '23514';
    END IF;

    operation := transformation->>'operation';
    output_text := transformation->>'output_text';
    CASE operation
      WHEN 'unicode_nfkc' THEN
        replayed := normalize(replayed, NFKC);
      WHEN 'collapse_whitespace' THEN
        replayed := regexp_replace(btrim(replayed), '\s+', ' ', 'g');
      WHEN 'normalize_line_breaks' THEN
        replayed := replace(replace(replayed, E'\r\n', E'\n'), E'\r', E'\n');
      WHEN 'join_ordered_fragments' THEN
        NULL;
      WHEN 'strip_currency_symbol' THEN
        replayed := regexp_replace(replayed, '^\s*[$]\s*', '');
      WHEN 'remove_group_separator' THEN
        replayed := replace(replayed, ',', '');
      WHEN 'decimal_parse' THEN
        decimal_input := btrim(replayed);
        IF decimal_input !~ '^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$' THEN
          RAISE EXCEPTION 'candidate transformation % is not a decimal',
            transformation_index
            USING ERRCODE = '23514';
        END IF;
        decimal_negative := left(decimal_input, 1) = '-';
        decimal_input := regexp_replace(decimal_input, '^[+-]', '');
        decimal_whole := split_part(decimal_input, '.', 1);
        decimal_fraction := CASE
          WHEN position('.' IN decimal_input) > 0
            THEN split_part(decimal_input, '.', 2)
          ELSE ''
        END;
        IF decimal_whole = '' THEN decimal_whole := '0'; END IF;
        decimal_whole := ltrim(decimal_whole, '0');
        IF decimal_whole = '' THEN decimal_whole := '0'; END IF;
        decimal_fraction := regexp_replace(decimal_fraction, '0+$', '');
        replayed := CASE
          WHEN decimal_negative
            AND NOT (decimal_whole = '0' AND decimal_fraction = '')
            THEN '-'
          ELSE ''
        END || decimal_whole || CASE
          WHEN decimal_fraction <> '' THEN '.' || decimal_fraction
          ELSE ''
        END;
      WHEN 'date_parse' THEN
        date_match := regexp_match(
          btrim(replayed),
          '^([0-9]{4})-([0-9]{2})-([0-9]{2})$'
        );
        IF date_match IS NULL THEN
          date_match := regexp_match(
            btrim(replayed),
            '^([0-9]{1,2})[/-]([0-9]{1,2})[/-]([0-9]{4})$'
          );
          IF date_match IS NULL THEN
            RAISE EXCEPTION 'candidate transformation % is not a supported date',
              transformation_index
              USING ERRCODE = '23514';
          END IF;
          BEGIN
            date_value := make_date(
              date_match[3]::integer,
              date_match[1]::integer,
              date_match[2]::integer
            );
          EXCEPTION WHEN datetime_field_overflow THEN
            RAISE EXCEPTION 'candidate transformation % is not a valid date',
              transformation_index
              USING ERRCODE = '23514';
          END;
        ELSE
          BEGIN
            date_value := make_date(
              date_match[1]::integer,
              date_match[2]::integer,
              date_match[3]::integer
            );
          EXCEPTION WHEN datetime_field_overflow THEN
            RAISE EXCEPTION 'candidate transformation % is not a valid date',
              transformation_index
              USING ERRCODE = '23514';
          END;
        END IF;
        replayed := to_char(date_value, 'YYYY-MM-DD');
      WHEN 'ocr_glyph_substitution' THEN
        -- The domain verifier owns independent-corroboration policy. SQL still
        -- verifies chain continuity and the recorded output hash.
        replayed := output_text;
      ELSE
        RAISE EXCEPTION 'candidate transformation % has an unsupported operation',
          transformation_index
          USING ERRCODE = '23514';
    END CASE;

    IF output_text IS DISTINCT FROM replayed
      OR transformation->>'output_sha256' IS DISTINCT FROM
        encode(sha256(convert_to(replayed, 'UTF8')), 'hex') THEN
      RAISE EXCEPTION 'candidate transformation % has an invalid output trace',
        transformation_index
        USING ERRCODE = '23514';
    END IF;
  END LOOP;

  IF transformation_index <> transformation_count THEN
    RAISE EXCEPTION 'candidate transformations require contiguous sequence values'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.primitive_kind = 'text' THEN
    expected_normalized := jsonb_build_object('type', 'text', 'value', replayed);
  ELSIF NEW.primitive_kind = 'decimal' THEN
    decimal_input := replayed;
    IF decimal_input !~ '^-?([0-9]+)(\.[0-9]+)?$' THEN
      RAISE EXCEPTION 'candidate replay does not produce a canonical decimal'
        USING ERRCODE = '23514';
    END IF;
    expected_normalized := jsonb_build_object(
      'type', 'decimal', 'value', decimal_input
    );
  ELSIF NEW.primitive_kind = 'date' THEN
    IF replayed !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'candidate replay does not produce a canonical date'
        USING ERRCODE = '23514';
    END IF;
    BEGIN
      date_value := make_date(
        substring(replayed, 1, 4)::integer,
        substring(replayed, 6, 2)::integer,
        substring(replayed, 9, 2)::integer
      );
    EXCEPTION WHEN datetime_field_overflow THEN
      RAISE EXCEPTION 'candidate replay does not produce a valid date'
        USING ERRCODE = '23514';
    END;
    expected_normalized := jsonb_build_object(
      'type', 'date', 'value', to_char(date_value, 'YYYY-MM-DD')
    );
  ELSIF NEW.primitive_kind = 'boolean' THEN
    IF replayed NOT IN ('true', 'false') THEN
      RAISE EXCEPTION 'candidate replay does not produce a canonical boolean'
        USING ERRCODE = '23514';
    END IF;
    expected_normalized := jsonb_build_object(
      'type', 'boolean', 'value', replayed::boolean
    );
  END IF;

  IF NEW.proposed_value IS DISTINCT FROM expected_normalized THEN
    RAISE EXCEPTION 'candidate normalized value does not match transformation replay'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_extraction_candidate_content() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_extraction_field_candidates_content
  ON public.extraction_field_candidates;
CREATE CONSTRAINT TRIGGER trg_extraction_field_candidates_content
  AFTER INSERT ON public.extraction_field_candidates
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.verify_extraction_candidate_content();

-- Step 0 already created an equivalent range check. This separately named
-- constraint makes the Step 1 publication contract explicit and protects gap
-- boxes if the original constraint is ever widened for another writer.
ALTER TABLE public.extraction_processing_gaps
  ADD CONSTRAINT extraction_processing_gaps_bbox_check_v2
  CHECK (
    (bbox_x0 IS NULL AND bbox_y0 IS NULL AND bbox_x1 IS NULL
      AND bbox_y1 IS NULL AND bbox_rotation IS NULL)
    OR
    (bbox_x0 IS NOT NULL AND bbox_y0 IS NOT NULL
      AND bbox_x1 IS NOT NULL AND bbox_y1 IS NOT NULL
      AND bbox_rotation IS NOT NULL
      AND bbox_x0 >= 0 AND bbox_x0 < bbox_x1 AND bbox_x1 <= 1
      AND bbox_y0 >= 0 AND bbox_y0 < bbox_y1 AND bbox_y1 <= 1
      AND bbox_rotation IN (0, 90, 180, 270))
  ) NOT VALID;

ALTER TABLE public.extraction_processing_gaps
  VALIDATE CONSTRAINT extraction_processing_gaps_bbox_check_v2;

ALTER TABLE public.extraction_processing_gaps
  DROP CONSTRAINT extraction_processing_gaps_bbox_check;

ALTER TABLE public.extraction_processing_gaps
  RENAME CONSTRAINT extraction_processing_gaps_bbox_check_v2
  TO extraction_processing_gaps_bbox_check;
