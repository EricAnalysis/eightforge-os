#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -n "${STEP0_REPLAY_DATABASE_URL:-}" ]]; then
  psql=(psql -X -v ON_ERROR_STOP=1 "${STEP0_REPLAY_DATABASE_URL}")
else
  database_name="eightforge_step0_replay_${$}"
  cleanup() {
    runuser -u postgres -- dropdb --if-exists "${database_name}" >/dev/null
  }
  trap cleanup EXIT
  runuser -u postgres -- createdb "${database_name}"
  psql=(runuser -u postgres -- psql -X -v ON_ERROR_STOP=1 --dbname "${database_name}")
fi

"${psql[@]}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY, email text);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE
AS $$ SELECT current_setting('request.jwt.claim.role', true) $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon, service_role;
SQL

mapfile -t migrations < <(find supabase/migrations -maxdepth 1 -type f -name '*.sql' | sort)
if [[ "${#migrations[@]}" -eq 0 ]]; then
  echo "FRESH REPLAY: FAILED AT no migration files found"
  exit 1
fi
for migration in "${migrations[@]}"; do
  "${psql[@]}" --file "${migration}" >/dev/null
done

"${psql[@]}" <<'SQL'
SET request.jwt.claim.role = 'service_role';
INSERT INTO public.organizations (id, name)
VALUES
  ('10000000-0000-0000-0000-000000000001', 'Step 0 replay'),
  ('10000000-0000-0000-0000-000000000002', 'Other tenant');
INSERT INTO public.documents (
  id, organization_id, name, storage_path
) VALUES (
  '20000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001',
  'source.pdf',
  'step0/source.pdf'
);

SET ROLE service_role;
SELECT public.publish_extraction_compliance_shadow(
  '{
    "organization_id":"10000000-0000-0000-0000-000000000001",
    "source_document_id":"20000000-0000-0000-0000-000000000001",
    "source_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "storage_object_version":"object-1:2026-07-23T00:00:00Z",
    "media_type_sniffed":"application/pdf",
    "byte_length":100,
    "parser_manifest":{"artifact_schema_version":"extraction-artifact-v1"},
    "parser_manifest_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "artifact_schema_version":"extraction-artifact-v1",
    "idempotency_key":"analysis-job:replay-1",
    "started_at":"2026-07-23T00:00:00Z",
    "completed_at":"2026-07-23T00:00:01Z",
    "gap_key":"legacy-payload-missing-geometry-v1",
    "gap_detail":"Legacy payload has no complete geometry.",
    "gap_dependency_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "artifact_root_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "content_extraction_fingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "interpreter_manifest_hash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "entity_resolver_version":"step0-entity-resolution-disabled",
    "effective_truth_set_hash":"1111111111111111111111111111111111111111111111111111111111111111",
    "interpretation_output_root_hash":"2222222222222222222222222222222222222222222222222222222222222222",
    "projection_schema_version":"step0-shadow-projection-v1"
  }'::jsonb
);
SELECT public.publish_extraction_compliance_shadow(
  '{
    "organization_id":"10000000-0000-0000-0000-000000000001",
    "source_document_id":"20000000-0000-0000-0000-000000000001",
    "source_sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "storage_object_version":"object-1:2026-07-23T00:00:00Z",
    "media_type_sniffed":"application/pdf",
    "byte_length":100,
    "parser_manifest":{"artifact_schema_version":"extraction-artifact-v1"},
    "parser_manifest_hash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    "artifact_schema_version":"extraction-artifact-v1",
    "idempotency_key":"analysis-job:replay-1",
    "started_at":"2026-07-23T00:00:00Z",
    "completed_at":"2026-07-23T00:00:01Z",
    "gap_key":"legacy-payload-missing-geometry-v1",
    "gap_detail":"Legacy payload has no complete geometry.",
    "gap_dependency_hash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "artifact_root_hash":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    "content_extraction_fingerprint":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    "interpreter_manifest_hash":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "entity_resolver_version":"step0-entity-resolution-disabled",
    "effective_truth_set_hash":"1111111111111111111111111111111111111111111111111111111111111111",
    "interpretation_output_root_hash":"2222222222222222222222222222222222222222222222222222222222222222",
    "projection_schema_version":"step0-shadow-projection-v1"
  }'::jsonb
);
RESET ROLE;

SET ROLE service_role;
SELECT (
  public.resolve_extraction_step1_source(
    jsonb_build_object(
      'organization_id', '10000000-0000-0000-0000-000000000001',
      'source_document_id', '20000000-0000-0000-0000-000000000001',
      'source_sha256', repeat('6', 64),
      'storage_object_version', 'step1-object:1',
      'media_type_sniffed', 'application/pdf',
      'byte_length', 200
    )
  )
)->>'source_artifact_id' AS step1_source_id \gset
SELECT 1 / CASE WHEN (
  public.resolve_extraction_step1_source(
    jsonb_build_object(
      'organization_id', '10000000-0000-0000-0000-000000000001',
      'source_document_id', '20000000-0000-0000-0000-000000000001',
      'source_sha256', repeat('6', 64),
      'storage_object_version', 'step1-object:1',
      'media_type_sniffed', 'application/pdf',
      'byte_length', 200
    )
  )
)->>'source_artifact_id' = :'step1_source_id' THEN 1 ELSE 0 END
  AS step1_source_resolution_idempotent;

RESET ROLE;
CREATE UNLOGGED TABLE public.step1_replay_payloads (
  name text PRIMARY KEY,
  payload jsonb NOT NULL
);
GRANT SELECT ON public.step1_replay_payloads TO service_role;
INSERT INTO step1_replay_payloads (name, payload)
VALUES (
  'valid',
  jsonb_build_object(
    'organization_id', '10000000-0000-0000-0000-000000000001',
    'source_document_id', '20000000-0000-0000-0000-000000000001',
    'source_artifact_id', :'step1_source_id',
    'source_sha256', repeat('6', 64),
    'parser_manifest', jsonb_build_object(
      'artifact_schema_version', 'extraction-artifact-v1',
      'step', 'phase3-step1-replay'
    ),
    'parser_manifest_hash', repeat('7', 64),
    'artifact_schema_version', 'extraction-artifact-v1',
    'run_id', '70000000-0000-0000-0000-000000000010',
    'snapshot_id', '70000000-0000-0000-0000-000000000011',
    'idempotency_key', 'step1:replay:valid',
    'run_status', 'partial_terminal',
    'run_state_reason', 'source-grounded-field-with-quarantined-gap',
    'snapshot_status', 'partial',
    'started_at', '2026-07-24T00:00:00Z',
    'completed_at', '2026-07-24T00:00:01Z',
    'content_extraction_fingerprint', repeat('8', 64),
    'artifact_root_hash', repeat('9', 64),
    'pages', jsonb_build_array(jsonb_build_object(
      'id', '70000000-0000-0000-0000-000000000001',
      'page', 1, 'width', 612, 'height', 792, 'rotation_degrees', 0,
      'render_sha256', repeat('a', 64),
      'parser', jsonb_build_object(
        'stage', 'page_render', 'name', 'step1-replay',
        'version', '1', 'configuration_hash', repeat('b', 64)
      ),
      'status', 'processed'
    )),
    'fragments', jsonb_build_array(jsonb_build_object(
      'id', '70000000-0000-0000-0000-000000000002',
      'page_artifact_id', '70000000-0000-0000-0000-000000000001',
      'kind', 'token', 'page', 1,
      'bounding_box', jsonb_build_object(
        'x0', 0.1, 'y0', 0.1, 'x1', 0.2, 'y1', 0.2, 'rotation', 0
      ),
      'raw_text', '123.45',
      'parser', jsonb_build_object(
        'stage', 'native_text', 'name', 'step1-replay',
        'version', '1', 'configuration_hash', repeat('c', 64)
      ),
      'recognition_confidence', 0.99,
      'reading_order', 1,
      'artifact_data', '{}'::jsonb
    )),
    'candidates', jsonb_build_array(jsonb_build_object(
      'id', '70000000-0000-0000-0000-000000000003',
      'source_fragment_ids', jsonb_build_array(
        '70000000-0000-0000-0000-000000000002'
      ),
      'source_fragment_dependencies', jsonb_build_array(jsonb_build_object(
        'fragment_artifact_id', '70000000-0000-0000-0000-000000000002',
        'dependency_role', 'content'
      )),
      'raw_text', '123.45', 'primitive_kind', 'decimal',
      'proposed_value', jsonb_build_object('type', 'decimal', 'value', '123.45'),
      'transformations', '[]'::jsonb,
      'parser', jsonb_build_object(
        'stage', 'primitive_parse', 'name', 'step1-replay',
        'version', '1', 'configuration_hash', repeat('d', 64)
      ),
      'confidence', jsonb_build_object('version', 'extraction-confidence-v1', 'overall', 0.99),
      'status', 'candidate'
    )),
    'verified_fields', jsonb_build_array(jsonb_build_object(
      'id', '70000000-0000-0000-0000-000000000004',
      'candidate_id', '70000000-0000-0000-0000-000000000003',
      'source_fragment_ids', jsonb_build_array(
        '70000000-0000-0000-0000-000000000002'
      ),
      'raw_text', '123.45',
      'normalized_value', jsonb_build_object('type', 'decimal', 'value', '123.45'),
      'transformations', '[]'::jsonb,
      'verifier', jsonb_build_object(
        'stage', 'field_verification', 'name', 'step1-replay',
        'version', '1', 'configuration_hash', repeat('e', 64)
      ),
      'confidence', jsonb_build_object('version', 'extraction-confidence-v1', 'overall', 0.99)
    )),
    'gaps', jsonb_build_array(jsonb_build_object(
      'id', '70000000-0000-0000-0000-000000000005',
      'gap_key', 'step1-no-source-span:secondary-field',
      'page', 1,
      'bounding_box', jsonb_build_object(
        'x0', 0.3, 'y0', 0.3, 'x1', 0.4, 'y1', 0.4, 'rotation', 0
      ),
      'stage', 'field_verification', 'reason', 'no_source_span',
      'retryable', false, 'attempts', 1,
      'detail', 'Secondary candidate lacked a verifiable source span.',
      'upstream_artifact_ids', jsonb_build_array(
        '70000000-0000-0000-0000-000000000002'
      )
    )),
    'snapshot_members', jsonb_build_array(
      jsonb_build_object(
        'member_kind', 'page', 'page_artifact_id', '70000000-0000-0000-0000-000000000001',
        'dependency_hash', repeat('1', 64), 'sequence', 1
      ),
      jsonb_build_object(
        'member_kind', 'fragment', 'fragment_artifact_id', '70000000-0000-0000-0000-000000000002',
        'dependency_hash', repeat('2', 64), 'sequence', 2
      ),
      jsonb_build_object(
        'member_kind', 'candidate', 'field_candidate_id', '70000000-0000-0000-0000-000000000003',
        'dependency_hash', repeat('3', 64), 'sequence', 3
      ),
      jsonb_build_object(
        'member_kind', 'verified_field', 'verified_field_id', '70000000-0000-0000-0000-000000000004',
        'dependency_hash', repeat('4', 64), 'sequence', 4
      ),
      jsonb_build_object(
        'member_kind', 'gap', 'processing_gap_id', '70000000-0000-0000-0000-000000000005',
        'dependency_hash', repeat('5', 64), 'sequence', 5
      )
    )
  )
);

