\set ON_ERROR_STOP on

-- Generic, disposable Phase 1B fixtures. No production identity is used.
INSERT INTO public.organizations (id, name)
VALUES ('91000000-0000-0000-0000-000000000001', 'Phase 1B regression organization');
INSERT INTO public.projects (id, organization_id, name, code)
VALUES (
  '91000000-0000-0000-0000-000000000002',
  '91000000-0000-0000-0000-000000000001',
  'Phase 1B regression project', 'PHASE1B-DB'
);
INSERT INTO public.documents (id, organization_id, project_id, name, storage_path)
VALUES
  (
    '91000000-0000-0000-0000-000000000010',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    'generic-a.pdf', 'phase1b/generic-a.pdf'
  ),
  (
    '91000000-0000-0000-0000-000000000011',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000002',
    'generic-b.pdf', 'phase1b/generic-b.pdf'
  );

INSERT INTO public.extraction_source_artifacts (
  id, organization_id, source_document_id, source_sha256,
  storage_object_version, media_type_sniffed, byte_length
) VALUES
  (
    '91000000-0000-0000-0000-000000000020',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000010', repeat('1', 64),
    'phase1b-a:1', 'application/pdf', 100
  ),
  (
    '91000000-0000-0000-0000-000000000021',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000011', repeat('2', 64),
    'phase1b-b:1', 'application/pdf', 100
  ),
  (
    '91000000-0000-0000-0000-000000000022',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000010', repeat('3', 64),
    'phase1b-rpc:1', 'application/pdf', 100
  );

INSERT INTO public.extraction_runs (
  id, organization_id, source_artifact_id, semantic_key, idempotency_key,
  attempt_number, parser_manifest, parser_manifest_hash,
  artifact_schema_version, initial_status, started_at, completed_at
) VALUES
  (
    '91000000-0000-0000-0000-000000000030',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000020', 'phase1b:v2:a', 'phase1b:v2:a', 1,
    '{"artifact_schema_version":"extraction-artifact-v1"}', repeat('4', 64),
    'extraction-artifact-v2', 'complete', now(), now()
  ),
  (
    '91000000-0000-0000-0000-000000000031',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000021', 'phase1b:v2:b', 'phase1b:v2:b', 1,
    '{"artifact_schema_version":"extraction-artifact-v1"}', repeat('5', 64),
    'extraction-artifact-v2', 'complete', now(), now()
  ),
  (
    '91000000-0000-0000-0000-000000000032',
    '91000000-0000-0000-0000-000000000001',
    '91000000-0000-0000-0000-000000000020', 'phase1b:v1:a', 'phase1b:v1:a', 1,
    '{"artifact_schema_version":"extraction-artifact-v1"}', repeat('6', 64),
    'extraction-artifact-v1', 'complete', now(), now()
  );

CREATE FUNCTION pg_temp.phase1b_coordinate(
  document_id uuid,
  artifact_id uuid,
  physical_page integer DEFAULT 1,
  total_pages integer DEFAULT 2
) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'mappingState', 'resolved_physical_page',
    'mappingBasis', 'extractor_iterated_physical_page',
    'sourceDocumentId', document_id::text,
    'sourceArtifactId', artifact_id::text,
    'physicalPageNumber', physical_page,
    'totalPhysicalPages', total_pages,
    'sourceLayer', 'pdf_page_render',
    'artifactLocalIndex', physical_page - 1,
    'legacyPageValue', null
  )
$$;

INSERT INTO public.extraction_page_artifacts (
  id, organization_id, extraction_run_id, source_artifact_id,
  source_document_id, source_sha256, parser_manifest_hash, page,
  width, height, rotation_degrees, render_sha256, parser, status,
  physical_page_coordinate
) VALUES (
  '91000000-0000-0000-0000-000000000040',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000030',
  '91000000-0000-0000-0000-000000000020',
  '91000000-0000-0000-0000-000000000010', repeat('1', 64), repeat('4', 64),
  1, 612, 792, 0, repeat('7', 64), '{"stage":"page_render"}', 'processed',
  pg_temp.phase1b_coordinate(
    '91000000-0000-0000-0000-000000000010',
    '91000000-0000-0000-0000-000000000020'
  )
);
INSERT INTO public.extraction_fragment_artifacts (
  id, organization_id, extraction_run_id, source_artifact_id,
  page_artifact_id, source_document_id, source_sha256, parser_manifest_hash,
  kind, page, bbox_x0, bbox_y0, bbox_x1, bbox_y1, bbox_rotation,
  raw_text, parser, recognition_confidence, reading_order, artifact_data,
  physical_page_coordinate
) VALUES (
  '91000000-0000-0000-0000-000000000041',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000030',
  '91000000-0000-0000-0000-000000000020',
  '91000000-0000-0000-0000-000000000040',
  '91000000-0000-0000-0000-000000000010', repeat('1', 64), repeat('4', 64),
  'token', 1, 0.1, 0.1, 0.2, 0.2, 0, 'generic token',
  '{"stage":"native_text"}', 0.99, 1, '{}',
  pg_temp.phase1b_coordinate(
    '91000000-0000-0000-0000-000000000010',
    '91000000-0000-0000-0000-000000000020'
  )
);

