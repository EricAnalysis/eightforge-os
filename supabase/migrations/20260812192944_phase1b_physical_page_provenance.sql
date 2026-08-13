-- Phase 1B: persist artifact-bound physical-page provenance without changing readers.

DO $migration$
DECLARE existing_function oid;
BEGIN
  existing_function := pg_catalog.to_regprocedure(
    'public.is_valid_physical_page_coordinate(jsonb,uuid,uuid,integer)'
  );
  IF existing_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    JOIN pg_catalog.pg_language language_role ON language_role.oid = p.prolang
    WHERE p.oid = existing_function
      AND pg_catalog.md5(p.prosrc) = '9984e7a355b6d90539032781909a7f4d'
      AND owner_role.rolname = 'postgres'
      AND language_role.lanname = 'sql'
      AND p.prorettype = 'pg_catalog.bool'::pg_catalog.regtype
      AND NOT p.prosecdef
      AND p.provolatile = 'i'
      AND p.proparallel = 'u'
      AND NOT p.proisstrict
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'is_valid_physical_page_coordinate has an incompatible definition'
      USING ERRCODE = '23514';
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.is_valid_physical_page_coordinate(
  coordinate jsonb,
  expected_document_id uuid,
  expected_artifact_id uuid,
  expected_page integer
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coordinate IS NULL OR COALESCE((
    jsonb_typeof(coordinate) = 'object'
    AND coordinate ?& ARRAY[
      'mappingState', 'mappingBasis', 'sourceDocumentId', 'sourceArtifactId',
      'physicalPageNumber', 'totalPhysicalPages', 'sourceLayer',
      'artifactLocalIndex', 'legacyPageValue'
    ]
    AND coordinate->>'mappingState' IN (
      'resolved_physical_page',
      'unresolved_physical_page',
      'conflicting_physical_page_mapping',
      'legacy_unproven'
    )
    AND coordinate->>'sourceLayer' IN (
      'pdf_page_render', 'pdf_native_text', 'ocr', 'table_artifact', 'legacy'
    )
    AND (coordinate->'sourceDocumentId' = 'null'::jsonb
      OR (jsonb_typeof(coordinate->'sourceDocumentId') = 'string'
        AND coordinate->>'sourceDocumentId' = expected_document_id::text))
    AND (coordinate->'sourceArtifactId' = 'null'::jsonb
      OR (jsonb_typeof(coordinate->'sourceArtifactId') = 'string'
        AND coordinate->>'sourceArtifactId' = expected_artifact_id::text))
    AND (
      (coordinate->>'mappingState' = 'resolved_physical_page'
        AND coordinate->>'mappingBasis' IN (
          'extractor_iterated_physical_page',
          'persisted_explicit_mapping',
          'inherited_from_proven_parent'
        )
        AND coordinate->>'sourceLayer' <> 'legacy'
        AND coordinate->>'sourceDocumentId' = expected_document_id::text
        AND coordinate->>'sourceArtifactId' = expected_artifact_id::text
        AND jsonb_typeof(coordinate->'physicalPageNumber') = 'number'
        AND jsonb_typeof(coordinate->'totalPhysicalPages') = 'number'
        AND CASE
          WHEN coordinate->>'physicalPageNumber' ~ '^[1-9][0-9]*$'
            AND coordinate->>'totalPhysicalPages' ~ '^[1-9][0-9]*$'
          THEN (coordinate->>'physicalPageNumber')::numeric = expected_page
            AND (coordinate->>'physicalPageNumber')::numeric
              <= (coordinate->>'totalPhysicalPages')::numeric
            AND (coordinate->>'totalPhysicalPages')::numeric
              <= 9007199254740991::numeric
          ELSE false
        END
        AND coordinate->'legacyPageValue' = 'null'::jsonb)
      OR
      (coordinate->>'mappingState' <> 'resolved_physical_page'
        AND coordinate->>'mappingBasis' = 'unproven'
        AND coordinate->'physicalPageNumber' = 'null'::jsonb
        AND coordinate->'totalPhysicalPages' = 'null'::jsonb
        AND (
          (coordinate->>'mappingState' = 'legacy_unproven'
            AND coordinate->>'sourceLayer' = 'legacy'
            AND (coordinate->'legacyPageValue' = 'null'::jsonb
              OR (jsonb_typeof(coordinate->'legacyPageValue') = 'number'
                AND CASE
                  WHEN coordinate->>'legacyPageValue' ~ '^[1-9][0-9]*$'
                  THEN (coordinate->>'legacyPageValue')::numeric
                    <= 9007199254740991::numeric
                  ELSE false
                END)))
          OR
          (coordinate->>'mappingState' IN (
              'unresolved_physical_page', 'conflicting_physical_page_mapping'
            )
            AND coordinate->>'sourceLayer' <> 'legacy'
            AND coordinate->'legacyPageValue' = 'null'::jsonb)
        ))
    )
    AND (
      coordinate->'artifactLocalIndex' = 'null'::jsonb
      OR (jsonb_typeof(coordinate->'artifactLocalIndex') = 'number'
        AND CASE
          WHEN coordinate->>'artifactLocalIndex' ~ '^(0|[1-9][0-9]*)$'
          THEN (coordinate->>'artifactLocalIndex')::numeric
            <= 9007199254740991::numeric
          ELSE false
        END)
    )
  ), false);
$$;

ALTER FUNCTION public.is_valid_physical_page_coordinate(jsonb, uuid, uuid, integer)
  OWNER TO postgres;
REVOKE ALL ON FUNCTION public.is_valid_physical_page_coordinate(jsonb, uuid, uuid, integer)
  FROM PUBLIC, anon, authenticated, service_role;

ALTER TABLE public.extraction_page_artifacts
  ADD COLUMN IF NOT EXISTS physical_page_coordinate jsonb;

ALTER TABLE public.extraction_fragment_artifacts
  ADD COLUMN IF NOT EXISTS physical_page_coordinate jsonb;

DO $migration$
DECLARE
  target_table regclass;
  target_name text;
  column_type regtype;
  column_not_null boolean;
  existing_definition text;
  expected_definition constant text :=
    'CHECK (is_valid_physical_page_coordinate(physical_page_coordinate, source_document_id, source_artifact_id, page))';
BEGIN
  FOREACH target_name IN ARRAY ARRAY[
    'extraction_page_artifacts', 'extraction_fragment_artifacts'
  ] LOOP
    target_table := format('public.%I', target_name)::regclass;
    SELECT a.atttypid::regtype, a.attnotnull
      INTO column_type, column_not_null
    FROM pg_catalog.pg_attribute a
    WHERE a.attrelid = target_table
      AND a.attname = 'physical_page_coordinate'
      AND a.attnum > 0
      AND NOT a.attisdropped;
    IF column_type IS DISTINCT FROM 'jsonb'::regtype OR column_not_null THEN
      RAISE EXCEPTION '% has an incompatible physical_page_coordinate column', target_name
        USING ERRCODE = '23514';
    END IF;

    SELECT pg_catalog.replace(
      pg_catalog.pg_get_constraintdef(c.oid, true), 'public.', ''
    ) INTO existing_definition
    FROM pg_catalog.pg_constraint c
    WHERE c.conrelid = target_table
      AND c.conname = target_name || '_physical_page_coordinate_check';
    IF existing_definition IS NULL THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I CHECK ('
          || 'public.is_valid_physical_page_coordinate('
          || 'physical_page_coordinate, source_document_id, source_artifact_id, page'
          || ')) NOT VALID',
        target_name,
        target_name || '_physical_page_coordinate_check'
      );
    ELSIF existing_definition <> expected_definition THEN
      RAISE EXCEPTION '% has an incompatible physical-page constraint: %',
        target_name, existing_definition USING ERRCODE = '23514';
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      target_name,
      target_name || '_physical_page_coordinate_check'
    );
  END LOOP;