SET ROLE service_role;
SELECT public.publish_extraction_step1_shadow(payload) AS first_step1_result
FROM step1_replay_payloads WHERE name = 'valid' \gset
SELECT public.publish_extraction_step1_shadow(payload) AS replayed_step1_result
FROM step1_replay_payloads WHERE name = 'valid' \gset
SELECT 1 / CASE WHEN
  (:'first_step1_result'::jsonb->>'source_artifact_id') = :'step1_source_id'
  AND (:'first_step1_result'::jsonb->>'extraction_run_id')
    = '70000000-0000-0000-0000-000000000010'
  AND (:'first_step1_result'::jsonb->>'extraction_snapshot_id')
    = '70000000-0000-0000-0000-000000000011'
  AND (:'first_step1_result'::jsonb->>'reused')::boolean = false
  AND (:'replayed_step1_result'::jsonb->>'source_artifact_id') = :'step1_source_id'
  AND (:'replayed_step1_result'::jsonb->>'extraction_run_id')
    = '70000000-0000-0000-0000-000000000010'
  AND (:'replayed_step1_result'::jsonb->>'extraction_snapshot_id')
    = '70000000-0000-0000-0000-000000000011'
  AND (:'replayed_step1_result'::jsonb->>'reused')::boolean = true
  THEN 1 ELSE 0 END AS step1_rpc_result_and_reuse_ok;
RESET ROLE;

DO $$
DECLARE
  valid_payload jsonb;
  atomic_payload jsonb;
  omitted_member_payload jsonb;
  foreign_member_payload jsonb;
  divergent_field_payload jsonb;
  raw_span_payload jsonb;
  transformation_payload jsonb;
  invalid_gap_box_payload jsonb;
  mixed_role_payload jsonb;
  changed_role_payload jsonb;
  corroboration_text_payload jsonb;
  only_corroboration_payload jsonb;
  unsupported_role_payload jsonb;
  corroboration_geometry_payload jsonb;
  mixed_result jsonb;
  new_manifest_payload jsonb;
  new_source_payload jsonb;
  resolved_source jsonb;