-- Historical v1/null compatibility remains explicit and does not promote a bare page.
INSERT INTO public.extraction_page_artifacts (
  id, organization_id, extraction_run_id, source_artifact_id,
  source_document_id, source_sha256, parser_manifest_hash, page,
  width, height, rotation_degrees, render_sha256, parser, status,
  physical_page_coordinate
) VALUES (
  '91000000-0000-0000-0000-000000000042',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000032',
  '91000000-0000-0000-0000-000000000020',
  '91000000-0000-0000-0000-000000000010', repeat('1', 64), repeat('6', 64),
  1, 612, 792, 0, repeat('8', 64), '{"stage":"legacy"}', 'processed', null
);
INSERT INTO public.extraction_fragment_artifacts (
  id, organization_id, extraction_run_id, source_artifact_id,
  page_artifact_id, source_document_id, source_sha256, parser_manifest_hash,
  kind, page, bbox_x0, bbox_y0, bbox_x1, bbox_y1, bbox_rotation,
  raw_text, parser, reading_order, artifact_data, physical_page_coordinate
) VALUES (
  '91000000-0000-0000-0000-000000000043',
  '91000000-0000-0000-0000-000000000001',
  '91000000-0000-0000-0000-000000000032',
  '91000000-0000-0000-0000-000000000020',
  '91000000-0000-0000-0000-000000000042',
  '91000000-0000-0000-0000-000000000010', repeat('1', 64), repeat('6', 64),
  'token', 1, 0.1, 0.1, 0.2, 0.2, 0, 'historical token',
  '{"stage":"legacy"}', 1, '{}', null
);

CREATE PROCEDURE pg_temp.expect_page_rejected(
  label text,
  coordinate jsonb,
  row_document uuid DEFAULT '91000000-0000-0000-0000-000000000010',
  row_artifact uuid DEFAULT '91000000-0000-0000-0000-000000000020',
  row_run uuid DEFAULT '91000000-0000-0000-0000-000000000030',
  row_page integer DEFAULT 1
) LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO public.extraction_page_artifacts (
      id, organization_id, extraction_run_id, source_artifact_id,
      source_document_id, source_sha256, parser_manifest_hash, page,
      width, height, rotation_degrees, render_sha256, parser, status,
      physical_page_coordinate
    ) VALUES (
      gen_random_uuid(), '91000000-0000-0000-0000-000000000001', row_run,
      row_artifact, row_document, repeat('1', 64), repeat('4', 64), row_page,
      612, 792, 0, repeat('9', 64), '{"stage":"negative"}', 'processed', coordinate
    );
    RAISE EXCEPTION '% unexpectedly succeeded', label;
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END;
$$;

CREATE PROCEDURE pg_temp.expect_fragment_null_rejected() LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    INSERT INTO public.extraction_fragment_artifacts (
      id, organization_id, extraction_run_id, source_artifact_id,
      page_artifact_id, source_document_id, source_sha256, parser_manifest_hash,
      kind, page, bbox_x0, bbox_y0, bbox_x1, bbox_y1, bbox_rotation,
      raw_text, parser, reading_order, artifact_data, physical_page_coordinate
    ) VALUES (
      gen_random_uuid(), '91000000-0000-0000-0000-000000000001',
      '91000000-0000-0000-0000-000000000030',
      '91000000-0000-0000-0000-000000000020',
      '91000000-0000-0000-0000-000000000040',
      '91000000-0000-0000-0000-000000000010', repeat('1', 64), repeat('4', 64),
      'token', 1, 0.2, 0.2, 0.3, 0.3, 0, 'missing provenance',
      '{"stage":"negative"}', 2, '{}', null
    );
    RAISE EXCEPTION 'v2 fragment with null provenance unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END;
$$;

DO $$
DECLARE
  valid jsonb := pg_temp.phase1b_coordinate(
    '91000000-0000-0000-0000-000000000010',
    '91000000-0000-0000-0000-000000000020'
  );
