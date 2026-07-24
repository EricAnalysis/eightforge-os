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
VALUES ('10000000-0000-0000-0000-000000000001', 'Step 0 replay');
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

DO $$
BEGIN
  IF (SELECT count(*) FROM public.extraction_runs) <> 1
    OR (SELECT count(*) FROM public.extraction_processing_gaps) <> 1
    OR (SELECT count(*) FROM public.extraction_snapshots) <> 1
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

INSERT INTO public.organizations (id, name)
VALUES ('10000000-0000-0000-0000-000000000002', 'Other tenant');
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
VALUES ('60000000-0000-0000-0000-000000000001', 'step0@example.test');
INSERT INTO public.user_profiles (id, organization_id)
VALUES (
  '60000000-0000-0000-0000-000000000001',
  '10000000-0000-0000-0000-000000000001'
);
SET request.jwt.claim.sub = '60000000-0000-0000-0000-000000000001';
SET ROLE authenticated;
SELECT auth.uid() AS rls_test_user, public.get_current_user_org_id() AS rls_test_org;
SELECT organization_id AS visible_source_org
FROM public.extraction_source_artifacts
ORDER BY organization_id;
SELECT 1 / CASE WHEN count(*) = 1 THEN 1 ELSE 0 END AS tenant_rls_ok
FROM public.extraction_source_artifacts;
RESET ROLE;
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
END;
$$;
SQL

echo "FRESH REPLAY: PASS (${#migrations[@]} migrations)"
echo "DATABASE APPEND-ONLY / IDEMPOTENCY: PASS"
echo "DATABASE VERIFIED/CANONICAL ANTI-CAST / SNAPSHOT CLOSURE / TENANT RLS: PASS"
echo "DATABASE SERVICE-ROLE RPC-ONLY WRITE / TRUNCATE REJECTION: PASS"