BEGIN
  SELECT payload INTO valid_payload
  FROM step1_replay_payloads WHERE name = 'valid';

  IF (SELECT count(*) FROM public.extraction_runs
      WHERE idempotency_key = 'step1:replay:valid') <> 1
    OR (SELECT count(*) FROM public.extraction_page_artifacts
        WHERE id = '70000000-0000-0000-0000-000000000001') <> 1
    OR (SELECT count(*) FROM public.extraction_fragment_artifacts
        WHERE id = '70000000-0000-0000-0000-000000000002') <> 1
    OR (SELECT count(*) FROM public.extraction_field_candidates
        WHERE id = '70000000-0000-0000-0000-000000000003') <> 1
    OR (SELECT count(*) FROM public.extraction_verified_fields
        WHERE id = '70000000-0000-0000-0000-000000000004') <> 1
    OR (SELECT count(*) FROM public.extraction_processing_gaps
        WHERE id = '70000000-0000-0000-0000-000000000005') <> 1 THEN
    RAISE EXCEPTION 'Step 1 publisher is not idempotent';
  END IF;

  mixed_role_payload := replace(
    valid_payload::text, '70000000-', '7b000000-'
  )::jsonb;
  mixed_role_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          mixed_role_payload,
          '{idempotency_key}', '"step1:replay:mixed-roles"'::jsonb
        ),
        '{parser_manifest_hash}', to_jsonb(repeat('a', 64))
      ),
      '{content_extraction_fingerprint}', to_jsonb(repeat('b', 64))
    ),
    '{artifact_root_hash}', to_jsonb(repeat('c', 64))
  );
  mixed_role_payload := jsonb_set(
    mixed_role_payload,
    '{fragments}',
    (mixed_role_payload->'fragments') || jsonb_build_array(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            mixed_role_payload#>'{fragments,0}',
            '{id}', '"7b000000-0000-0000-0000-000000000006"'::jsonb
          ),
          '{raw_text}', '"CORROBORATION"'::jsonb
        ),
        '{reading_order}', '2'::jsonb
      )
    )
  );
  mixed_role_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        mixed_role_payload,
        '{candidates,0,source_fragment_ids}',
        jsonb_build_array(
          '7b000000-0000-0000-0000-000000000002',
          '7b000000-0000-0000-0000-000000000006'
        )
      ),
      '{candidates,0,source_fragment_dependencies}',
      jsonb_build_array(
        jsonb_build_object(
          'fragment_artifact_id', '7b000000-0000-0000-0000-000000000002',
          'dependency_role', 'content'
        ),
        jsonb_build_object(
          'fragment_artifact_id', '7b000000-0000-0000-0000-000000000006',
          'dependency_role', 'corroboration'
        )
      )
    ),
    '{verified_fields,0,source_fragment_ids}',
    jsonb_build_array(
      '7b000000-0000-0000-0000-000000000002',
      '7b000000-0000-0000-0000-000000000006'
    )
  );
  mixed_role_payload := jsonb_set(
    mixed_role_payload,
    '{snapshot_members}',
    (mixed_role_payload->'snapshot_members') || jsonb_build_array(
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '7b000000-0000-0000-0000-000000000006',
        'dependency_hash', repeat('6', 64),
        'sequence', 6
      )
    )
  );

  mixed_result := public.publish_extraction_step1_shadow(mixed_role_payload);
  IF (mixed_result->>'reused')::boolean
    OR (public.publish_extraction_step1_shadow(mixed_role_payload)->>'reused')::boolean
      IS DISTINCT FROM true
    OR (
      SELECT array_agg(dependency_role ORDER BY sequence)
      FROM public.extraction_field_candidate_sources
      WHERE field_candidate_id = '7b000000-0000-0000-0000-000000000003'
    ) IS DISTINCT FROM ARRAY['content', 'corroboration']::text[] THEN
    RAISE EXCEPTION 'mixed dependency roles did not publish and replay exactly';
  END IF;

  changed_role_payload := jsonb_set(
    mixed_role_payload,
    '{candidates,0,source_fragment_dependencies,1,dependency_role}',
    '"content"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(changed_role_payload);
    RAISE EXCEPTION 'idempotent replay accepted divergent dependency roles';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  corroboration_text_payload := replace(
    mixed_role_payload::text, '7b000000-', '7c000000-'
  )::jsonb;
  corroboration_text_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            corroboration_text_payload,
            '{idempotency_key}', '"step1:replay:corroboration-in-raw"'::jsonb
          ),
          '{parser_manifest_hash}', to_jsonb(repeat('b', 64))
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('d', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('e', 64))
    ),
    '{candidates,0,raw_text}', '"123.45CORROBORATION"'::jsonb
  );
  corroboration_text_payload := jsonb_set(
    corroboration_text_payload,
    '{verified_fields,0,raw_text}', '"123.45CORROBORATION"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(corroboration_text_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'candidate raw text included corroboration text';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  only_corroboration_payload := replace(
    valid_payload::text, '70000000-', '7d000000-'
  )::jsonb;
  only_corroboration_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            only_corroboration_payload,
            '{idempotency_key}', '"step1:replay:only-corroboration"'::jsonb
          ),
          '{parser_manifest_hash}', to_jsonb(repeat('c', 64))
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('1', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('2', 64))
    ),
    '{candidates,0,source_fragment_dependencies,0,dependency_role}',
    '"corroboration"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(only_corroboration_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'candidate with only corroboration fragments succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  unsupported_role_payload := replace(
    valid_payload::text, '70000000-', '7e000000-'
  )::jsonb;
  unsupported_role_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            unsupported_role_payload,
            '{idempotency_key}', '"step1:replay:unsupported-role"'::jsonb
          ),
          '{parser_manifest_hash}', to_jsonb(repeat('d', 64))
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('3', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('4', 64))
    ),
    '{candidates,0,source_fragment_dependencies,0,dependency_role}',
    '"unsupported"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(unsupported_role_payload);
    RAISE EXCEPTION 'unsupported dependency role succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  corroboration_geometry_payload := replace(
    mixed_role_payload::text, '7b000000-', '7f000000-'
  )::jsonb;
  corroboration_geometry_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            corroboration_geometry_payload,
            '{idempotency_key}', '"step1:replay:corroboration-geometry"'::jsonb
          ),
          '{parser_manifest_hash}', to_jsonb(repeat('e', 64))
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('5', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('6', 64))
    ),
    '{fragments,1,bounding_box,x1}', '1.1'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(corroboration_geometry_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'invalid corroboration geometry succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  IF EXISTS (
    SELECT 1 FROM public.extraction_runs
    WHERE idempotency_key IN (
      'step1:replay:corroboration-in-raw',
      'step1:replay:only-corroboration',
      'step1:replay:unsupported-role',
      'step1:replay:corroboration-geometry'
    )
  ) THEN
    RAISE EXCEPTION 'dependency-role rejection left a partial graph';
  END IF;

  omitted_member_payload := replace(
    valid_payload::text, '70000000-', '75000000-'
  )::jsonb;
  omitted_member_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        omitted_member_payload #- '{snapshot_members,2}',
        '{idempotency_key}', '"step1:replay:omitted-member"'::jsonb
      ),
      '{content_extraction_fingerprint}', to_jsonb(repeat('a', 64))
    ),
    '{artifact_root_hash}', to_jsonb(repeat('b', 64))
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(omitted_member_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Step 1 snapshot omitted an inserted artifact';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.extraction_runs
    WHERE idempotency_key = 'step1:replay:omitted-member'
  ) THEN
    RAISE EXCEPTION 'omitted-member Step 1 rejection left partial records';
  END IF;

  foreign_member_payload := replace(
    valid_payload::text, '70000000-', '76000000-'
  )::jsonb;
  foreign_member_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          foreign_member_payload,
          '{idempotency_key}', '"step1:replay:foreign-member"'::jsonb
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('c', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('d', 64))
    ),
    '{snapshot_members,0,page_artifact_id}',
    '"70000000-0000-0000-0000-000000000001"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(foreign_member_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Step 1 snapshot included an artifact outside its run';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.extraction_runs
    WHERE idempotency_key = 'step1:replay:foreign-member'
  ) THEN
    RAISE EXCEPTION 'foreign-member Step 1 rejection left partial records';
  END IF;

  divergent_field_payload := replace(
    valid_payload::text, '70000000-', '77000000-'
  )::jsonb;
  divergent_field_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          divergent_field_payload,
          '{idempotency_key}', '"step1:replay:divergent-field"'::jsonb
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('e', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('f', 64))
    ),
    '{verified_fields,0,raw_text}', '"different"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(divergent_field_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Step 1 verified field diverged from its candidate';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.extraction_runs
    WHERE idempotency_key = 'step1:replay:divergent-field'
  ) THEN
    RAISE EXCEPTION 'divergent-field Step 1 rejection left partial records';
  END IF;

  raw_span_payload := replace(
    valid_payload::text, '70000000-', '78000000-'
  )::jsonb;
  raw_span_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            raw_span_payload,
            '{idempotency_key}', '"step1:replay:raw-span"'::jsonb
          ),
          '{content_extraction_fingerprint}', to_jsonb(repeat('1', 64))
        ),
        '{artifact_root_hash}', to_jsonb(repeat('2', 64))
      ),
      '{candidates,0,raw_text}', '"different"'::jsonb
    ),
    '{verified_fields,0,raw_text}', '"different"'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(raw_span_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Step 1 candidate raw text diverged from ordered fragments';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  transformation_payload := replace(
    valid_payload::text, '70000000-', '79000000-'
  )::jsonb;
  transformation_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        transformation_payload,
        '{idempotency_key}', '"step1:replay:transformation-trace"'::jsonb
      ),
      '{content_extraction_fingerprint}', to_jsonb(repeat('3', 64))
    ),
    '{artifact_root_hash}', to_jsonb(repeat('4', 64))
  );
  transformation_payload := jsonb_set(
    jsonb_set(
      transformation_payload,
      '{candidates,0,transformations}',
      jsonb_build_array(jsonb_build_object(
        'sequence', 1,
        'operation', 'join_ordered_fragments',
        'implementation_version', '1',
        'input_sha256', repeat('0', 64),
        'output_sha256',
          encode(sha256(convert_to('123.45', 'UTF8')), 'hex'),
        'input_text', '123.45',
        'output_text', '123.45',
        'lossless', true,
        'rationale', 'integration test'
      ))
    ),
    '{verified_fields,0,transformations}',
    jsonb_build_array(jsonb_build_object(
      'sequence', 1,
      'operation', 'join_ordered_fragments',
      'implementation_version', '1',
      'input_sha256', repeat('0', 64),
      'output_sha256', encode(sha256(convert_to('123.45', 'UTF8')), 'hex'),
      'input_text', '123.45',
      'output_text', '123.45',
      'lossless', true,
      'rationale', 'integration test'
    ))
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(transformation_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Step 1 accepted an inconsistent transformation trace';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  invalid_gap_box_payload := replace(
    valid_payload::text, '70000000-', '7a000000-'
  )::jsonb;
  invalid_gap_box_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          invalid_gap_box_payload,
          '{idempotency_key}', '"step1:replay:invalid-gap-box"'::jsonb
        ),
        '{content_extraction_fingerprint}', to_jsonb(repeat('5', 64))
      ),
      '{artifact_root_hash}', to_jsonb(repeat('6', 64))
    ),
    '{gaps,0,bounding_box,x1}', '1.1'::jsonb
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(invalid_gap_box_payload);
    SET CONSTRAINTS ALL IMMEDIATE;
    RAISE EXCEPTION 'Step 1 accepted an invalid normalized gap box';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.publish_extraction_step1_shadow(
      jsonb_set(valid_payload, '{artifact_root_hash}', to_jsonb(repeat('f', 64)))
    );
    RAISE EXCEPTION 'divergent Step 1 idempotency reuse unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  -- Give the atomicity case fresh identities so it fails only after the run,
  -- page, fragment, and candidate inserts have executed.
  atomic_payload := replace(
    replace(
      replace(
        replace(
          replace(
            replace(
              replace(
                replace(valid_payload::text,
                  'step1:replay:valid', 'step1:replay:atomic'),
                repeat('7', 64), repeat('c', 64)),
              repeat('8', 64), repeat('d', 64)),
            repeat('9', 64), repeat('e', 64)),
          '70000000-0000-0000-0000-000000000001',
          '71000000-0000-0000-0000-000000000001'),
        '70000000-0000-0000-0000-000000000002',
        '71000000-0000-0000-0000-000000000002'),
      '70000000-0000-0000-0000-000000000003',
      '71000000-0000-0000-0000-000000000003'),
    '70000000-0000-0000-0000-000000000004',
    '71000000-0000-0000-0000-000000000004')::jsonb;
  atomic_payload := replace(
    atomic_payload::text,
    '70000000-0000-0000-0000-000000000005',
    '71000000-0000-0000-0000-000000000005'
  )::jsonb;
  atomic_payload := replace(
    replace(
      atomic_payload::text,
      '70000000-0000-0000-0000-000000000010',
      '71000000-0000-0000-0000-000000000010'
    ),
    '70000000-0000-0000-0000-000000000011',
    '71000000-0000-0000-0000-000000000011'
  )::jsonb;
  atomic_payload := jsonb_set(
    jsonb_set(
      atomic_payload,
      '{candidates,0,source_fragment_ids,0}',
      '"71000000-0000-0000-0000-000000000099"'::jsonb
    ),
    '{candidates,0,source_fragment_dependencies,0,fragment_artifact_id}',
    '"71000000-0000-0000-0000-000000000099"'::jsonb
  );

  BEGIN
    PERFORM public.publish_extraction_step1_shadow(atomic_payload);
    RAISE EXCEPTION 'invalid Step 1 dependency unexpectedly succeeded';
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM public.extraction_runs
    WHERE idempotency_key = 'step1:replay:atomic'
  ) OR EXISTS (
    SELECT 1 FROM public.extraction_page_artifacts
    WHERE id = '71000000-0000-0000-0000-000000000001'
  ) OR EXISTS (
    SELECT 1 FROM public.extraction_fragment_artifacts
    WHERE id = '71000000-0000-0000-0000-000000000002'
  ) OR EXISTS (
    SELECT 1 FROM public.extraction_field_candidates
    WHERE id = '71000000-0000-0000-0000-000000000003'
  ) THEN
    RAISE EXCEPTION 'failed Step 1 publication left partial records';
  END IF;

  new_manifest_payload := replace(
    valid_payload::text, '70000000-', '73000000-'
  )::jsonb;
  new_manifest_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          new_manifest_payload,
          '{idempotency_key}', '"step1:replay:new-manifest"'::jsonb
        ),
        '{parser_manifest_hash}', to_jsonb(repeat('3', 64))
      ),
      '{content_extraction_fingerprint}', to_jsonb(repeat('4', 64))
    ),
    '{artifact_root_hash}', to_jsonb(repeat('5', 64))
  );
  PERFORM public.publish_extraction_step1_shadow(new_manifest_payload);
  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_snapshots
    WHERE id = '73000000-0000-0000-0000-000000000011'
      AND parser_manifest_hash = repeat('3', 64)
  ) THEN
    RAISE EXCEPTION 'Step 1 new-manifest snapshot was not published';
  END IF;

  resolved_source := public.resolve_extraction_step1_source(jsonb_build_object(
    'organization_id', '10000000-0000-0000-0000-000000000001',
    'source_document_id', '20000000-0000-0000-0000-000000000001',
    'source_sha256', repeat('4', 64),
    'storage_object_version', 'step1-object:2',
    'media_type_sniffed', 'application/pdf',
    'byte_length', 201
  ));
  new_source_payload := replace(
    valid_payload::text, '70000000-', '74000000-'
  )::jsonb;
  new_source_payload := jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(
            jsonb_set(
              new_source_payload,
              '{idempotency_key}', '"step1:replay:new-source"'::jsonb
            ),
            '{content_extraction_fingerprint}', to_jsonb(repeat('6', 64))
          ),
          '{artifact_root_hash}', to_jsonb(repeat('a', 64))
        ),
        '{source_artifact_id}', resolved_source->'source_artifact_id'
      ),
      '{source_sha256}', to_jsonb(repeat('4', 64))
    ),
    '{completed_at}', '"2026-07-24T00:00:03Z"'::jsonb
  );
  PERFORM public.publish_extraction_step1_shadow(new_source_payload);
  IF NOT EXISTS (
    SELECT 1 FROM public.extraction_snapshots
    WHERE id = '74000000-0000-0000-0000-000000000011'
      AND source_artifact_id = (resolved_source->>'source_artifact_id')::uuid
  ) THEN
    RAISE EXCEPTION 'Step 1 new-source snapshot was not published';
  END IF;
  PERFORM public.publish_extraction_step1_shadow(jsonb_set(
    new_manifest_payload,
    '{idempotency_key}',
    '"step1:replay:stale-semantic-retry"'::jsonb
  ));
  IF NOT EXISTS (
    SELECT 1
    FROM public.document_extraction_snapshot_assignments
    WHERE organization_id = '10000000-0000-0000-0000-000000000001'
      AND source_document_id = '20000000-0000-0000-0000-000000000001'
      AND source_artifact_id = (resolved_source->>'source_artifact_id')::uuid
      AND extraction_snapshot_id = '74000000-0000-0000-0000-000000000011'
      AND activation_mode = 'shadow'
  ) THEN
    RAISE EXCEPTION 'older Step 1 retry replaced the newer shadow assignment';
  END IF;

  BEGIN
    PERFORM public.resolve_extraction_step1_source(jsonb_build_object(
      'organization_id', '10000000-0000-0000-0000-000000000001',
      'source_document_id', '20000000-0000-0000-0000-000000000001',
      'source_sha256', repeat('4', 64),
      'storage_object_version', 'step1-object:2',
      'media_type_sniffed', 'application/pdf',
      'byte_length', 999
    ));
    RAISE EXCEPTION 'divergent Step 1 source metadata unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;

  BEGIN
    PERFORM public.publish_extraction_step1_shadow(
      jsonb_set(
        valid_payload,
        '{organization_id}',
        '"10000000-0000-0000-0000-000000000002"'::jsonb
      )
    );
    RAISE EXCEPTION 'cross-tenant Step 1 publication unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  IF EXISTS (SELECT 1 FROM public.canonical_document_facts)
    OR (SELECT count(*) FROM public.document_projection_stamps) <> 1 THEN
    RAISE EXCEPTION 'Step 1 shadow publication changed canonical or projection truth';
  END IF;