END;
$migration$;

DO $migration$
DECLARE existing_function oid;
BEGIN
  existing_function := pg_catalog.to_regprocedure(
    'public.enforce_v2_physical_page_coordinate()'
  );
  IF existing_function IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    JOIN pg_catalog.pg_language language_role ON language_role.oid = p.prolang
    WHERE p.oid = existing_function
      AND pg_catalog.md5(p.prosrc) = '6eb8a0a48d0df0c2e8b6dd178181259d'
      AND owner_role.rolname = 'postgres'
      AND language_role.lanname = 'plpgsql'
      AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
      AND p.prosecdef
      AND p.provolatile = 'v'
      AND p.proparallel = 'u'
      AND NOT p.proisstrict
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'enforce_v2_physical_page_coordinate has an incompatible definition'
      USING ERRCODE = '23514';
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.enforce_v2_physical_page_coordinate()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE schema_version text;
BEGIN
  SELECT artifact_schema_version INTO schema_version
  FROM public.extraction_runs
  WHERE organization_id = NEW.organization_id AND id = NEW.extraction_run_id;
  IF schema_version = 'extraction-artifact-v2'
     AND NEW.physical_page_coordinate IS NULL THEN
    RAISE EXCEPTION 'v2 extraction artifacts require physical-page provenance'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.enforce_v2_physical_page_coordinate() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.enforce_v2_physical_page_coordinate()
  FROM PUBLIC, anon, authenticated, service_role;

DO $migration$
DECLARE
  target_table regclass;
  target_name text;
  trigger_name text;
  existing_definition text;
  expected_definition text;
