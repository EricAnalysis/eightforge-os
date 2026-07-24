-- Phase 3 Step 1 persistence boundary.
-- This remains shadow-only: it publishes source-grounded extraction artifacts
-- and updates only the shadow assignment pointer. No projection, canonical
-- fact, interpretation, Validator, or live-reader state is written here.
-- The publication payload carries top-level run_id/snapshot_id and provenance
-- identity plus pages, fragments, candidates, verified_fields, gaps, and
-- natural snapshot_members (member_kind + its target ID). Repeated child
-- provenance is assigned from the trusted top-level closure, not caller fields.

ALTER TABLE public.extraction_processing_gaps
  DROP CONSTRAINT extraction_processing_gaps_reason_check;
ALTER TABLE public.extraction_processing_gaps
  ADD CONSTRAINT extraction_processing_gaps_reason_check CHECK (
    reason IN (
      'timeout', 'engine_failure', 'unsupported_size', 'unprocessed_region',
      'engine_conflict', 'missing_geometry', 'no_source_span', 'ambiguous_parse'
    )
  );

CREATE OR REPLACE FUNCTION public.enforce_shadow_assignment_monotonic()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.activation_mode <> 'shadow' AND NEW.activation_mode = 'shadow' THEN
    RETURN NULL;
  END IF;
  IF OLD.activation_mode = 'shadow' AND NEW.activation_mode = 'shadow' THEN
    IF NEW.assigned_at < OLD.assigned_at THEN
      RETURN NULL;
    END IF;
    IF NEW.assigned_at = OLD.assigned_at
      AND ROW(
        NEW.source_artifact_id::text,
        NEW.desired_parser_manifest_hash,
        NEW.extraction_snapshot_id::text
      ) <= ROW(
        OLD.source_artifact_id::text,
        OLD.desired_parser_manifest_hash,
        OLD.extraction_snapshot_id::text
      ) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_shadow_assignment_monotonic() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_shadow_assignment_monotonic
  ON public.document_extraction_snapshot_assignments;
CREATE TRIGGER trg_shadow_assignment_monotonic
  BEFORE UPDATE ON public.document_extraction_snapshot_assignments
  FOR EACH ROW EXECUTE FUNCTION public.enforce_shadow_assignment_monotonic();

