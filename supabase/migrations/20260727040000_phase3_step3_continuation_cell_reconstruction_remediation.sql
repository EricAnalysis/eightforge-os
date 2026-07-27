-- Phase 3 Step 3 targeted remediation.
-- This remains shadow-only: no reader, canonical fact, validator, or legacy
-- serialization path is changed.

-- The V2 continuation policy persists page distance as first-class measured
-- evidence alongside its source fragment closure.
DO $migration$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid =
      'public.extraction_table_continuation_link_basis_fragments'::regclass
    AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%basis_kind%';
  IF constraint_name IS NULL THEN
    RAISE EXCEPTION 'continuation basis-kind constraint was not found'
      USING ERRCODE = '23514';
  END IF;
  EXECUTE format(
    'ALTER TABLE public.extraction_table_continuation_link_basis_fragments
       DROP CONSTRAINT %I',
    constraint_name
  );
END;
$migration$;

ALTER TABLE public.extraction_table_continuation_link_basis_fragments
  ADD CONSTRAINT step3_continuation_basis_kind_check CHECK (basis_kind IN (
    'column_band_similarity', 'header_similarity', 'edge_proximity',
    'typography_similarity', 'row_continuation_score',
    'page_distance_penalty', 'overall'
  ));

-- Reject invalid cell dependency edges before generic foreign-key/unique errors
-- can obscure the Step 3 reconstruction contract. The deferred reconstruction
-- trigger below remains the authoritative whole-cell check.
CREATE OR REPLACE FUNCTION public.enforce_extraction_table_cell_dependency_edge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  parent public.extraction_fragment_artifacts%ROWTYPE;
  dependency public.extraction_fragment_artifacts%ROWTYPE;
  existing_count integer;
BEGIN
  SELECT * INTO parent
  FROM public.extraction_fragment_artifacts fragment
  WHERE fragment.organization_id = NEW.organization_id
    AND fragment.id = NEW.fragment_artifact_id;
  IF parent.id IS NULL OR parent.kind <> 'cell' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO dependency
  FROM public.extraction_fragment_artifacts fragment
  WHERE fragment.organization_id = NEW.organization_id
    AND fragment.id = NEW.dependency_fragment_artifact_id;
  SELECT count(*) INTO existing_count
  FROM public.extraction_fragment_dependencies edge
  WHERE edge.organization_id = NEW.organization_id
    AND edge.extraction_run_id = NEW.extraction_run_id
    AND edge.fragment_artifact_id = NEW.fragment_artifact_id;

  IF dependency.id IS NULL
    OR dependency.kind <> 'token'
    OR NEW.extraction_run_id <> parent.extraction_run_id
    OR dependency.extraction_run_id <> parent.extraction_run_id
    OR dependency.source_artifact_id <> parent.source_artifact_id
    OR dependency.source_document_id <> parent.source_document_id
    OR dependency.source_sha256 <> parent.source_sha256
    OR dependency.parser_manifest_hash <> parent.parser_manifest_hash
    OR dependency.page_artifact_id <> parent.page_artifact_id
    OR dependency.page <> parent.page
    OR NEW.sequence <> existing_count + 1
    OR EXISTS (
      SELECT 1
      FROM public.extraction_fragment_dependencies edge
      WHERE edge.organization_id = NEW.organization_id
        AND edge.extraction_run_id = NEW.extraction_run_id
        AND edge.fragment_artifact_id = NEW.fragment_artifact_id
        AND edge.dependency_fragment_artifact_id =
          NEW.dependency_fragment_artifact_id
    ) THEN
    RAISE EXCEPTION
      'table cell dependency must be a unique, dense, same-source ordered token edge'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_extraction_table_cell_dependency_edge()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_extraction_table_cell_dependency_edge
  ON public.extraction_fragment_dependencies;
CREATE TRIGGER trg_extraction_table_cell_dependency_edge
  BEFORE INSERT ON public.extraction_fragment_dependencies
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_extraction_table_cell_dependency_edge();