END;
$$;
RESET ROLE;

DO $$
DECLARE
  base_payload jsonb;
  step3_payload jsonb;
  parser_identity jsonb := jsonb_build_object(
    'stage', 'layout', 'name', 'step3-replay',
    'version', '1', 'configuration_hash', repeat('3', 64)
  );
  source_id text;
BEGIN
  SELECT payload INTO base_payload
  FROM public.step1_replay_payloads WHERE name = 'valid';
  source_id := base_payload->>'source_artifact_id';
  step3_payload := replace(
    base_payload::text, '70000000-', '7d000000-'
  )::jsonb || jsonb_build_object(
    'parser_manifest', jsonb_build_object(
      'artifact_schema_version', 'extraction-artifact-v1',
      'step', 'phase3-step3-nonempty-replay'
    ),
    'parser_manifest_hash', repeat('3', 63) || 'a',
    'idempotency_key', 'step3:replay:valid-nonempty',
    'content_extraction_fingerprint', repeat('4', 64),
    'artifact_root_hash', repeat('5', 64)
  );
  step3_payload := step3_payload || jsonb_build_object(
    'fragments', (step3_payload->'fragments') || jsonb_build_array(
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000020',
        'page_artifact_id', '7d000000-0000-0000-0000-000000000001',
        'kind', 'cell', 'page', 1,
        'bounding_box', jsonb_build_object(
          'x0', 0.1, 'y0', 0.2, 'x1', 0.3, 'y1', 0.3, 'rotation', 0
        ),
        'raw_text', '123.45', 'parser', parser_identity,
        'recognition_confidence', 0.99, 'reading_order', 2,
        'artifact_data', jsonb_build_object(
          'structure', 'ordinary', 'content_token_ids',
          jsonb_build_array('7d000000-0000-0000-0000-000000000002')
        )
      ),
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000021',
        'page_artifact_id', '7d000000-0000-0000-0000-000000000001',
        'kind', 'region', 'page', 1,
        'bounding_box', jsonb_build_object(
          'x0', 0.1, 'y0', 0.2, 'x1', 0.3, 'y1', 0.3, 'rotation', 0
        ),
        'raw_text', '123.45', 'parser', parser_identity,
        'recognition_confidence', null, 'reading_order', 3,
        'artifact_data', jsonb_build_object('region_role', 'table_row')
      ),
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000022',
        'page_artifact_id', '7d000000-0000-0000-0000-000000000001',
        'kind', 'region', 'page', 1,
        'bounding_box', jsonb_build_object(
          'x0', 0.1, 'y0', 0.2, 'x1', 0.4, 'y1', 0.4, 'rotation', 0
        ),
        'raw_text', '123.45', 'parser', parser_identity,
        'recognition_confidence', null, 'reading_order', 4,
        'artifact_data', jsonb_build_object('region_role', 'table')
      ),
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000023',
        'page_artifact_id', '7d000000-0000-0000-0000-000000000001',
        'kind', 'region', 'page', 1,
        'bounding_box', jsonb_build_object(
          'x0', 0.1, 'y0', 0.45, 'x1', 0.4, 'y1', 0.65, 'rotation', 0
        ),
        'raw_text', '123.45', 'parser', parser_identity,
        'recognition_confidence', null, 'reading_order', 5,
        'artifact_data', jsonb_build_object('region_role', 'table')
      ),
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000024',
        'page_artifact_id', '7d000000-0000-0000-0000-000000000001',
        'kind', 'region', 'page', 1,
        'bounding_box', jsonb_build_object(
          'x0', 0.1, 'y0', 0.1, 'x1', 0.2, 'y1', 0.2, 'rotation', 0
        ),
        'raw_text', '123.45', 'parser', parser_identity,
        'recognition_confidence', 0.99, 'reading_order', 6,
        'artifact_data', jsonb_build_object('region_role', 'candidate')
      )
    ),
    'fragment_dependencies', jsonb_build_array(
      jsonb_build_object(
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000020',
        'dependency_fragment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000002'
        )
      ),
      jsonb_build_object(
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000021',
        'dependency_fragment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000020'
        )
      ),
      jsonb_build_object(
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000022',
        'dependency_fragment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000021'
        )
      ),
      jsonb_build_object(
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000023',
        'dependency_fragment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000021'
        )
      ),
      jsonb_build_object(
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000024',
        'dependency_fragment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000002'
        )
      )
    ),
    'continuation_links', jsonb_build_array(jsonb_build_object(
      'id', '7d000000-0000-0000-0000-000000000030',
      'parser', parser_identity,
      'from_segment_id', '7d000000-0000-0000-0000-000000000022',
      'to_segment_id', '7d000000-0000-0000-0000-000000000023',
      'basis', jsonb_build_object('version', 'continuation-v1'),
      'score', jsonb_build_object('value', 0.9),
      'decision', 'linked',
      'basis_fragments', jsonb_build_array(
        jsonb_build_object(
          'basis_kind', 'column_band_similarity',
          'fragment_artifact_id', '7d000000-0000-0000-0000-000000000022',
          'sequence', 1
        ),
        jsonb_build_object(
          'basis_kind', 'edge_proximity',
          'fragment_artifact_id', '7d000000-0000-0000-0000-000000000023',
          'sequence', 1
        )
      )
    )),
    'table_chains', jsonb_build_array(
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000031',
        'parser', parser_identity, 'completeness', 'partial',
        'segment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000022',
          '7d000000-0000-0000-0000-000000000023'
        ),
        'continuation_link_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000030'
        ),
        'gap_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000005'
        )
      ),
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000032',
        'parser', parser_identity, 'completeness', 'complete',
        'segment_ids', jsonb_build_array(
          '7d000000-0000-0000-0000-000000000023'
        ),
        'continuation_link_ids', '[]'::jsonb, 'gap_ids', '[]'::jsonb
      )
    ),
    'table_sections', jsonb_build_array(jsonb_build_object(
      'id', '7d000000-0000-0000-0000-000000000033',
      'parser', parser_identity,
      'table_chain_id', '7d000000-0000-0000-0000-000000000031',
      'header_row_id', '7d000000-0000-0000-0000-000000000021',
      'sequence', 1,
      'member_row_ids', jsonb_build_array(
        '7d000000-0000-0000-0000-000000000021'
      ),
      'child_table_chain_ids', jsonb_build_array(
        '7d000000-0000-0000-0000-000000000032'
      )
    )),
    'arbitration_decisions', jsonb_build_array(jsonb_build_object(
      'id', '7d000000-0000-0000-0000-000000000034',
      'parser', parser_identity,
      'page_artifact_id', '7d000000-0000-0000-0000-000000000001',
      'physical_region_id', '7d000000-0000-0000-0000-000000000024',
      'processing_gap_id', null,
      'agreement', null, 'decision', 'single_source',
      'diagnostics', '[]'::jsonb,
      'candidates', jsonb_build_array(jsonb_build_object(
        'candidate_fragment_id', '7d000000-0000-0000-0000-000000000024',
        'disposition', 'accepted', 'sequence', 1
      ))
    )),
    'interpretation_snapshot', jsonb_build_object(
      'id', '7d000000-0000-0000-0000-000000000040',
      'interpreter_manifest_hash', repeat('6', 64),
      'entity_resolver_version', 'not-applicable-step3',
      'effective_truth_set_hash', repeat('7', 64),
      'status', 'partial', 'output_root_hash', repeat('8', 64),
      'published_at', '2026-07-27T00:00:01Z'
    ),
    'semantic_column_mappings', jsonb_build_array(jsonb_build_object(
      'id', '7d000000-0000-0000-0000-000000000041',
      'table_chain_id', '7d000000-0000-0000-0000-000000000031',
      'column_index', 0, 'domain_role', 'quantity',
      'assessment', jsonb_build_object('rule', 'quantity-v1'),
      'status', 'resolved',
      'interpretation_rule_id', 'semantic-column-role',
      'interpretation_rule_version', '1',
      'header_verified_field_ids', '[]'::jsonb,
      'cell_verified_field_ids', jsonb_build_array(
        '7d000000-0000-0000-0000-000000000004'
      )
    )),
    'interpretation_records', jsonb_build_array(
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000042',
        'record_type', 'semantic_column_mapping',
        'semantic_column_mapping_id', '7d000000-0000-0000-0000-000000000041',
        'record_data', '{}'::jsonb, 'sequence', 1
      ),
      jsonb_build_object(
        'id', '7d000000-0000-0000-0000-000000000043',
        'record_type', 'gap',
        'processing_gap_id', '7d000000-0000-0000-0000-000000000005',
        'record_data', jsonb_build_object('reason', 'table_structure_unresolved'),
        'sequence', 2
      )
    )
  );
  step3_payload := step3_payload || jsonb_build_object(
    'snapshot_members', (step3_payload->'snapshot_members') || jsonb_build_array(
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000020',
        'dependency_hash', repeat('a', 64), 'sequence', 6
      ),
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000021',
        'dependency_hash', repeat('b', 64), 'sequence', 7
      ),
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000022',
        'dependency_hash', repeat('c', 64), 'sequence', 8
      ),
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000023',
        'dependency_hash', repeat('d', 64), 'sequence', 9
      ),
      jsonb_build_object(
        'member_kind', 'fragment',
        'fragment_artifact_id', '7d000000-0000-0000-0000-000000000024',
        'dependency_hash', repeat('e', 64), 'sequence', 10
      ),
      jsonb_build_object(
        'member_kind', 'continuation_link',
        'continuation_link_id', '7d000000-0000-0000-0000-000000000030',
        'dependency_hash', repeat('1', 64), 'sequence', 11
      ),
      jsonb_build_object(
        'member_kind', 'table_chain',
        'table_chain_id', '7d000000-0000-0000-0000-000000000031',
        'dependency_hash', repeat('2', 64), 'sequence', 12
      ),
      jsonb_build_object(
        'member_kind', 'table_chain',
        'table_chain_id', '7d000000-0000-0000-0000-000000000032',
        'dependency_hash', repeat('3', 64), 'sequence', 13
      ),
      jsonb_build_object(
        'member_kind', 'table_section',
        'table_section_id', '7d000000-0000-0000-0000-000000000033',
        'dependency_hash', repeat('4', 64), 'sequence', 14
      ),
      jsonb_build_object(
        'member_kind', 'arbitration_decision',
        'arbitration_decision_id', '7d000000-0000-0000-0000-000000000034',
        'dependency_hash', repeat('5', 64), 'sequence', 15
      )
    )
  );
  INSERT INTO public.step1_replay_payloads(name, payload)
  VALUES ('step3_valid_nonempty', step3_payload);