BEGIN
  CALL pg_temp.expect_page_rejected('missing coordinate', null);
  CALL pg_temp.expect_fragment_null_rejected();
  CALL pg_temp.expect_page_rejected('missing required key', valid - 'mappingBasis');
  CALL pg_temp.expect_page_rejected('wrong JSON type', '[]'::jsonb);
  CALL pg_temp.expect_page_rejected('null mapping state',
    jsonb_set(valid, '{mappingState}', 'null'));
  CALL pg_temp.expect_page_rejected('null mapping basis',
    jsonb_set(valid, '{mappingBasis}', 'null'));
  CALL pg_temp.expect_page_rejected('null source document',
    jsonb_set(valid, '{sourceDocumentId}', 'null'));
  CALL pg_temp.expect_page_rejected('null physical page',
    jsonb_set(valid, '{physicalPageNumber}', 'null'));
  CALL pg_temp.expect_page_rejected('null total page count',
    jsonb_set(valid, '{totalPhysicalPages}', 'null'));
  CALL pg_temp.expect_page_rejected('fractional physical page',
    jsonb_set(valid, '{physicalPageNumber}', '1.5'));
  CALL pg_temp.expect_page_rejected('zero physical page',
    jsonb_set(valid, '{physicalPageNumber}', '0'));
  CALL pg_temp.expect_page_rejected('negative physical page',
    jsonb_set(valid, '{physicalPageNumber}', '-1'));
  CALL pg_temp.expect_page_rejected('unsafe physical page',
    jsonb_set(valid, '{physicalPageNumber}', '9007199254740992'));
  CALL pg_temp.expect_page_rejected('physical page above total',
    jsonb_set(valid, '{physicalPageNumber}', '3'));
  CALL pg_temp.expect_page_rejected('invalid mapping state',
    jsonb_set(valid, '{mappingState}', '"unknown"'));
  CALL pg_temp.expect_page_rejected('invalid mapping basis',
    jsonb_set(valid, '{mappingBasis}', '"unknown"'));
  CALL pg_temp.expect_page_rejected('legacy layer with resolved state',
    jsonb_set(valid, '{sourceLayer}', '"legacy"'));
  CALL pg_temp.expect_page_rejected('resolved state with unproven basis',
    jsonb_set(valid, '{mappingBasis}', '"unproven"'));
  CALL pg_temp.expect_page_rejected('invalid total page count',
    jsonb_set(valid, '{totalPhysicalPages}', '0'));
  CALL pg_temp.expect_page_rejected('fractional total page count',
    jsonb_set(valid, '{totalPhysicalPages}', '1.5'));
  CALL pg_temp.expect_page_rejected('unsafe total page count',
    jsonb_set(valid, '{totalPhysicalPages}', '9007199254740992'));
  CALL pg_temp.expect_page_rejected('cross-document binding', valid,
    '91000000-0000-0000-0000-000000000011');
  CALL pg_temp.expect_page_rejected('cross-artifact binding', valid,
    '91000000-0000-0000-0000-000000000011',
    '91000000-0000-0000-0000-000000000021',
    '91000000-0000-0000-0000-000000000031');
  CALL pg_temp.expect_page_rejected('row page mismatch', valid,
    '91000000-0000-0000-0000-000000000010',
    '91000000-0000-0000-0000-000000000020',
    '91000000-0000-0000-0000-000000000030', 2);
END;
$$;

CREATE PROCEDURE pg_temp.expect_update_rejected(
  label text,
  update_sql text,
  expected_state text
)
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE update_sql;
    RAISE EXCEPTION '% unexpectedly succeeded', label;
  EXCEPTION WHEN OTHERS THEN
    IF SQLSTATE <> expected_state THEN
      RAISE;
    END IF;
  END;
END;
$$;
CALL pg_temp.expect_update_rejected('UPDATE null bypass',
  $$UPDATE public.extraction_page_artifacts SET physical_page_coordinate = null
    WHERE id = '91000000-0000-0000-0000-000000000040'$$, '23514');

-- The production table is append-only. Disable only that independent trigger
-- while proving Phase 1B UPDATE CHECK behavior, then restore and assert it.
ALTER TABLE public.extraction_page_artifacts
  DISABLE TRIGGER trg_extraction_page_artifacts_append_only;
ALTER TABLE public.extraction_page_artifacts
  DISABLE TRIGGER trg_extraction_page_artifacts_provenance_integrity;
CALL pg_temp.expect_update_rejected('UPDATE document mismatch',
  $$UPDATE public.extraction_page_artifacts
    SET source_document_id = '91000000-0000-0000-0000-000000000011'
    WHERE id = '91000000-0000-0000-0000-000000000040'$$, '23514');