CREATE OR REPLACE FUNCTION public.resolve_extraction_step1_source(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  org_id uuid := (payload->>'organization_id')::uuid;
  document_id uuid := (payload->>'source_document_id')::uuid;
  source_id uuid;
  source_row public.extraction_source_artifacts%ROWTYPE;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.documents d
    WHERE d.id = document_id AND d.organization_id = org_id
  ) THEN
    RAISE EXCEPTION 'source document must belong to the payload organization'
      USING ERRCODE = '23514';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended(
    org_id::text || ':' || document_id::text || ':'
      || (payload->>'source_sha256') || ':' || (payload->>'storage_object_version'),
    0
  ));

  INSERT INTO public.extraction_source_artifacts (
    organization_id, source_document_id, source_sha256, storage_object_version,
    media_type_sniffed, byte_length
  ) VALUES (
    org_id, document_id, payload->>'source_sha256',
    payload->>'storage_object_version', payload->>'media_type_sniffed',
    (payload->>'byte_length')::bigint
  )
  ON CONFLICT (
    organization_id, source_document_id, source_sha256, storage_object_version
  ) DO NOTHING;

  SELECT * INTO source_row
  FROM public.extraction_source_artifacts
  WHERE organization_id = org_id
    AND source_document_id = document_id
    AND source_sha256 = payload->>'source_sha256'
    AND storage_object_version = payload->>'storage_object_version';

  IF source_row.id IS NULL THEN
    RAISE EXCEPTION 'source artifact resolution failed' USING ERRCODE = '23514';
  END IF;
  IF source_row.media_type_sniffed IS DISTINCT FROM payload->>'media_type_sniffed'
    OR source_row.byte_length IS DISTINCT FROM (payload->>'byte_length')::bigint THEN
    RAISE EXCEPTION 'source artifact identity was reused with divergent metadata'
      USING ERRCODE = '23514';
  END IF;

  source_id := source_row.id;
  RETURN jsonb_build_object(
    'source_artifact_id', source_id,
    'organization_id', org_id,
    'source_document_id', document_id,
    'source_sha256', source_row.source_sha256,
    'storage_object_version', source_row.storage_object_version,
    'media_type_sniffed', source_row.media_type_sniffed,
    'byte_length', source_row.byte_length,
    'created_at', source_row.created_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_extraction_step1_source(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_extraction_step1_source(jsonb)
  TO service_role;

CREATE OR REPLACE FUNCTION public.publish_extraction_step1_shadow(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
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
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION 'service_role required' USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(COALESCE(payload->'parser_manifest', 'null'::jsonb)) <> 'object'
    OR jsonb_typeof(COALESCE(payload->'pages', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'fragments', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'candidates', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'verified_fields', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'gaps', 'null'::jsonb)) <> 'array'
    OR jsonb_typeof(COALESCE(payload->'snapshot_members', 'null'::jsonb)) <> 'array' THEN
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

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'pages')
  LOOP
    INSERT INTO public.extraction_page_artifacts (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, page,
      width, height, rotation_degrees, render_sha256, parser, status
    ) VALUES (
      (item->>'id')::uuid, org_id, run_id, source_id, document_id,
      payload->>'source_sha256', payload->>'parser_manifest_hash',
      (item->>'page')::integer, (item->>'width')::double precision,
      (item->>'height')::double precision,
      (item->>'rotation_degrees')::integer, item->>'render_sha256',
      item->'parser', item->>'status'
    );
  END LOOP;

  FOR item IN SELECT value FROM jsonb_array_elements(payload->'fragments')
  LOOP
    INSERT INTO public.extraction_fragment_artifacts (
      id, organization_id, extraction_run_id, source_artifact_id,
      page_artifact_id, source_document_id, source_sha256,
      parser_manifest_hash, kind, page, bbox_x0, bbox_y0, bbox_x1,
      bbox_y1, bbox_rotation, raw_text, parser, recognition_confidence,
      reading_order, artifact_data
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
      COALESCE(item->'artifact_data', '{}'::jsonb)
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
    INSERT INTO public.extraction_field_candidate_sources (
      organization_id, extraction_run_id, field_candidate_id,
      fragment_artifact_id, sequence
    )
    SELECT org_id, run_id, (item->>'id')::uuid, value::text::uuid, ordinality
    FROM jsonb_array_elements_text(item->'source_fragment_ids')
      WITH ORDINALITY AS source(value, ordinality);
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
      verified_field_id, processing_gap_id, dependency_hash, sequence
    ) VALUES (
      org_id, snapshot_id, item->>'member_kind',
      (item->>'page_artifact_id')::uuid,
      (item->>'fragment_artifact_id')::uuid,
      (item->>'field_candidate_id')::uuid,
      (item->>'verified_field_id')::uuid,
      (item->>'processing_gap_id')::uuid,
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
    )
    EXCEPT
    SELECT member.member_kind, COALESCE(
      member.page_artifact_id, member.fragment_artifact_id,
      member.field_candidate_id, member.verified_field_id,
      member.processing_gap_id
    )
    FROM public.extraction_snapshot_members member
    WHERE member.organization_id = org_id
      AND member.extraction_snapshot_id = snapshot_id
  ) OR EXISTS (
    (
      SELECT member.member_kind AS kind, COALESCE(
        member.page_artifact_id, member.fragment_artifact_id,
        member.field_candidate_id, member.verified_field_id,
        member.processing_gap_id
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
    )
  ) THEN
    RAISE EXCEPTION 'Step 1 snapshot members do not exactly close the published artifact graph'
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
$$;

REVOKE ALL ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.publish_extraction_step1_shadow(jsonb)
  TO service_role;