END;
$$;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
SELECT public.publish_extraction_step1_shadow(payload)
FROM public.step1_replay_payloads
WHERE name = 'step3_valid_nonempty';
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.extraction_table_continuation_links
      WHERE extraction_run_id = '7d000000-0000-0000-0000-000000000010') <> 1
    OR (SELECT count(*) FROM public.extraction_table_chains
        WHERE extraction_run_id = '7d000000-0000-0000-0000-000000000010') <> 2
    OR (SELECT count(*) FROM public.extraction_table_sections
        WHERE extraction_run_id = '7d000000-0000-0000-0000-000000000010') <> 1
    OR (SELECT count(*) FROM public.extraction_arbitration_decisions
        WHERE extraction_run_id = '7d000000-0000-0000-0000-000000000010') <> 1
    OR (SELECT count(*) FROM public.semantic_column_mappings
        WHERE interpretation_snapshot_id =
          '7d000000-0000-0000-0000-000000000040') <> 1
    OR (SELECT count(*) FROM public.semantic_column_mapping_fields
        WHERE interpretation_snapshot_id =
          '7d000000-0000-0000-0000-000000000040') <> 1 THEN
    RAISE EXCEPTION 'valid nonempty Step 3 graph did not publish completely';
  END IF;
END;
$$;