CALL pg_temp.expect_update_rejected('UPDATE artifact mismatch',
  $$UPDATE public.extraction_page_artifacts
    SET source_artifact_id = '91000000-0000-0000-0000-000000000021'
    WHERE id = '91000000-0000-0000-0000-000000000040'$$, '23514');
CALL pg_temp.expect_update_rejected('UPDATE page mismatch',
  $$UPDATE public.extraction_page_artifacts SET page = 2
    WHERE id = '91000000-0000-0000-0000-000000000040'$$, '23514');
CALL pg_temp.expect_update_rejected('malformed UPDATE',
  $$UPDATE public.extraction_page_artifacts SET physical_page_coordinate = '[]'
    WHERE id = '91000000-0000-0000-0000-000000000040'$$, '23514');
ALTER TABLE public.extraction_page_artifacts
  ENABLE TRIGGER trg_extraction_page_artifacts_append_only;
ALTER TABLE public.extraction_page_artifacts
  ENABLE TRIGGER trg_extraction_page_artifacts_provenance_integrity;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.extraction_page_artifacts'::regclass
      AND tgname = 'trg_extraction_page_artifacts_append_only'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.extraction_page_artifacts'::regclass
      AND tgname = 'trg_extraction_page_artifacts_provenance_integrity'
      AND tgenabled = 'O'
      AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'page artifact baseline triggers were not restored';
  END IF;
END;
$$;

-- Live publisher metadata and the exact grant matrix.
DO $$
DECLARE function_oid oid := 'public.publish_extraction_step1_shadow(jsonb)'::regprocedure;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_roles owner_role ON owner_role.oid = p.proowner
    JOIN pg_language language_role ON language_role.oid = p.prolang
    WHERE p.oid = function_oid
      AND owner_role.rolname = 'postgres'
      AND language_role.lanname = 'plpgsql'
      AND p.prosecdef AND p.provolatile = 'v' AND p.proparallel = 'u'
      AND NOT p.proisstrict
      AND p.prorettype = 'jsonb'::regtype
      AND p.pronargs = 1 AND p.proargtypes[0] = 'jsonb'::regtype
      AND p.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
  ) THEN
    RAISE EXCEPTION 'publisher catalog posture is incompatible';
  END IF;
  IF NOT has_function_privilege(
      'service_role', 'public.publish_extraction_step1_shadow(jsonb)', 'EXECUTE'
    )
    OR has_function_privilege(
      'anon', 'public.publish_extraction_step1_shadow(jsonb)', 'EXECUTE'
    )
    OR has_function_privilege(
      'authenticated', 'public.publish_extraction_step1_shadow(jsonb)', 'EXECUTE'
    )
    OR EXISTS (
      SELECT 1
      FROM aclexplode(COALESCE(
        (SELECT proacl FROM pg_proc WHERE oid = function_oid),
        acldefault('f', (SELECT proowner FROM pg_proc WHERE oid = function_oid))
      )) acl
      WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
    ) THEN
    RAISE EXCEPTION 'publisher grant matrix is incompatible';
  END IF;
END;
$$;

SET ROLE anon;
DO $$ BEGIN
  BEGIN
    PERFORM public.publish_extraction_step1_shadow('{}'::jsonb);
    RAISE EXCEPTION 'anon publisher invocation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;
SET ROLE authenticated;
DO $$ BEGIN
  BEGIN
    PERFORM public.publish_extraction_step1_shadow('{}'::jsonb);
    RAISE EXCEPTION 'authenticated publisher invocation unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