BEGIN
  FOREACH target_name IN ARRAY ARRAY[
    'extraction_page_artifacts', 'extraction_fragment_artifacts'
  ] LOOP
    target_table := format('public.%I', target_name)::regclass;
    trigger_name := CASE target_name
      WHEN 'extraction_page_artifacts' THEN 'enforce_v2_page_physical_page_coordinate'
      ELSE 'enforce_v2_fragment_physical_page_coordinate'
    END;
    expected_definition := format(
      'CREATE TRIGGER %s BEFORE INSERT OR UPDATE OF organization_id, extraction_run_id, source_artifact_id, source_document_id, page, physical_page_coordinate ON %s FOR EACH ROW EXECUTE FUNCTION enforce_v2_physical_page_coordinate()',
      trigger_name,
      target_name
    );
    SELECT pg_catalog.replace(
      pg_catalog.replace(pg_catalog.pg_get_triggerdef(t.oid, true), 'public.', ''),
      '"', ''
    ) INTO existing_definition
    FROM pg_catalog.pg_trigger t
    WHERE t.tgrelid = target_table
      AND t.tgname = trigger_name
      AND NOT t.tgisinternal;
    IF existing_definition IS NULL THEN
      EXECUTE format(
        'CREATE TRIGGER %I BEFORE INSERT OR UPDATE OF '
          || 'organization_id, extraction_run_id, source_artifact_id, '
          || 'source_document_id, page, physical_page_coordinate '
          || 'ON public.%I FOR EACH ROW '
          || 'EXECUTE FUNCTION public.enforce_v2_physical_page_coordinate()',
        trigger_name,
        target_name
      );
    ELSIF existing_definition <> expected_definition THEN
      RAISE EXCEPTION '% has an incompatible definition: %',
        trigger_name, existing_definition USING ERRCODE = '23514';
    END IF;
  END LOOP;
END;
$migration$;

DO $migration$
DECLARE existing_function oid;
BEGIN
  existing_function := pg_catalog.to_regprocedure(
    'public.publish_extraction_step1_shadow(jsonb)'
  );
  IF existing_function IS NULL OR NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_roles owner_role ON owner_role.oid = p.proowner
    JOIN pg_catalog.pg_language language_role ON language_role.oid = p.prolang
    WHERE p.oid = existing_function
      AND pg_catalog.md5(p.prosrc) IN (
        '04ae56b4b36b08703b697bedbe977481',
        '135d5bb3debe14bfa854796464d6d07d'
      )
      AND owner_role.rolname = 'postgres'
      AND language_role.lanname = 'plpgsql'
      AND p.prorettype = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND p.pronargs = 1
      AND p.proargtypes[0] = 'pg_catalog.jsonb'::pg_catalog.regtype
      AND p.prosecdef
      AND p.provolatile = 'v'
      AND p.proparallel = 'u'
      AND NOT p.proisstrict
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'publish_extraction_step1_shadow has an incompatible definition'
      USING ERRCODE = '23514';
  END IF;
END;
$migration$;

CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  org_id uuid := (payload->>'organization_id')::uuid;
  document_id uuid := (payload->>'source_document_id')::uuid;
  source_id uuid := (payload->>'source_artifact_id')::uuid;
  run_id uuid := (payload->>'run_id')::uuid;
  snapshot_id uuid := (payload->>'snapshot_id')::uuid;
  attempt_no integer;
  semantic_key_value text;
  item jsonb;
  source_row public.extraction_source_artifacts%ROWTYPE;
  run_row public.extraction_runs%ROWTYPE;
  snapshot_row public.extraction_snapshots%ROWTYPE;
  assignment_updated boolean := false;
  step3_content_hash text;
  interpretation_id uuid;
  mapping jsonb;
  step3_dependency jsonb;