SET request.jwt.claim.role = 'authenticated';
DO $$
DECLARE
  valid_payload jsonb;
BEGIN
  SELECT payload INTO valid_payload
  FROM public.step1_replay_payloads WHERE name = 'valid';
  BEGIN
    PERFORM public.resolve_extraction_step1_source(jsonb_build_object(
      'organization_id', '10000000-0000-0000-0000-000000000001',
      'source_document_id', '20000000-0000-0000-0000-000000000001',
      'source_sha256', repeat('6', 64),
      'storage_object_version', 'step1-object:1',
      'media_type_sniffed', 'application/pdf',
      'byte_length', 200
    ));
    RAISE EXCEPTION 'non-service role resolved a Step 1 source';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(valid_payload);
    RAISE EXCEPTION 'non-service role published a Step 1 snapshot';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    NULL;
  END;
END;
$$;

SET request.jwt.claim.role = 'service_role';
SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    PERFORM public.resolve_extraction_step1_source(jsonb_build_object(
      'organization_id', '10000000-0000-0000-0000-000000000002',
      'source_document_id', '20000000-0000-0000-0000-000000000001',
      'source_sha256', repeat('6', 64),
      'storage_object_version', 'step1-object:mismatched-document',
      'media_type_sniffed', 'application/pdf',
      'byte_length', 200
    ));
    RAISE EXCEPTION 'mismatched organization/document Step 1 source resolved';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT count(*) FROM public.extraction_runs
      WHERE idempotency_key = 'analysis-job:replay-1') <> 1
    OR (SELECT count(*)
        FROM public.extraction_processing_gaps gap
        JOIN public.extraction_runs run ON run.id = gap.extraction_run_id
        WHERE run.idempotency_key = 'analysis-job:replay-1') <> 1
    OR (SELECT count(*)
        FROM public.extraction_snapshots snapshot
        JOIN public.extraction_runs run ON run.id = snapshot.producing_run_id
        WHERE run.idempotency_key = 'analysis-job:replay-1') <> 1
    OR (SELECT count(*) FROM public.document_projection_stamps) <> 1 THEN
    RAISE EXCEPTION 'transactional publisher is not idempotent';
  END IF;

  BEGIN
    UPDATE public.extraction_runs SET initial_status = 'failed';
    RAISE EXCEPTION 'append-only UPDATE unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
  BEGIN
    DELETE FROM public.extraction_processing_gaps;
    RAISE EXCEPTION 'append-only DELETE unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '55000' THEN
    NULL;
  END;
END;
$$;

BEGIN;
INSERT INTO public.extraction_page_artifacts (
  id, organization_id, extraction_run_id, source_artifact_id, source_document_id,
  source_sha256, parser_manifest_hash, page, width, height, rotation_degrees,
  render_sha256, parser, status
) SELECT
  '30000000-0000-0000-0000-000000000001', organization_id, id, source_artifact_id,
  '20000000-0000-0000-0000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  parser_manifest_hash, 1, 100, 100, 0,
  '3333333333333333333333333333333333333333333333333333333333333333',
  '{"stage":"native_text","name":"test","version":"1","configuration_hash":"4444444444444444444444444444444444444444444444444444444444444444"}',
  'processed'
FROM public.extraction_runs WHERE idempotency_key = 'analysis-job:replay-1';
INSERT INTO public.extraction_fragment_artifacts (
  id, organization_id, extraction_run_id, source_artifact_id, page_artifact_id,
  source_document_id, source_sha256, parser_manifest_hash, kind, page,
  bbox_x0, bbox_y0, bbox_x1, bbox_y1, raw_text, parser, reading_order
) SELECT
  '30000000-0000-0000-0000-000000000002', organization_id, id, source_artifact_id,
  '30000000-0000-0000-0000-000000000001',
  '20000000-0000-0000-0000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  parser_manifest_hash, 'token', 1, 0.1, 0.1, 0.2, 0.2, '123',
  '{"stage":"native_text","name":"test","version":"1","configuration_hash":"4444444444444444444444444444444444444444444444444444444444444444"}',
  1
FROM public.extraction_runs WHERE idempotency_key = 'analysis-job:replay-1';
INSERT INTO public.extraction_field_candidates (
  id, organization_id, extraction_run_id, source_artifact_id, source_document_id,
  source_sha256, parser_manifest_hash, raw_text, primitive_kind, proposed_value,
  parser, confidence, status
) SELECT
  '30000000-0000-0000-0000-000000000003', organization_id, id, source_artifact_id,
  '20000000-0000-0000-0000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  parser_manifest_hash, '123', 'text', '{"type":"text","value":"123"}',
  '{"stage":"primitive_parse","name":"test","version":"1","configuration_hash":"4444444444444444444444444444444444444444444444444444444444444444"}',
  '{}', 'candidate'
FROM public.extraction_runs WHERE idempotency_key = 'analysis-job:replay-1';
INSERT INTO public.extraction_field_candidate_sources (
  organization_id, extraction_run_id, field_candidate_id, fragment_artifact_id, sequence
) SELECT organization_id, id,
  '30000000-0000-0000-0000-000000000003',
  '30000000-0000-0000-0000-000000000002', 1
FROM public.extraction_runs WHERE idempotency_key = 'analysis-job:replay-1';
INSERT INTO public.extraction_verified_fields (
  id, organization_id, extraction_run_id, source_artifact_id, source_document_id,
  source_sha256, parser_manifest_hash, candidate_id, raw_text, normalized_value,
  verifier, confidence
) SELECT
  '30000000-0000-0000-0000-000000000004', organization_id, id, source_artifact_id,
  '20000000-0000-0000-0000-000000000001',
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  parser_manifest_hash, '30000000-0000-0000-0000-000000000003', '123',
  '{"type":"text","value":"123"}',
  '{"stage":"field_verification","name":"test","version":"1","configuration_hash":"4444444444444444444444444444444444444444444444444444444444444444"}',
  '{}'
FROM public.extraction_runs WHERE idempotency_key = 'analysis-job:replay-1';
INSERT INTO public.extraction_verified_field_sources (
  organization_id, extraction_run_id, verified_field_id, fragment_artifact_id, sequence
) SELECT organization_id, id,
  '30000000-0000-0000-0000-000000000004',
  '30000000-0000-0000-0000-000000000002', 1
FROM public.extraction_runs WHERE idempotency_key = 'analysis-job:replay-1';
COMMIT;

DO $$
DECLARE
  run_row public.extraction_runs%ROWTYPE;
  snapshot_id uuid;