CREATE UNLOGGED TABLE public.phase1b_replay_payloads (
  name text PRIMARY KEY,
  payload jsonb NOT NULL
);
GRANT SELECT ON public.phase1b_replay_payloads TO service_role;
INSERT INTO public.phase1b_replay_payloads(name, payload) VALUES (
  'valid-v2',
  jsonb_build_object(
    'organization_id', '91000000-0000-0000-0000-000000000001',
    'source_document_id', '91000000-0000-0000-0000-000000000010',
    'source_artifact_id', '91000000-0000-0000-0000-000000000022',
    'source_sha256', repeat('3', 64),
    'parser_manifest', jsonb_build_object(
      'artifact_schema_version', 'extraction-artifact-v1', 'step', 'phase1b-regression'
    ),
    'parser_manifest_hash', repeat('a', 64),
    'artifact_schema_version', 'extraction-artifact-v2',
    'run_id', '91000000-0000-0000-0000-000000000050',
    'snapshot_id', '91000000-0000-0000-0000-000000000051',
    'idempotency_key', 'phase1b:rpc:v2',
    'run_status', 'complete', 'run_state_reason', null,
    'snapshot_status', 'complete',
    'started_at', '2026-08-12T00:00:00Z',
    'completed_at', '2026-08-12T00:00:01Z',
    'content_extraction_fingerprint', repeat('b', 64),
    'artifact_root_hash', repeat('c', 64),
    'pages', jsonb_build_array(jsonb_build_object(
      'id', '91000000-0000-0000-0000-000000000052', 'page', 1,
      'width', 612, 'height', 792, 'rotation_degrees', 0,
      'render_sha256', repeat('d', 64),
      'parser', jsonb_build_object('stage', 'page_render'), 'status', 'processed',
      'physical_page_coordinate', pg_temp.phase1b_coordinate(
        '91000000-0000-0000-0000-000000000010',
        '91000000-0000-0000-0000-000000000022'
      )
    )),
    'fragments', jsonb_build_array(jsonb_build_object(
      'id', '91000000-0000-0000-0000-000000000053',
      'page_artifact_id', '91000000-0000-0000-0000-000000000052',
      'kind', 'token', 'page', 1,
      'bounding_box', jsonb_build_object(
        'x0', 0.1, 'y0', 0.1, 'x1', 0.2, 'y1', 0.2, 'rotation', 0
      ),
      'raw_text', 'rpc token', 'parser', jsonb_build_object('stage', 'native_text'),
      'recognition_confidence', 0.99, 'reading_order', 1, 'artifact_data', '{}'::jsonb,
      'physical_page_coordinate', pg_temp.phase1b_coordinate(
        '91000000-0000-0000-0000-000000000010',
        '91000000-0000-0000-0000-000000000022'
      )
    )),
    'candidates', '[]'::jsonb, 'verified_fields', '[]'::jsonb, 'gaps', '[]'::jsonb,
    'fragment_dependencies', '[]'::jsonb, 'continuation_links', '[]'::jsonb,
    'table_chains', '[]'::jsonb, 'table_sections', '[]'::jsonb,
    'arbitration_decisions', '[]'::jsonb, 'semantic_column_mappings', '[]'::jsonb,
    'interpretation_records', '[]'::jsonb,
    'snapshot_members', jsonb_build_array(
      jsonb_build_object(
        'member_kind', 'page',
        'page_artifact_id', '91000000-0000-0000-0000-000000000052',
        'dependency_hash', repeat('e', 64), 'sequence', 1
      ),
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '91000000-0000-0000-0000-000000000053',
        'dependency_hash', repeat('f', 64), 'sequence', 2
      )
    )
  )
);
SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.publish_extraction_step1_shadow(payload)
FROM public.phase1b_replay_payloads WHERE name = 'valid-v2';
RESET ROLE;
RESET request.jwt.claim.role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_page_artifacts
    WHERE id = '91000000-0000-0000-0000-000000000052'
      AND physical_page_coordinate->>'sourceDocumentId'
        = '91000000-0000-0000-0000-000000000010'
      AND physical_page_coordinate->>'sourceArtifactId'
        = '91000000-0000-0000-0000-000000000022'
      AND physical_page_coordinate->>'physicalPageNumber' = '1'
      AND physical_page_coordinate->>'totalPhysicalPages' = '2'
  ) OR NOT EXISTS (
    SELECT 1 FROM public.extraction_fragment_artifacts
    WHERE id = '91000000-0000-0000-0000-000000000053'
      AND physical_page_coordinate->>'sourceDocumentId'
        = '91000000-0000-0000-0000-000000000010'
      AND physical_page_coordinate->>'sourceArtifactId'
        = '91000000-0000-0000-0000-000000000022'
      AND physical_page_coordinate->>'physicalPageNumber' = '1'
      AND physical_page_coordinate->>'totalPhysicalPages' = '2'
  ) THEN
    RAISE EXCEPTION 'publisher did not persist valid v2 page and fragment provenance';
  END IF;
  IF (SELECT physical_page_coordinate IS NOT NULL
      FROM public.extraction_page_artifacts
      WHERE id = '91000000-0000-0000-0000-000000000042')
    OR (SELECT physical_page_coordinate IS NOT NULL
        FROM public.extraction_fragment_artifacts
        WHERE id = '91000000-0000-0000-0000-000000000043') THEN
    RAISE EXCEPTION 'historical v1/null provenance was promoted';
  END IF;
END;
$$;
DROP TABLE public.phase1b_replay_payloads;

SELECT 'PHASE 1B POSTGRES INSERT / MALFORMED / UPDATE MATRIX: PASS' AS result;
SELECT 'PHASE 1B PUBLISHER CATALOG / GRANTS / RPC ROUND TRIP: PASS' AS result;