BEGIN
  step3_content_hash := encode(sha256(convert_to(jsonb_build_object(
    'fragment_dependencies', COALESCE(payload->'fragment_dependencies', '[]'::jsonb),
    'structure_fragments', COALESCE((
      SELECT jsonb_agg(fragment ORDER BY fragment->>'id')
      FROM jsonb_array_elements(COALESCE(payload->'fragments', '[]'::jsonb))
        AS source(fragment)
      WHERE fragment->>'kind' IN ('cell', 'region')
    ), '[]'::jsonb),
    'structure_snapshot_members', COALESCE((
      SELECT jsonb_agg(member ORDER BY (member->>'sequence')::integer)
      FROM jsonb_array_elements(COALESCE(payload->'snapshot_members', '[]'::jsonb))
        AS source(member)
      WHERE member->>'member_kind' IN (
        'continuation_link', 'table_chain', 'table_section',
        'arbitration_decision'
      )
      OR (
        member->>'member_kind' = 'fragment'
        AND member->>'fragment_artifact_id' IN (
          SELECT fragment->>'id'
          FROM jsonb_array_elements(COALESCE(payload->'fragments', '[]'::jsonb))
            AS fragments(fragment)
          WHERE fragment->>'kind' IN ('cell', 'region')
        )
      )
    ), '[]'::jsonb),
    'continuation_links', COALESCE(payload->'continuation_links', '[]'::jsonb),
    'table_chains', COALESCE(payload->'table_chains', '[]'::jsonb),
    'table_sections', COALESCE(payload->'table_sections', '[]'::jsonb),
    'arbitration_decisions', COALESCE(payload->'arbitration_decisions', '[]'::jsonb),
    'interpretation_snapshot', COALESCE(payload->'interpretation_snapshot', 'null'::jsonb),
    'semantic_column_mappings', COALESCE(payload->'semantic_column_mappings', '[]'::jsonb),
    'interpretation_records', COALESCE(payload->'interpretation_records', '[]'::jsonb)
  )::text, 'UTF8')), 'hex');
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(payload->'parser_manifest', 'null'::jsonb)) <> 'object'
    OR jsonb_typeof(COALESCE(payload->'pages', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'fragments', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'candidates', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'verified_fields', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'gaps', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'snapshot_members', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'fragment_dependencies', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'continuation_links', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'table_chains', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'table_sections', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'arbitration_decisions', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'semantic_column_mappings', '[]'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'interpretation_records', '[]'::jsonb)) <> 'array'
    OR (
      payload->'interpretation_snapshot' IS NOT NULL
      AND jsonb_typeof(payload->'interpretation_snapshot') <> 'object'
    ) THEN
    RAISE EXCEPTION 'Step 1 publication payload collections are invalid'
      USING ERRCODE = '22023';
  END IF;
  IF (
    payload->>'run_status' = 'complete'
    AND (
      payload->>'snapshot_status' <> 'complete'
      OR jsonb_array_length(payload->'gaps') <> 0
    )
  ) OR (
    payload->>'run_status' IN ('partial_retryable', 'partial_terminal')
    AND (
      payload->>'snapshot_status' <> 'partial'
      OR jsonb_array_length(payload->'gaps') = 0
    )
  ) OR payload->>'run_status' NOT IN (
    'complete', 'partial_retryable', 'partial_terminal'
  ) THEN
    RAISE EXCEPTION 'Step 1 run, snapshot, and gap statuses are incoherent'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO source_row
  FROM public.extraction_source_artifacts
  WHERE organization_id = org_id AND id = source_id;
  IF source_row.id IS NULL
    OR source_row.source_document_id <> document_id
    OR source_row.source_sha256 <> payload->>'source_sha256'
    OR NOT EXISTS (
      SELECT 1 FROM public.documents d
      WHERE d.id = document_id AND d.organization_id = org_id
    ) THEN
    RAISE EXCEPTION 'Step 1 source does not close to one organization and document'
      USING ERRCODE = '23514';
  END IF;

  semantic_key_value :=
    document_id::text || ':' || source_id::text || ':'
      || (payload->>'parser_manifest_hash') || ':'
      || (payload->>'artifact_schema_version');

  -- Serialize both idempotency-key reuse and semantic snapshot publication.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    org_id::text || ':step1:idempotency:' || (payload->>'idempotency_key'), 0
  ));
  PERFORM pg_advisory_xact_lock(hashtextextended(
    org_id::text || ':step1:semantic:' || semantic_key_value, 0
  ));

  SELECT * INTO run_row
  FROM public.extraction_runs
  WHERE organization_id = org_id
    AND idempotency_key = payload->>'idempotency_key';
  IF run_row.id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_step3_publication_receipts receipt
      WHERE receipt.organization_id = org_id
        AND receipt.extraction_run_id = run_row.id
        AND receipt.content_hash = step3_content_hash
    ) THEN
      RAISE EXCEPTION 'Step 3 idempotency key was reused with divergent table content'
        USING ERRCODE = '23514';
    END IF;
    IF run_row.source_artifact_id <> source_id
      OR run_row.id <> run_id
      OR run_row.semantic_key <> semantic_key_value
      OR run_row.parser_manifest <> payload->'parser_manifest'
      OR run_row.parser_manifest_hash <> payload->>'parser_manifest_hash'
      OR run_row.artifact_schema_version <> payload->>'artifact_schema_version'
      OR run_row.initial_status <> payload->>'run_status' THEN
      RAISE EXCEPTION 'Step 1 idempotency key was reused with divergent input'
        USING ERRCODE = '23514';
    END IF;
    SELECT * INTO snapshot_row
    FROM public.extraction_snapshots
    WHERE organization_id = org_id AND producing_run_id = run_row.id;
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
      'source_artifact_id', source_id,
      'extraction_run_id', run_row.id,
      'extraction_snapshot_id', snapshot_row.id,
      'reused', true,
      'assignment_updated', false
    );
  END IF;

  SELECT * INTO snapshot_row
  FROM public.extraction_snapshots
  WHERE organization_id = org_id
    AND source_document_id = document_id
    AND source_artifact_id = source_id
    AND parser_manifest_hash = payload->>'parser_manifest_hash'
    AND artifact_schema_version = payload->>'artifact_schema_version';
  IF snapshot_row.id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.extraction_step3_publication_receipts receipt
      WHERE receipt.organization_id = org_id
        AND receipt.extraction_run_id = snapshot_row.producing_run_id
        AND receipt.content_hash = step3_content_hash
    ) THEN
      RAISE EXCEPTION 'deterministic Step 3 semantic snapshot diverged'
        USING ERRCODE = '23514';
    END IF;
    IF snapshot_row.id <> snapshot_id
      OR snapshot_row.status <> payload->>'snapshot_status'
      OR snapshot_row.content_extraction_fingerprint
        <> payload->>'content_extraction_fingerprint'
      OR snapshot_row.artifact_root_hash <> payload->>'artifact_root_hash' THEN
      RAISE EXCEPTION 'deterministic Step 1 semantic snapshot diverged'
        USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.document_extraction_snapshot_assignments (
      organization_id, source_document_id, source_artifact_id,
      desired_parser_manifest_hash, artifact_schema_version,
      extraction_snapshot_id, activation_mode, assigned_at
    ) VALUES (
      org_id, document_id, source_id, payload->>'parser_manifest_hash',
      payload->>'artifact_schema_version', snapshot_row.id, 'shadow',
      (payload->>'completed_at')::timestamptz
    )
    ON CONFLICT (organization_id, source_document_id) DO UPDATE SET
      source_artifact_id = EXCLUDED.source_artifact_id,
      desired_parser_manifest_hash = EXCLUDED.desired_parser_manifest_hash,
      artifact_schema_version = EXCLUDED.artifact_schema_version,
      extraction_snapshot_id = EXCLUDED.extraction_snapshot_id,
      activation_mode = 'shadow',
      assigned_at = EXCLUDED.assigned_at
    WHERE public.document_extraction_snapshot_assignments.assigned_at
      <= EXCLUDED.assigned_at;
    GET DIAGNOSTICS assignment_updated = ROW_COUNT;

    RETURN jsonb_build_object(
      'source_artifact_id', source_id,
      'extraction_run_id', snapshot_row.producing_run_id,
      'extraction_snapshot_id', snapshot_row.id,
      'reused', true,
      'assignment_updated', assignment_updated
    );
  END IF;

  SELECT COALESCE(max(attempt_number), 0) + 1 INTO attempt_no
  FROM public.extraction_runs
  WHERE organization_id = org_id AND semantic_key = semantic_key_value;

  INSERT INTO public.extraction_runs (
    id, organization_id, source_artifact_id, semantic_key, idempotency_key,
    attempt_number, parser_manifest, parser_manifest_hash,
    artifact_schema_version, initial_status, started_at, completed_at
  ) VALUES (
    run_id, org_id, source_id, semantic_key_value, payload->>'idempotency_key',
    attempt_no, payload->'parser_manifest', payload->>'parser_manifest_hash',
    payload->>'artifact_schema_version', payload->>'run_status',
    (payload->>'started_at')::timestamptz,
    (payload->>'completed_at')::timestamptz
  );

  INSERT INTO public.extraction_step3_publication_receipts (
    organization_id, extraction_run_id, content_hash
  ) VALUES (org_id, run_id, step3_content_hash);

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'pages')
  LOOP
    INSERT INTO public.extraction_page_artifacts (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, page,
      width, height, rotation_degrees, render_sha256, parser, status,
      physical_page_coordinate
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      (item->>'page')::integer, (item->>'width')::double precision,
      (item->>'height')::double precision,
      (item->>'rotation_degrees')::integer, item->>'render_sha256',
      item->'parser', item->>'status', item->'physical_page_coordinate'
    );
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'fragments')
  LOOP
    INSERT INTO public.extraction_fragment_artifacts (
      id, organization_id, extraction_run_id, source_artifact_id,
      page_artifact_id, source_document_id, source_sha256,
      parser_manifest_hash, kind, page, bbox_x0, bbox_y0, bbox_x1,
      bbox_y1, bbox_rotation, raw_text, parser, recognition_confidence,
      reading_order, artifact_data, physical_page_coordinate
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id,
      (item->>'page_artifact_id')::uuid, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      item->>'kind', (item->>'page')::integer,
      (item#>>'{bounding_box,x0}')::double precision,
      (item#>>'{bounding_box,y0}')::double precision,
      (item#>>'{bounding_box,x1}')::double precision,
      (item#>>'{bounding_box,y1}')::double precision,
      (item#>>'{bounding_box,rotation}')::integer,
      item->>'raw_text', item->'parser',
      (item->>'recognition_confidence')::double precision,
      (item->>'reading_order')::integer,
      COALESCE(item->'artifact_data', '{}'::jsonb),
      item->'physical_page_coordinate'
    );
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'candidates')
  LOOP
    INSERT INTO public.extraction_field_candidates (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, raw_text,
      primitive_kind, proposed_value, transformations, parser, confidence, status
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      item->>'raw_text', item->>'primitive_kind', item->'proposed_value',
      COALESCE(item->'transformations', '[]'::jsonb), item->'parser',
      item->'confidence', item->>'status'
    );
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
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'verified_fields')
  LOOP
    INSERT INTO public.extraction_verified_fields (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, candidate_id,
      raw_text, normalized_value, transformations, verifier, confidence
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      (item->>'candidate_id')::uuid, item->>'raw_text',
      item->'normalized_value', COALESCE(item->'transformations', '[]'::jsonb),
      item->'verifier', item->'confidence'
    );
    INSERT INTO public.extraction_verified_field_sources (
      organization_id, extraction_run_id, verified_field_id,
      fragment_artifact_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'source_fragment_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'fragment_dependencies')
  LOOP
    INSERT INTO public.extraction_fragment_dependencies (
      organization_id, extraction_run_id, fragment_artifact_id,
      dependency_fragment_artifact_id, sequence
    )
    SELECT org_id, run_id, (item->>'fragment_artifact_id')::uuid,
      value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'dependency_fragment_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'continuation_links')
  LOOP
    INSERT INTO public.extraction_table_continuation_links (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser,
      from_segment_id, to_segment_id, basis, score, decision
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash', item->'parser',
      (item->>'from_segment_id')::uuid, (item->>'to_segment_id')::uuid,
      item->'basis', item->'score', item->>'decision'
    );
    FOR step3_dependency IN SELECT value FROM jsonb_array_elements(item->'basis_fragments')
    LOOP
      INSERT INTO public.extraction_table_continuation_link_basis_fragments (
        organization_id, extraction_run_id, continuation_link_id, basis_kind,
        fragment_artifact_id, sequence
      ) VALUES (
        org_id, run_id, (item->>'id')::uuid, step3_dependency->>'basis_kind',
        (step3_dependency->>'fragment_artifact_id')::uuid,
        (step3_dependency->>'sequence')::integer
      );
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'table_chains')
  LOOP
    INSERT INTO public.extraction_table_chains (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser, completeness
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      item->'parser', item->>'completeness'
    );
    INSERT INTO public.extraction_table_chain_segments (
      organization_id, extraction_run_id, table_chain_id, segment_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'segment_ids')
      WITH ORDINALITY AS source(value, ordinality);
    INSERT INTO public.extraction_table_chain_links (
      organization_id, extraction_run_id, table_chain_id, continuation_link_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'continuation_link_ids')
      WITH ORDINALITY AS source(value, ordinality);
    INSERT INTO public.extraction_table_chain_gaps (
      organization_id, extraction_run_id, table_chain_id, processing_gap_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'gap_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'table_sections')
  LOOP
    INSERT INTO public.extraction_table_sections (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser,
      table_chain_id, header_row_id, sequence
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash', item->'parser',
      (item->>'table_chain_id')::uuid, (item->>'header_row_id')::uuid,
      (item->>'sequence')::integer
    );
    INSERT INTO public.extraction_table_section_rows (
      organization_id, extraction_run_id, table_section_id, row_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'member_row_ids')
      WITH ORDINALITY AS source(value, ordinality);
    INSERT INTO public.extraction_table_section_child_chains (
      organization_id, extraction_run_id, table_section_id, child_table_chain_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'child_table_chain_ids')
      WITH ORDINALITY AS source(value, ordinality);
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'arbitration_decisions')
  LOOP
    INSERT INTO public.extraction_arbitration_decisions (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, parser,
      page_artifact_id, physical_region_id, processing_gap_id,
      agreement, decision, diagnostics
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash', item->'parser',
      (item->>'page_artifact_id')::uuid, (item->>'physical_region_id')::uuid,
      (item->>'processing_gap_id')::uuid,
      NULLIF(item->'agreement', 'null'::jsonb),
      item->>'decision', item->'diagnostics'
    );
    FOR step3_dependency IN SELECT value FROM jsonb_array_elements(item->'candidates')
    LOOP
      INSERT INTO public.extraction_arbitration_decision_candidates (
        organization_id, extraction_run_id, arbitration_decision_id,
        candidate_fragment_id, disposition, sequence
      ) VALUES (
        org_id, run_id, (item->>'id')::uuid,
        (step3_dependency->>'candidate_fragment_id')::uuid,
        step3_dependency->>'disposition', (step3_dependency->>'sequence')::integer
      );
    END LOOP;
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'gaps')
  LOOP
    INSERT INTO public.extraction_processing_gaps (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, gap_key, page, bbox_x0, bbox_y0, bbox_x1,
      bbox_y1, bbox_rotation, stage, reason, retryable, attempts, detail
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      COALESCE(item->>'gap_key', item->>'id'), (item->>'page')::integer,
      (item#>>'{bounding_box,x0}')::double precision,
      (item#>>'{bounding_box,y0}')::double precision,
      (item#>>'{bounding_box,x1}')::double precision,
      (item#>>'{bounding_box,y1}')::double precision,
      (item#>>'{bounding_box,rotation}')::integer,
      item->>'stage', item->>'reason', (item->>'retryable')::boolean,
      (item->>'attempts')::integer, COALESCE(item->>'detail', item->>'reason')
    );
    INSERT INTO public.extraction_gap_sources (
      organization_id, extraction_run_id, processing_gap_id,
      fragment_artifact_id
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid
    FROM jsonb_array_elements_text(COALESCE(
      item->'upstream_artifact_ids', '[]'::jsonb
    ))
      AS source(value);
  END LOOP;

  INSERT INTO public.extraction_run_states (
    organization_id, extraction_run_id, state, reason, recorded_at
  ) VALUES (
    org_id, run_id, payload->>'run_status', payload->>'run_state_reason',
    (payload->>'completed_at')::timestamptz
  );

  INSERT INTO public.extraction_snapshots (
    id, organization_id, source_document_id, source_artifact_id, source_sha256,
    parser_manifest_hash, artifact_schema_version, producing_run_id, status,
    content_extraction_fingerprint, artifact_root_hash
  ) VALUES (
    snapshot_id, org_id, document_id, source_id, payload->>'source_sha256',
    payload->>'parser_manifest_hash', payload->>'artifact_schema_version',
    run_id, payload->>'snapshot_status',
    payload->>'content_extraction_fingerprint', payload->>'artifact_root_hash'
  );

  FOR item IN
    SELECT value
    FROM jsonb_array_elements(payload->'snapshot_members')
    ORDER BY (value->>'sequence')::integer
  LOOP
    INSERT INTO public.extraction_snapshot_members (
      organization_id, extraction_snapshot_id, member_kind,
      page_artifact_id, fragment_artifact_id, field_candidate_id,
      verified_field_id, processing_gap_id, continuation_link_id,
      table_chain_id, table_section_id, arbitration_decision_id,
      dependency_hash, sequence
    ) VALUES (
      org_id, snapshot_id, item->>'member_kind',
      (item->>'page_artifact_id')::uuid,
      (item->>'fragment_artifact_id')::uuid,
      (item->>'field_candidate_id')::uuid,
      (item->>'verified_field_id')::uuid,
      (item->>'processing_gap_id')::uuid,
      (item->>'continuation_link_id')::uuid,
      (item->>'table_chain_id')::uuid,
      (item->>'table_section_id')::uuid,
      (item->>'arbitration_decision_id')::uuid,
      item->>'dependency_hash', (item->>'sequence')::integer
    );
  END LOOP;

  -- The immutable snapshot must close over exactly the artifacts published by
  -- this run. No verified field (or any other child) may exist outside its root,
  -- and no member may point at an artifact omitted from this publication.
  IF (
    SELECT count(*)
    FROM public.extraction_snapshot_members member
    WHERE member.organization_id = org_id
      AND member.extraction_snapshot_id = snapshot_id
  ) <> (
    (SELECT count(*) FROM public.extraction_page_artifacts
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_fragment_artifacts
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_field_candidates
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_verified_fields
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_table_continuation_links
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_table_chains
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_table_sections
      WHERE organization_id = org_id AND extraction_run_id = run_id)
    + (SELECT count(*) FROM public.extraction_arbitration_decisions
      WHERE organization_id = org_id AND extraction_run_id = run_id)
  ) OR EXISTS (
    (
      SELECT 'page'::text AS kind, id AS artifact_id
      FROM public.extraction_page_artifacts
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'fragment', id FROM public.extraction_fragment_artifacts
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'candidate', id FROM public.extraction_field_candidates
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'verified_field', id FROM public.extraction_verified_fields
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'gap', id FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'continuation_link', id FROM public.extraction_table_continuation_links
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'table_chain', id FROM public.extraction_table_chains
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'table_section', id FROM public.extraction_table_sections
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'arbitration_decision', id FROM public.extraction_arbitration_decisions
      WHERE organization_id = org_id AND extraction_run_id = run_id
    )
    EXCEPT
    SELECT member.member_kind, COALESCE(
      member.page_artifact_id, member.fragment_artifact_id,
      member.field_candidate_id, member.verified_field_id,
      member.processing_gap_id, member.continuation_link_id, member.table_chain_id,
      member.table_section_id, member.arbitration_decision_id
    )
    FROM public.extraction_snapshot_members member
    WHERE member.organization_id = org_id
      AND member.extraction_snapshot_id = snapshot_id
  ) OR EXISTS (
    (
      SELECT member.member_kind AS kind, COALESCE(
        member.page_artifact_id, member.fragment_artifact_id,
        member.field_candidate_id, member.verified_field_id,
        member.processing_gap_id, member.continuation_link_id, member.table_chain_id,
        member.table_section_id, member.arbitration_decision_id
      ) AS artifact_id
      FROM public.extraction_snapshot_members member
      WHERE member.organization_id = org_id
        AND member.extraction_snapshot_id = snapshot_id
    )
    EXCEPT
    (
      SELECT 'page'::text, id FROM public.extraction_page_artifacts
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'fragment', id FROM public.extraction_fragment_artifacts
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'candidate', id FROM public.extraction_field_candidates
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'verified_field', id FROM public.extraction_verified_fields
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'gap', id FROM public.extraction_processing_gaps
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'continuation_link', id FROM public.extraction_table_continuation_links
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'table_chain', id FROM public.extraction_table_chains
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'table_section', id FROM public.extraction_table_sections
      WHERE organization_id = org_id AND extraction_run_id = run_id
      UNION ALL
      SELECT 'arbitration_decision', id FROM public.extraction_arbitration_decisions
      WHERE organization_id = org_id AND extraction_run_id = run_id
    )
  ) THEN
    RAISE EXCEPTION 'Step 1 snapshot members do not exactly close the published artifact graph'
      USING ERRCODE = '23514';
  END IF;

  IF payload->'interpretation_snapshot' IS NOT NULL THEN
    interpretation_id := (payload#>>'{interpretation_snapshot,id}')::uuid;
    INSERT INTO public.document_interpretation_snapshots (
      id, organization_id, source_document_id, extraction_snapshot_id,
      interpreter_manifest_hash, entity_resolver_version, effective_truth_set_hash,
      status, output_root_hash, published_at
    ) VALUES (
      interpretation_id, org_id, document_id, snapshot_id,
      payload#>>'{interpretation_snapshot,interpreter_manifest_hash}',
      payload#>>'{interpretation_snapshot,entity_resolver_version}',
      payload#>>'{interpretation_snapshot,effective_truth_set_hash}',
      payload#>>'{interpretation_snapshot,status}',
      payload#>>'{interpretation_snapshot,output_root_hash}',
      (payload#>>'{interpretation_snapshot,published_at}')::timestamptz
    );
    FOR mapping IN SELECT value FROM jsonb_array_elements(payload->'semantic_column_mappings')
    LOOP
      INSERT INTO public.semantic_column_mappings (
        id, organization_id, interpretation_snapshot_id, table_chain_id,
        column_index, domain_role, assessment, status,
        interpretation_rule_id, interpretation_rule_version
      ) VALUES (
        (mapping->>'id')::uuid, org_id, interpretation_id,
        (mapping->>'table_chain_id')::uuid, (mapping->>'column_index')::integer,
        mapping->>'domain_role', mapping->'assessment', mapping->>'status',
        mapping->>'interpretation_rule_id', mapping->>'interpretation_rule_version'
      );
      INSERT INTO public.semantic_column_mapping_fields (
        organization_id, interpretation_snapshot_id, semantic_column_mapping_id,
        verified_field_id, field_role, sequence
      )
      SELECT org_id, interpretation_id, (mapping->>'id')::uuid,
        value::text::uuid, 'header', ordinality
      FROM jsonb_array_elements_text(mapping->'header_verified_field_ids')
        WITH ORDINALITY AS source(value, ordinality);
      INSERT INTO public.semantic_column_mapping_fields (
        organization_id, interpretation_snapshot_id, semantic_column_mapping_id,
        verified_field_id, field_role, sequence
      )
      SELECT org_id, interpretation_id, (mapping->>'id')::uuid,
        value::text::uuid, 'cell', ordinality
      FROM jsonb_array_elements_text(mapping->'cell_verified_field_ids')
        WITH ORDINALITY AS source(value, ordinality);
    END LOOP;
    FOR item IN SELECT value FROM jsonb_array_elements(payload->'interpretation_records')
    LOOP
      INSERT INTO public.document_interpretation_records (
        id, organization_id, interpretation_snapshot_id, record_type,
        canonical_fact_id, derived_fact_id, human_assertion_id, processing_gap_id,
        semantic_column_mapping_id, record_data, sequence
      ) VALUES (
        (item->>'id')::uuid, org_id, interpretation_id, item->>'record_type',
        (item->>'canonical_fact_id')::uuid, (item->>'derived_fact_id')::uuid,
        (item->>'human_assertion_id')::uuid, (item->>'processing_gap_id')::uuid,
        (item->>'semantic_column_mapping_id')::uuid,
        COALESCE(item->'record_data', '{}'::jsonb), (item->>'sequence')::integer
      );
    END LOOP;
    IF EXISTS (
      (SELECT id FROM public.semantic_column_mappings
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id
       EXCEPT
       SELECT semantic_column_mapping_id FROM public.document_interpretation_records
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id
         AND record_type = 'semantic_column_mapping')
      UNION ALL
      (SELECT semantic_column_mapping_id FROM public.document_interpretation_records
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id
         AND record_type = 'semantic_column_mapping'
       EXCEPT
       SELECT id FROM public.semantic_column_mappings
       WHERE organization_id = org_id AND interpretation_snapshot_id = interpretation_id)
    ) THEN
      RAISE EXCEPTION 'Step 3 interpretation records do not exactly close mappings'
        USING ERRCODE = '23514';
    END IF;
  ELSIF jsonb_array_length(payload->'semantic_column_mappings') <> 0
    OR jsonb_array_length(payload->'interpretation_records') <> 0 THEN
    RAISE EXCEPTION 'Step 3 mappings require an interpretation snapshot'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.document_extraction_snapshot_assignments (
    organization_id, source_document_id, source_artifact_id,
    desired_parser_manifest_hash, artifact_schema_version,
    extraction_snapshot_id, activation_mode, assigned_at
  ) VALUES (
    org_id, document_id, source_id, payload->>'parser_manifest_hash',
    payload->>'artifact_schema_version', snapshot_id, 'shadow',
    (payload->>'completed_at')::timestamptz
  )
  ON CONFLICT (organization_id, source_document_id) DO UPDATE SET
    source_artifact_id = EXCLUDED.source_artifact_id,
    desired_parser_manifest_hash = EXCLUDED.desired_parser_manifest_hash,
    artifact_schema_version = EXCLUDED.artifact_schema_version,
    extraction_snapshot_id = EXCLUDED.extraction_snapshot_id,
    activation_mode = 'shadow',
    assigned_at = EXCLUDED.assigned_at
  WHERE public.document_extraction_snapshot_assignments.assigned_at
    <= EXCLUDED.assigned_at;
  GET DIAGNOSTICS assignment_updated = ROW_COUNT;

  RETURN jsonb_build_object(
    'source_artifact_id', source_id,
    'extraction_run_id', run_id,
    'extraction_snapshot_id', snapshot_id,
    'reused', false,
    'assignment_updated', assignment_updated
  );
END;
$function$;

ALTER FUNCTION public.publish_extraction_step1_shadow(jsonb) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  TO service_role;