BEGIN
  SELECT * INTO run_row FROM public.extraction_runs
    WHERE idempotency_key = 'analysis-job:replay-1';
  SELECT id INTO snapshot_id FROM public.extraction_snapshots
    WHERE producing_run_id = run_row.id;
  BEGIN
    INSERT INTO public.extraction_verified_fields (
      id, organization_id, extraction_run_id, source_artifact_id, source_document_id,
      source_sha256, parser_manifest_hash, candidate_id, raw_text, normalized_value,
      verifier, confidence
    ) VALUES (
      '30000000-0000-0000-0000-000000000005',
      run_row.organization_id, run_row.id, run_row.source_artifact_id,
      '20000000-0000-0000-0000-000000000001',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      run_row.parser_manifest_hash,
      '30000000-0000-0000-0000-000000000003', '123',
      '{"type":"text","value":"replacement"}',
      '{"stage":"field_verification","name":"test","version":"1","configuration_hash":"4444444444444444444444444444444444444444444444444444444444444444"}',
      '{}'
    );
    RAISE EXCEPTION 'verified-field replacement value unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.canonical_document_facts (
      organization_id, source_document_id, extraction_snapshot_id,
      extraction_run_id, fact_key, normalized_value, primary_verified_field_id,
      interpretation_rule_id, interpretation_rule_version, confidence
    ) VALUES (
      run_row.organization_id, '20000000-0000-0000-0000-000000000001',
      snapshot_id, run_row.id, 'amount',
      '{"type":"text","value":"replacement"}',
      '30000000-0000-0000-0000-000000000004', 'rule', '1', '{}'
    );
    RAISE EXCEPTION 'canonical replacement value unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  BEGIN
    INSERT INTO public.canonical_document_facts (
      id, organization_id, source_document_id, extraction_snapshot_id,
      extraction_run_id, fact_key, normalized_value, primary_verified_field_id,
      interpretation_rule_id, interpretation_rule_version, confidence
    ) VALUES (
      '30000000-0000-0000-0000-000000000006',
      run_row.organization_id, '20000000-0000-0000-0000-000000000001',
      snapshot_id, run_row.id, 'amount',
      '{"type":"text","value":"123"}',
      '30000000-0000-0000-0000-000000000004', 'rule', '1', '{}'
    );
    INSERT INTO public.canonical_document_fact_sources (
      organization_id, canonical_fact_id, extraction_run_id,
      verified_field_id, is_primary, sequence
    ) VALUES (
      run_row.organization_id, '30000000-0000-0000-0000-000000000006',
      run_row.id, '30000000-0000-0000-0000-000000000004', true, 1
    );
    SET CONSTRAINTS trg_canonical_document_facts_closure IMMEDIATE;
    RAISE EXCEPTION 'canonical snapshot-closure bypass unexpectedly succeeded';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
END;
$$;

INSERT INTO public.documents (id, organization_id, name, storage_path)
VALUES (
  '20000000-0000-0000-0000-000000000002',
  '10000000-0000-0000-0000-000000000002',
  'other.pdf', 'step0/other.pdf'
);
INSERT INTO public.extraction_source_artifacts (
  organization_id, source_document_id, source_sha256, storage_object_version,
  media_type_sniffed, byte_length
) VALUES (
  '10000000-0000-0000-0000-000000000002',
  '20000000-0000-0000-0000-000000000002',
  '5555555555555555555555555555555555555555555555555555555555555555',
  'other-object:1', 'application/pdf', 1
);
INSERT INTO auth.users (id, email)
VALUES
  ('60000000-0000-0000-0000-000000000001', 'step0@example.test'),
  ('60000000-0000-0000-0000-000000000002', 'step0-other@example.test');
INSERT INTO public.user_profiles (id, organization_id)
VALUES
  (
    '60000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001'
  ),
  (
    '60000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000002'
  );
SET request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT auth.uid() AS rls_test_user, public.get_current_user_org_id() AS rls_test_org;
SELECT organization_id AS visible_source_org
FROM public.extraction_source_artifacts
ORDER BY organization_id;
SELECT 1 / CASE WHEN count(*) >= 1
  AND count(DISTINCT organization_id) = 1
  AND min(organization_id::text) = '10000000-0000-0000-0000-000000000001'
  THEN 1 ELSE 0 END AS tenant_rls_ok
FROM public.extraction_source_artifacts;
DO $$
DECLARE table_name text; visible_count integer;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_table_continuation_links',
    'extraction_table_continuation_link_basis_fragments',
    'extraction_table_chains', 'extraction_table_chain_segments',
    'extraction_table_chain_links', 'extraction_table_chain_gaps',
    'extraction_table_sections', 'extraction_table_section_rows',
    'extraction_table_section_child_chains',
    'extraction_arbitration_decisions',
    'extraction_arbitration_decision_candidates',
    'semantic_column_mappings', 'semantic_column_mapping_fields',
    'extraction_step3_publication_receipts'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', table_name)
      INTO visible_count;
    IF visible_count = 0 THEN
      RAISE EXCEPTION 'own-organization RLS hid all Step 3 rows from %', table_name;
    END IF;
  END LOOP;
END;
$$;
RESET ROLE;
SET request.jwt.claim.sub = '60000000-0000-0000-0000-000000000002';
SET ROLE authenticated;
DO $$
DECLARE table_name text; visible_count integer;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_table_continuation_links',
    'extraction_table_continuation_link_basis_fragments',
    'extraction_table_chains', 'extraction_table_chain_segments',
    'extraction_table_chain_links', 'extraction_table_chain_gaps',
    'extraction_table_sections', 'extraction_table_section_rows',
    'extraction_table_section_child_chains',
    'extraction_arbitration_decisions',
    'extraction_arbitration_decision_candidates',
    'semantic_column_mappings', 'semantic_column_mapping_fields',
    'extraction_step3_publication_receipts'
  ] LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', table_name)
      INTO visible_count;
    IF visible_count <> 0 THEN
      RAISE EXCEPTION 'cross-organization RLS exposed Step 3 rows from %', table_name;
    END IF;
  END LOOP;
END;
$$;
RESET ROLE;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_table_continuation_links',
    'extraction_table_continuation_link_basis_fragments',
    'extraction_table_chains', 'extraction_table_chain_segments',
    'extraction_table_chain_links', 'extraction_table_chain_gaps',
    'extraction_table_sections', 'extraction_table_section_rows',
    'extraction_table_section_child_chains',
    'extraction_arbitration_decisions',
    'extraction_arbitration_decision_candidates',
    'semantic_column_mappings', 'semantic_column_mapping_fields',
    'extraction_step3_publication_receipts'
  ] LOOP
    BEGIN
      EXECUTE format(
        'UPDATE public.%I SET organization_id = organization_id WHERE true',
        table_name
      );
      RAISE EXCEPTION 'append-only UPDATE unexpectedly succeeded on %', table_name;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      NULL;
    END;
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE true', table_name);
      RAISE EXCEPTION 'append-only DELETE unexpectedly succeeded on %', table_name;
    EXCEPTION WHEN SQLSTATE '55000' THEN
      NULL;
    END;
  END LOOP;
END;
$$;

SET ROLE service_role;
DO $$
BEGIN
  BEGIN
    EXECUTE 'TRUNCATE TABLE public.extraction_runs CASCADE';
    RAISE EXCEPTION 'service_role TRUNCATE unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END;
$$;
RESET ROLE;

DO $$
DECLARE
  table_name text;
BEGIN
  IF has_table_privilege(
    'service_role',
    'public.document_extraction_snapshot_assignments',
    'INSERT'
  ) OR has_table_privilege(
    'service_role',
    'public.document_extraction_snapshot_assignments',
    'UPDATE'
  ) THEN
    RAISE EXCEPTION 'service_role retains direct assignment write privileges';
  END IF;
  IF NOT has_table_privilege(
    'service_role',
    'public.document_extraction_snapshot_assignments',
    'SELECT'
  ) THEN
    RAISE EXCEPTION 'service_role lost assignment read privilege';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.publish_extraction_compliance_shadow(jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role lost shadow publisher execute privilege';
  END IF;
  IF NOT has_function_privilege(
    'service_role',
    'public.resolve_extraction_step1_source(jsonb)',
    'EXECUTE'
  ) OR NOT has_function_privilege(
    'service_role',
    'public.publish_extraction_step1_shadow(jsonb)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION 'service_role lost Step 1 RPC execute privilege';
  END IF;
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_source_artifacts',
    'extraction_runs',
    'extraction_run_states',
    'extraction_page_artifacts',
    'extraction_fragment_artifacts',
    'extraction_fragment_dependencies',
    'extraction_field_candidates',
    'extraction_field_candidate_sources',
    'extraction_verified_fields',
    'extraction_verified_field_sources',
    'extraction_processing_gaps',
    'extraction_gap_sources',
    'extraction_snapshots',
    'extraction_snapshot_members',
    'document_extraction_snapshot_assignments',
    'extraction_table_continuation_links',
    'extraction_table_continuation_link_basis_fragments',
    'extraction_table_chains',
    'extraction_table_chain_segments',
    'extraction_table_chain_links',
    'extraction_table_chain_gaps',
    'extraction_table_sections',
    'extraction_table_section_rows',
    'extraction_table_section_child_chains',
    'extraction_arbitration_decisions',
    'extraction_arbitration_decision_candidates',
    'semantic_column_mappings',
    'semantic_column_mapping_fields',
    'extraction_step3_publication_receipts'
  ] LOOP
    IF has_table_privilege(
      'service_role',
      format('public.%I', table_name),
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
      RAISE EXCEPTION 'service_role retains direct write privilege on %', table_name;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'extraction_table_continuation_links',
    'extraction_table_continuation_link_basis_fragments',
    'extraction_table_chains',
    'extraction_table_chain_segments',
    'extraction_table_chain_links',
    'extraction_table_chain_gaps',
    'extraction_table_sections',
    'extraction_table_section_rows',
    'extraction_table_section_child_chains',
    'extraction_arbitration_decisions',
    'extraction_arbitration_decision_candidates',
    'semantic_column_mappings',
    'semantic_column_mapping_fields',
    'extraction_step3_publication_receipts'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = table_name
        AND relation.relrowsecurity
    ) THEN
      RAISE EXCEPTION 'Step 3 table % is missing RLS', table_name;
    END IF;
    IF has_table_privilege(
      'service_role', format('public.%I', table_name),
      'INSERT,UPDATE,DELETE,TRUNCATE'
    ) THEN
      RAISE EXCEPTION 'service_role retains direct Step 3 write privilege on %',
        table_name;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger trigger_row
      JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = table_name
        AND trigger_row.tgname = left(
          'trg_' || table_name || '_append_only',
          63
        )
        AND NOT trigger_row.tgisinternal
    ) THEN
      RAISE EXCEPTION 'Step 3 table % is missing append-only enforcement',
        table_name;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'document_interpretation_records_mapping_fkey'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'extraction_snapshot_members_chain_fkey'
  ) THEN
    RAISE EXCEPTION 'Step 3 interpretation/snapshot closure constraints are missing';
  END IF;

  IF position(
    'semantic_column_mapping'
    IN pg_get_constraintdef((
      SELECT oid FROM pg_constraint
      WHERE conname = 'document_interpretation_records_type_check'
    ))
  ) = 0 THEN
    RAISE EXCEPTION 'semantic column mapping record type was not installed';
  END IF;
