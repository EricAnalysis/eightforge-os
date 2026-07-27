-- Phase 3 pre-Step-3 remediation: a fragment's role is contextual to one
-- candidate, so persist it on the candidate-to-fragment edge.

ALTER TABLE public.extraction_field_candidate_sources
  ADD COLUMN dependency_role text NOT NULL DEFAULT 'content';

ALTER TABLE public.extraction_field_candidate_sources
  ADD CONSTRAINT extraction_field_candidate_sources_dependency_role_check
  CHECK (dependency_role IN ('content', 'corroboration')) NOT VALID;

ALTER TABLE public.extraction_field_candidate_sources
  VALIDATE CONSTRAINT extraction_field_candidate_sources_dependency_role_check;

-- Preserve the already-audited transformation replay implementation while
-- changing only its raw-span aggregation to the role-aware domain semantics.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_fragment_aggregation constant text := $old$
  SELECT
    count(*),
    string_agg(fragment.raw_text, '' ORDER BY source.sequence)
  INTO fragment_count, concatenated_raw_text
$old$;
  new_fragment_aggregation constant text := $new$
  SELECT
    count(*) FILTER (WHERE source.dependency_role = 'content'),
    string_agg(fragment.raw_text, '' ORDER BY source.sequence)
      FILTER (WHERE source.dependency_role = 'content')
  INTO fragment_count, concatenated_raw_text
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.verify_extraction_candidate_content()'::regprocedure;

  replaced_body := replace(
    function_body,
    old_fragment_aggregation,
    new_fragment_aggregation
  );
  IF replaced_body = function_body THEN
    RAISE EXCEPTION
      'expected Step 1 candidate verifier aggregation was not found'
      USING ERRCODE = '23514';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.verify_extraction_candidate_content()
       RETURNS trigger
       LANGUAGE plpgsql
       SECURITY INVOKER
       SET search_path = ''''
       AS %L',
    replaced_body
  );
END;
$migration$;

REVOKE ALL ON FUNCTION public.verify_extraction_candidate_content() FROM PUBLIC;

-- Extend the existing publisher in place. The migration deliberately patches
-- the exact previously-reviewed body and fails closed if that baseline drifts.
DO $migration$
DECLARE
  function_body text;
  replaced_body text;
  old_source_insert constant text := $old$
    INSERT INTO public.extraction_field_candidate_sources (
      organization_id, extraction_run_id, field_candidate_id,
      fragment_artifact_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'source_fragment_ids')
      WITH ORDINALITY AS source(value, ordinality);
$old$;
  new_source_insert constant text := $new$
    IF jsonb_typeof(COALESCE(
      item->'source_fragment_dependencies', 'null'::jsonb
    )) <> 'array'
      OR jsonb_array_length(item->'source_fragment_dependencies') = 0
      OR (
        SELECT jsonb_agg(
          to_jsonb(dependency->>'fragment_artifact_id')
          ORDER BY ordinality
        )
        FROM jsonb_array_elements(item->'source_fragment_dependencies')
          WITH ORDINALITY AS source(dependency, ordinality)
      ) IS DISTINCT FROM item->'source_fragment_ids' THEN
      RAISE EXCEPTION
        'candidate dependency roles must close over ordered source fragments'
        USING ERRCODE = '23514';
    END IF;
    INSERT INTO public.extraction_field_candidate_sources (
      organization_id, extraction_run_id, field_candidate_id,
      fragment_artifact_id, sequence, dependency_role
    )
    SELECT
      org_id,
      run_id,
      (item->>'id')::uuid,
      (dependency->>'fragment_artifact_id')::uuid,
      ordinality,
      dependency->>'dependency_role'
    FROM jsonb_array_elements(item->'source_fragment_dependencies')
      WITH ORDINALITY AS source(dependency, ordinality);
$new$;
  old_reuse_return constant text := $old$
    IF snapshot_row.id IS NULL
      OR snapshot_row.id <> snapshot_id
      OR snapshot_row.status <> payload->>'snapshot_status'
      OR snapshot_row.content_extraction_fingerprint
        <> payload->>'content_extraction_fingerprint'
      OR snapshot_row.artifact_root_hash <> payload->>'artifact_root_hash' THEN
      RAISE EXCEPTION 'Step 1 idempotent publication does not match its snapshot'
        USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object(
$old$;
  new_reuse_return constant text := $new$
    IF snapshot_row.id IS NULL
      OR snapshot_row.id <> snapshot_id
      OR snapshot_row.status <> payload->>'snapshot_status'
      OR snapshot_row.content_extraction_fingerprint
        <> payload->>'content_extraction_fingerprint'
      OR snapshot_row.artifact_root_hash <> payload->>'artifact_root_hash' THEN
      RAISE EXCEPTION 'Step 1 idempotent publication does not match its snapshot'
        USING ERRCODE = '23514';
    END IF;
    IF EXISTS (
      (
        SELECT
          source.field_candidate_id,
          source.fragment_artifact_id,
          source.sequence,
          source.dependency_role
        FROM public.extraction_field_candidate_sources source
        WHERE source.organization_id = org_id
          AND source.extraction_run_id = run_row.id
        EXCEPT
        SELECT
          (candidate->>'id')::uuid,
          (dependency->>'fragment_artifact_id')::uuid,
          ordinality::integer,
          dependency->>'dependency_role'
        FROM jsonb_array_elements(payload->'candidates') candidate
        CROSS JOIN LATERAL jsonb_array_elements(
          candidate->'source_fragment_dependencies'
        ) WITH ORDINALITY AS source(dependency, ordinality)
      )
      UNION ALL
      (
        SELECT
          (candidate->>'id')::uuid,
          (dependency->>'fragment_artifact_id')::uuid,
          ordinality::integer,
          dependency->>'dependency_role'
        FROM jsonb_array_elements(payload->'candidates') candidate
        CROSS JOIN LATERAL jsonb_array_elements(
          candidate->'source_fragment_dependencies'
        ) WITH ORDINALITY AS source(dependency, ordinality)
        EXCEPT
        SELECT
          source.field_candidate_id,
          source.fragment_artifact_id,
          source.sequence,
          source.dependency_role
        FROM public.extraction_field_candidate_sources source
        WHERE source.organization_id = org_id
          AND source.extraction_run_id = run_row.id
      )
    ) THEN
      RAISE EXCEPTION
        'Step 1 idempotency key was reused with divergent dependency roles'
        USING ERRCODE = '23514';
    END IF;
    RETURN jsonb_build_object(
$new$;
BEGIN
  SELECT prosrc INTO function_body
  FROM pg_proc
  WHERE oid = 'public.publish_extraction_step1_shadow(jsonb)'::regprocedure;

  replaced_body := replace(function_body, old_source_insert, new_source_insert);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION
      'expected Step 1 candidate-source insertion was not found'
      USING ERRCODE = '23514';
  END IF;

  function_body := replaced_body;
  replaced_body := replace(function_body, old_reuse_return, new_reuse_return);
  IF replaced_body = function_body THEN
    RAISE EXCEPTION
      'expected Step 1 idempotent-return block was not found'
      USING ERRCODE = '23514';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)
       RETURNS jsonb
       LANGUAGE plpgsql
       SECURITY DEFINER
       SET search_path = ''''
       AS %L',
    replaced_body
  );
END;
$migration$;

REVOKE ALL ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  TO service_role;