-- Independently reconstruct every cell from its ordered token dependencies.
-- Policy V2 uses canonical center-y/x/reading-order/id ordering, groups tokens
-- into observed lines using row_center_tolerance, joins tokens with one space,
-- joins lines with LF, and stores Unicode-code-point offsets immediately before
-- each LF. This is the SQL enforcement boundary; candidate checks are not used.
CREATE OR REPLACE FUNCTION public.check_extraction_table_cell_reconstruction()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  declared_ids uuid[];
  dependency_ids uuid[];
  canonical_ids uuid[];
  declared_offsets integer[];
  reconstructed_offsets integer[] := ARRAY[]::integer[];
  reconstructed_text text := '';
  line_texts text[] := ARRAY[]::text[];
  line_x0 double precision[] := ARRAY[]::double precision[];
  line_centers double precision[] := ARRAY[]::double precision[];
  line_orders integer[] := ARRAY[]::integer[];
  line_ids uuid[] := ARRAY[]::uuid[];
  line_text text;
  line_first_center double precision;
  center_y double precision;
  tolerance double precision;
  dependency_count integer;
  dense_count integer;
  valid_count integer;
  token record;
BEGIN
  IF NEW.kind <> 'cell' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(NEW.artifact_data->'content_token_ids') <> 'array'
    OR jsonb_array_length(NEW.artifact_data->'content_token_ids') = 0
    OR jsonb_typeof(NEW.artifact_data->'line_break_offsets') <> 'array'
    OR NEW.artifact_data#>>'{reconstruction_policy,name}'
      <> 'generic-geometric-table-reconstruction'
    OR NEW.artifact_data#>>'{reconstruction_policy,version}' <> 'v2' THEN
    RAISE EXCEPTION 'table cell reconstruction metadata is missing or unversioned'
      USING ERRCODE = '23514';
  END IF;

  tolerance :=
    (NEW.artifact_data#>>'{reconstruction_policy,row_center_tolerance}')::double precision;
  IF tolerance <> 0.018 THEN
    RAISE EXCEPTION 'table cell reconstruction policy tolerance diverged'
      USING ERRCODE = '23514';
  END IF;
  SELECT array_agg(value::text::uuid ORDER BY ordinality)
    INTO declared_ids
  FROM jsonb_array_elements_text(NEW.artifact_data->'content_token_ids')
    WITH ORDINALITY AS source(value, ordinality);
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.artifact_data->'line_break_offsets') source(value)
    WHERE jsonb_typeof(value) <> 'number'
      OR value::text !~ '^[0-9]+$'
  ) THEN
    RAISE EXCEPTION 'table cell line-break offsets must be nonnegative integers'
      USING ERRCODE = '23514';
  END IF;
  SELECT COALESCE(array_agg(value::text::integer ORDER BY ordinality), ARRAY[]::integer[])
    INTO declared_offsets
  FROM jsonb_array_elements(NEW.artifact_data->'line_break_offsets')
    WITH ORDINALITY AS source(value, ordinality);

  SELECT
    count(*),
    count(DISTINCT edge.sequence),
    array_agg(edge.dependency_fragment_artifact_id ORDER BY edge.sequence),
    count(*) FILTER (
      WHERE fragment.kind = 'token'
        AND fragment.extraction_run_id = NEW.extraction_run_id
        AND fragment.source_artifact_id = NEW.source_artifact_id
        AND fragment.source_document_id = NEW.source_document_id
        AND fragment.source_sha256 = NEW.source_sha256
        AND fragment.parser_manifest_hash = NEW.parser_manifest_hash
        AND fragment.page_artifact_id = NEW.page_artifact_id
        AND fragment.page = NEW.page
    )
  INTO dependency_count, dense_count, dependency_ids, valid_count
  FROM public.extraction_fragment_dependencies edge
  LEFT JOIN public.extraction_fragment_artifacts fragment
    ON fragment.organization_id = edge.organization_id
   AND fragment.id = edge.dependency_fragment_artifact_id
  WHERE edge.organization_id = NEW.organization_id
    AND edge.extraction_run_id = NEW.extraction_run_id
    AND edge.fragment_artifact_id = NEW.id;

  IF dependency_count = 0
    OR dense_count <> dependency_count
    OR valid_count <> dependency_count
    OR dependency_ids IS DISTINCT FROM declared_ids
    OR array_length(dependency_ids, 1) <> dependency_count THEN
    RAISE EXCEPTION
      'table cell dependencies are missing, foreign, duplicated, or do not match declared order'
      USING ERRCODE = '23514';
  END IF;

  SELECT array_agg(fragment.id ORDER BY
      (fragment.bbox_y0 + fragment.bbox_y1) / 2,
      fragment.bbox_x0, fragment.reading_order, fragment.id)
    INTO canonical_ids
  FROM public.extraction_fragment_dependencies edge
  JOIN public.extraction_fragment_artifacts fragment
    ON fragment.organization_id = edge.organization_id
   AND fragment.extraction_run_id = edge.extraction_run_id
   AND fragment.id = edge.dependency_fragment_artifact_id
  WHERE edge.organization_id = NEW.organization_id
    AND edge.extraction_run_id = NEW.extraction_run_id
    AND edge.fragment_artifact_id = NEW.id;
  IF canonical_ids IS DISTINCT FROM dependency_ids THEN
    RAISE EXCEPTION 'table cell token dependency order is not canonical'
      USING ERRCODE = '23514';
  END IF;

  FOR token IN
    SELECT fragment.*
    FROM public.extraction_fragment_dependencies edge
    JOIN public.extraction_fragment_artifacts fragment
      ON fragment.organization_id = edge.organization_id
     AND fragment.extraction_run_id = edge.extraction_run_id
     AND fragment.id = edge.dependency_fragment_artifact_id
    WHERE edge.organization_id = NEW.organization_id
      AND edge.extraction_run_id = NEW.extraction_run_id
      AND edge.fragment_artifact_id = NEW.id
    ORDER BY (fragment.bbox_y0 + fragment.bbox_y1) / 2,
      fragment.bbox_x0, fragment.reading_order, fragment.id
  LOOP
    center_y := (token.bbox_y0 + token.bbox_y1) / 2;
    IF line_first_center IS NOT NULL
      AND abs(center_y - line_first_center) > tolerance THEN
      SELECT string_agg(
          parts.raw_text, ' '
          ORDER BY parts.x0, parts.center_y, parts.reading_order, parts.id
        )
        INTO line_text
      FROM unnest(line_texts, line_x0, line_centers, line_orders, line_ids)
        AS parts(raw_text, x0, center_y, reading_order, id);
      IF reconstructed_text <> '' THEN
        reconstructed_offsets :=
          array_append(reconstructed_offsets, char_length(reconstructed_text));
        reconstructed_text := reconstructed_text || E'\n';
      END IF;
      reconstructed_text := reconstructed_text || line_text;
      line_texts := ARRAY[]::text[];
      line_x0 := ARRAY[]::double precision[];
      line_centers := ARRAY[]::double precision[];
      line_orders := ARRAY[]::integer[];
      line_ids := ARRAY[]::uuid[];
      line_first_center := NULL;
    END IF;
    IF line_first_center IS NULL THEN
      line_first_center := center_y;
    END IF;
    line_texts := array_append(line_texts, token.raw_text);
    line_x0 := array_append(line_x0, token.bbox_x0);
    line_centers := array_append(line_centers, center_y);
    line_orders := array_append(line_orders, token.reading_order);
    line_ids := array_append(line_ids, token.id);
  END LOOP;

  SELECT string_agg(
      parts.raw_text, ' '
      ORDER BY parts.x0, parts.center_y, parts.reading_order, parts.id
    )
    INTO line_text
  FROM unnest(line_texts, line_x0, line_centers, line_orders, line_ids)
    AS parts(raw_text, x0, center_y, reading_order, id);
  IF reconstructed_text <> '' THEN
    reconstructed_offsets :=
      array_append(reconstructed_offsets, char_length(reconstructed_text));
    reconstructed_text := reconstructed_text || E'\n';
  END IF;
  reconstructed_text := reconstructed_text || COALESCE(line_text, '');

  IF reconstructed_text IS DISTINCT FROM NEW.raw_text
    OR reconstructed_offsets IS DISTINCT FROM declared_offsets THEN
    RAISE EXCEPTION 'table cell raw text or line-break offsets diverge from ordered tokens'
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.check_extraction_table_cell_reconstruction()
  FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_extraction_table_cell_reconstruction
  ON public.extraction_fragment_artifacts;
CREATE CONSTRAINT TRIGGER trg_extraction_table_cell_reconstruction
  AFTER INSERT ON public.extraction_fragment_artifacts
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.check_extraction_table_cell_reconstruction();