END;
$$;

SET request.jwt.claim.role = 'service_role';
DO $$
DECLARE
  valid_payload jsonb;
  divergent_payload jsonb;
BEGIN
  SELECT payload INTO valid_payload
  FROM public.step1_replay_payloads
  WHERE name = 'valid';
  divergent_payload := jsonb_set(
    valid_payload,
    '{table_chains}',
    jsonb_build_array(jsonb_build_object(
      'id', '7f000000-0000-0000-0000-000000000001',
      'completeness', 'complete'
    ))
  );
  BEGIN
    PERFORM public.publish_extraction_step1_shadow(divergent_payload);
    RAISE EXCEPTION 'divergent Step 3 table content unexpectedly reused an idempotency key';
  EXCEPTION WHEN SQLSTATE '23514' THEN
    NULL;
  END;
  IF EXISTS (
    SELECT 1
    FROM public.extraction_table_chains
    WHERE id = '7f000000-0000-0000-0000-000000000001'
  ) THEN
    RAISE EXCEPTION 'divergent Step 3 publication left a partial table chain';
  END IF;
END;
$$;
DO $$
DECLARE
  base_payload jsonb;
  identical_payload jsonb;
  divergent_a jsonb;
  divergent_b jsonb;
BEGIN
  SELECT payload INTO base_payload
  FROM public.step1_replay_payloads
  WHERE name = 'step3_valid_nonempty';

  identical_payload := replace(
    base_payload::text, '7d000000-', '7e000000-'
  )::jsonb || jsonb_build_object(
    'parser_manifest', jsonb_build_object(
      'artifact_schema_version', 'extraction-artifact-v1',
      'step', 'phase3-step3-concurrent-identical'
    ),
    'parser_manifest_hash', repeat('a', 63) || '1',
    'idempotency_key', 'step3:concurrent:identical',
    'content_extraction_fingerprint', repeat('b', 64),
    'artifact_root_hash', repeat('c', 64)
  );
  divergent_a := replace(
    base_payload::text, '7d000000-', '7f000000-'
  )::jsonb || jsonb_build_object(
    'parser_manifest', jsonb_build_object(
      'artifact_schema_version', 'extraction-artifact-v1',
      'step', 'phase3-step3-concurrent-divergent'
    ),
    'parser_manifest_hash', repeat('d', 63) || '2',
    'idempotency_key', 'step3:concurrent:divergent',
    'content_extraction_fingerprint', repeat('e', 64),
    'artifact_root_hash', repeat('f', 64)
  );
  divergent_b := jsonb_set(
    divergent_a,
    '{table_chains,0,completeness}',
    '"ambiguous"'::jsonb
  );
  INSERT INTO public.step1_replay_payloads(name, payload) VALUES
    ('step3_concurrent_identical', identical_payload),
    ('step3_divergent_a', divergent_a),
    ('step3_divergent_b', divergent_b);
END;
$$;
SQL

concurrent_step1_sql=$'SET request.jwt.claim.role = \'service_role\';\nSELECT public.publish_extraction_step1_shadow(payload) FROM public.step1_replay_payloads WHERE name = \'valid\';'
"${psql[@]}" --command "${concurrent_step1_sql}" >/dev/null &
step1_pid_one=$!
"${psql[@]}" --command "${concurrent_step1_sql}" >/dev/null &
step1_pid_two=$!
wait "${step1_pid_one}"
wait "${step1_pid_two}"
concurrent_step3_identical_sql=$'SET request.jwt.claim.role = \'service_role\';\nSELECT public.publish_extraction_step1_shadow(payload) FROM public.step1_replay_payloads WHERE name = \'step3_concurrent_identical\';'
"${psql[@]}" --command "${concurrent_step3_identical_sql}" >/dev/null &
step3_identical_pid_one=$!
"${psql[@]}" --command "${concurrent_step3_identical_sql}" >/dev/null &
step3_identical_pid_two=$!
wait "${step3_identical_pid_one}"
wait "${step3_identical_pid_two}"
set +e
concurrent_step3_a_sql=$'SET request.jwt.claim.role = \'service_role\';\nSELECT public.publish_extraction_step1_shadow(payload) FROM public.step1_replay_payloads WHERE name = \'step3_divergent_a\';'
concurrent_step3_b_sql=$'SET request.jwt.claim.role = \'service_role\';\nSELECT public.publish_extraction_step1_shadow(payload) FROM public.step1_replay_payloads WHERE name = \'step3_divergent_b\';'
"${psql[@]}" --command "${concurrent_step3_a_sql}" >/dev/null 2>&1 &
step3_pid_one=$!
"${psql[@]}" --command "${concurrent_step3_b_sql}" >/dev/null 2>&1 &
step3_pid_two=$!
wait "${step3_pid_one}"
step3_status_one=$?
wait "${step3_pid_two}"
step3_status_two=$?
set -e
if [[ "${step3_status_one}" -eq "${step3_status_two}" ]]; then
  echo "DATABASE STEP3 CONCURRENT DIVERGENCE: FAILED (expected one winner and one safe rejection)"
  exit 1
fi
"${psql[@]}" --command "DO \$\$ BEGIN
  IF (SELECT count(*) FROM public.extraction_runs
      WHERE idempotency_key = 'step3:concurrent:divergent') <> 1
    OR (SELECT count(*) FROM public.extraction_step3_publication_receipts
        WHERE extraction_run_id =
          '7f000000-0000-0000-0000-000000000010') <> 1
    OR (SELECT count(*) FROM public.extraction_table_chains
        WHERE extraction_run_id =
          '7f000000-0000-0000-0000-000000000010') <> 2 THEN
    RAISE EXCEPTION 'concurrent divergent Step 3 publication did not converge atomically';
  END IF;
END \$\$;" >/dev/null
"${psql[@]}" --command "DROP TABLE public.step1_replay_payloads" >/dev/null

echo "FRESH REPLAY: PASS (${#migrations[@]} migrations)"
echo "DATABASE APPEND-ONLY / IDEMPOTENCY: PASS"
echo "DATABASE VERIFIED/CANONICAL ANTI-CAST / SNAPSHOT CLOSURE / TENANT RLS: PASS"
echo "DATABASE SERVICE-ROLE RPC-ONLY WRITE / TRUNCATE REJECTION: PASS"
echo "DATABASE STEP1 SHADOW IDEMPOTENCY / DIVERGENCE / ATOMICITY: PASS"
echo "DATABASE STEP1 CONCURRENT RETRY CONVERGENCE: PASS"
echo "DATABASE STEP3 TABLE ARTIFACT RLS / APPEND-ONLY / RPC-ONLY SCHEMA: PASS"
echo "DATABASE STEP3 SEMANTIC DIVERGENCE / ATOMIC ROLLBACK: PASS"
echo "DATABASE STEP3 CONCURRENT DIVERGENCE / PARTIAL-ROW REJECTION: PASS"
