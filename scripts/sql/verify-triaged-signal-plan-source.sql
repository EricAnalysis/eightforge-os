\set ON_ERROR_STOP on

-- B8.3d: a human-triaged improvement signal as a Plan V2 source, beside the
-- reviewed workflow assessment. Generic, disposable fixtures only. Every check
-- raises on failure, so ON_ERROR_STOP fails the replay. Runs after the Phase
-- 11E plan, review and job verifications, whose Plan V2 fixture it reuses.

INSERT INTO public.organizations (id, name) VALUES
  ('b8d00000-0000-4000-8000-000000000001', 'B8.3d regression organization');
INSERT INTO auth.users (id) VALUES ('b8d00000-0000-4000-8000-0000000000a1');
INSERT INTO public.user_profiles (id, organization_id) VALUES
  ('b8d00000-0000-4000-8000-0000000000a1', 'b8d00000-0000-4000-8000-000000000001');

-- Two submissions: one stays current, one is superseded later.
INSERT INTO public.improvement_signal_submissions (
  id, organization_id, signal_kind, signal_code, payload, payload_digest_sha256, read_bounds, submitted_by
)
SELECT ('b8d00000-0000-4000-8000-0000000000' || suffix)::uuid,
  'b8d00000-0000-4000-8000-000000000001', 'recurring_deterministic_failure', 'unrecognized_reason',
  jsonb_build_object('schemaVersion', 'friction_signal_v1', 'signalKind', 'recurring_deterministic_failure',
    'code', 'unrecognized_reason', 'catalogueFingerprint', NULL,
    'counts', jsonb_build_object('occurrences', 3, 'documents', 2, 'projects', 1),
    'recordRefs', jsonb_build_array('document:b8d00000-0000-4000-8000-0000000000f' || suffix),
    'rootCauseCategory', 'extraction_issue', 'defectClass', NULL),
  repeat(suffix, 32), '{}'::jsonb, 'b8d00000-0000-4000-8000-0000000000a1'
FROM unnest(ARRAY['b1', 'b2']) AS suffix;

CREATE TEMP TABLE b83d_state (name text PRIMARY KEY, value text);
GRANT ALL ON b83d_state TO service_role, forgewing_engineering_worker;
-- The fixture plan's guidance names no classification; the B8.3d plans below
-- carry RULE, as every real Plan V2 guidance names its classification.
INSERT INTO b83d_state VALUES ('classification', 'RULE');
INSERT INTO b83d_state
SELECT 'plan_v1', implementation_plan_v1_digest_sha256
FROM public.workflow_repository_plan_v2_runs
WHERE repository_commit_sha = repeat('a', 40) AND guidance_input_digest_sha256 = repeat('6', 64);

-- 1. Triage: plan_classification is required exactly for route_to_engineering.
DO $b83d_triage_invariant$
DECLARE
  v_class text := (SELECT value FROM b83d_state WHERE name = 'classification');
BEGIN
  BEGIN
    INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
      triage_version, disposition, capability_scope, rationale, reviewer_actor_id)
    VALUES (gen_random_uuid(), 'b8d00000-0000-4000-8000-0000000000b1', 'b8d00000-0000-4000-8000-000000000001',
      'recurring_deterministic_failure', 1, 'route_to_engineering', 'reusable_platform_capability', 'x',
      'b8d00000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'route_to_engineering without plan_classification unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
      triage_version, disposition, plan_classification, rationale, reviewer_actor_id)
    VALUES (gen_random_uuid(), 'b8d00000-0000-4000-8000-0000000000b1', 'b8d00000-0000-4000-8000-000000000001',
      'recurring_deterministic_failure', 1, 'reject', 'RULE', 'x', 'b8d00000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'reject with plan_classification unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
      triage_version, disposition, capability_scope, plan_classification, rationale, reviewer_actor_id)
    VALUES (gen_random_uuid(), 'b8d00000-0000-4000-8000-0000000000b1', 'b8d00000-0000-4000-8000-000000000001',
      'recurring_deterministic_failure', 1, 'customer_config_or_mapping', 'client_specific', 'EXTRACT', 'x',
      'b8d00000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'customer_config_or_mapping with plan_classification unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
      triage_version, disposition, capability_scope, plan_classification, rationale, reviewer_actor_id)
    VALUES (gen_random_uuid(), 'b8d00000-0000-4000-8000-0000000000b1', 'b8d00000-0000-4000-8000-000000000001',
      'recurring_deterministic_failure', 1, 'route_to_engineering', 'workflow_specific', 'BUILD', 'x',
      'b8d00000-0000-4000-8000-0000000000a1');
    RAISE EXCEPTION 'unknown plan_classification unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- Current, routed triage under the fixture plan's classification.
  INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
    triage_version, disposition, capability_scope, plan_classification, rationale, reviewer_actor_id)
  VALUES ('b8d00000-0000-4000-8000-0000000000c1', 'b8d00000-0000-4000-8000-0000000000b1',
    'b8d00000-0000-4000-8000-000000000001', 'recurring_deterministic_failure', 1, 'route_to_engineering',
    'reusable_platform_capability', v_class, 'PLATFORM-LOCAL RATIONALE MARKER',
    'b8d00000-0000-4000-8000-0000000000a1');
  -- Routed under the fixture classification, then superseded by a rejection.
  INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
    triage_version, disposition, capability_scope, plan_classification, rationale, reviewer_actor_id)
  VALUES ('b8d00000-0000-4000-8000-0000000000c2', 'b8d00000-0000-4000-8000-0000000000b2',
    'b8d00000-0000-4000-8000-000000000001', 'recurring_deterministic_failure', 1, 'route_to_engineering',
    'workflow_specific', v_class, 'x', 'b8d00000-0000-4000-8000-0000000000a1');
END
$b83d_triage_invariant$;

-- 2. Catalog posture and ACL of the new RPCs.
DO $b83d_catalog$
DECLARE
  v_create regprocedure :=
    'public.create_workflow_repository_plan_generation_job_from_triage(uuid,integer,text,uuid,text)'::regprocedure;
  v_source regprocedure :=
    'public.read_workflow_repository_plan_generation_signal_source(uuid,uuid)'::regprocedure;
  v_function regprocedure;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[v_create, v_source] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid = v_function::oid AND procedure.prosecdef AND owner_role.rolname = 'postgres'
        AND procedure.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]) THEN
      RAISE EXCEPTION 'B8.3d RPC catalog posture drift on %', v_function;
    END IF;
    IF has_function_privilege('anon', v_function, 'EXECUTE')
      OR has_function_privilege('authenticated', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'B8.3d RPC ACL drift on %', v_function;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('service_role', v_create, 'EXECUTE')
    OR has_function_privilege('forgewing_engineering_worker', v_create, 'EXECUTE')
    OR NOT has_function_privilege('forgewing_engineering_worker', v_source, 'EXECUTE')
    OR has_function_privilege('service_role', v_source, 'EXECUTE') THEN
    RAISE EXCEPTION 'B8.3d RPC role separation drift';
  END IF;
END
$b83d_catalog$;

-- 3. Queue from triage: exact, current, routed, same classification only.
SET ROLE service_role;
DO $b83d_create_negatives$
DECLARE
  v_class text := (SELECT value FROM b83d_state WHERE name = 'classification');
  v_plan_v1 text := (SELECT value FROM b83d_state WHERE name = 'plan_v1');
  v_other text := CASE WHEN v_class = 'ADVISORY' THEN 'RULE' ELSE 'ADVISORY' END;
BEGIN
  BEGIN
    PERFORM * FROM public.create_workflow_repository_plan_generation_job_from_triage(
      'b8d00000-0000-4000-8000-0000000000c1', 1, v_other, 'b8d00000-0000-4000-8000-0000000000a1', v_plan_v1);
    RAISE EXCEPTION 'job queued under a classification the human did not choose';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.create_workflow_repository_plan_generation_job_from_triage(
      'b8d00000-0000-4000-8000-0000000000c1', 2, v_class, 'b8d00000-0000-4000-8000-0000000000a1', v_plan_v1);
    RAISE EXCEPTION 'job queued from a nonexistent triage version';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END
$b83d_create_negatives$;

INSERT INTO b83d_state
SELECT 'job', job_id::text FROM public.create_workflow_repository_plan_generation_job_from_triage(
  'b8d00000-0000-4000-8000-0000000000c1', 1, (SELECT value FROM b83d_state WHERE name = 'classification'),
  'b8d00000-0000-4000-8000-0000000000a1', (SELECT value FROM b83d_state WHERE name = 'plan_v1'));
INSERT INTO b83d_state
SELECT 'stale_job', job_id::text FROM public.create_workflow_repository_plan_generation_job_from_triage(
  'b8d00000-0000-4000-8000-0000000000c2', 1, (SELECT value FROM b83d_state WHERE name = 'classification'),
  'b8d00000-0000-4000-8000-0000000000a1', (SELECT value FROM b83d_state WHERE name = 'plan_v1'));
RESET ROLE;

-- Supersede c2 with a rejection: no new job, and the queued one loses its source.
INSERT INTO public.improvement_signal_triage_reviews (id, submission_id, organization_id, signal_kind,
  triage_version, disposition, rationale, reviewer_actor_id)
VALUES ('b8d00000-0000-4000-8000-0000000000c3', 'b8d00000-0000-4000-8000-0000000000b2',
  'b8d00000-0000-4000-8000-000000000001', 'recurring_deterministic_failure', 2, 'reject', 'x',
  'b8d00000-0000-4000-8000-0000000000a1');

SET ROLE service_role;
DO $b83d_create_superseded$
BEGIN
  BEGIN
    PERFORM * FROM public.create_workflow_repository_plan_generation_job_from_triage(
      'b8d00000-0000-4000-8000-0000000000c2', 1, (SELECT value FROM b83d_state WHERE name = 'classification'),
      'b8d00000-0000-4000-8000-0000000000a1', (SELECT value FROM b83d_state WHERE name = 'plan_v1'));
    RAISE EXCEPTION 'job queued from a superseded triage';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.create_workflow_repository_plan_generation_job_from_triage(
      'b8d00000-0000-4000-8000-0000000000c3', 2, 'RULE',
      'b8d00000-0000-4000-8000-0000000000a1', (SELECT value FROM b83d_state WHERE name = 'plan_v1'));
    RAISE EXCEPTION 'job queued from a rejected triage';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$b83d_create_superseded$;
RESET ROLE;

-- 4. Exactly one source per job, and the identity guard is NULL-safe.
DO $b83d_job_source_kind$
DECLARE
  v_job uuid := (SELECT value::uuid FROM b83d_state WHERE name = 'job');
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_repository_plan_generation_jobs
      WHERE id = v_job AND assessment_id IS NULL AND review_id IS NULL
        AND triage_review_id = 'b8d00000-0000-4000-8000-0000000000c1' AND triage_version = 1
        AND status = 'pending') THEN
    RAISE EXCEPTION 'triage job did not persist its triage pin alone';
  END IF;
  BEGIN
    INSERT INTO public.workflow_repository_plan_generation_jobs (classification, requested_by_actor_id,
      implementation_plan_v1_digest_sha256)
    VALUES ('RULE', 'b8d00000-0000-4000-8000-0000000000a1', repeat('a', 64));
    RAISE EXCEPTION 'job without any source unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.workflow_repository_plan_generation_jobs (assessment_id, assessment_version,
      review_id, review_version, triage_review_id, triage_version, classification, requested_by_actor_id,
      implementation_plan_v1_digest_sha256)
    SELECT assessment_id, assessment_version, review_id, review_version,
      'b8d00000-0000-4000-8000-0000000000c1', 1, classification, requested_by_actor_id,
      implementation_plan_v1_digest_sha256
    FROM public.workflow_repository_plan_generation_jobs WHERE assessment_id IS NOT NULL LIMIT 1;
    RAISE EXCEPTION 'job with two sources unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE public.workflow_repository_plan_generation_jobs
    SET assessment_id = '93000000-0000-4000-8000-000000000130' WHERE id = v_job;
    RAISE EXCEPTION 'NULL assessment pin on a triage job was rewritten';
  EXCEPTION WHEN raise_exception THEN NULL;
  END;
  BEGIN
    UPDATE public.workflow_repository_plan_generation_jobs
    SET triage_version = 2 WHERE id = v_job;
    RAISE EXCEPTION 'triage pin on a job was rewritten';
  EXCEPTION WHEN raise_exception OR foreign_key_violation THEN NULL;
  END;
END
$b83d_job_source_kind$;

-- 5. Worker source read: allowlisted rows only, no rationale, none once superseded.
UPDATE public.workflow_repository_plan_generation_jobs
SET status = 'claimed', claim_token = gen_random_uuid(), claim_generation = 1, claimed_at = clock_timestamp()
WHERE id IN (SELECT value::uuid FROM b83d_state WHERE name IN ('job', 'stale_job'));
INSERT INTO b83d_state
SELECT CASE WHEN id = (SELECT value::uuid FROM b83d_state WHERE name = 'job') THEN 'token' ELSE 'stale_token' END,
  claim_token::text
FROM public.workflow_repository_plan_generation_jobs
WHERE id IN (SELECT value::uuid FROM b83d_state WHERE name IN ('job', 'stale_job'));

SET ROLE forgewing_engineering_worker;
DO $b83d_signal_source$
DECLARE
  v_row record;
  v_count integer;
  v_assessment_job uuid;
  v_assessment_token uuid;
BEGIN
  SELECT * INTO STRICT v_row FROM public.read_workflow_repository_plan_generation_signal_source(
    (SELECT value::uuid FROM b83d_state WHERE name = 'job'),
    (SELECT value::uuid FROM b83d_state WHERE name = 'token'));
  IF v_row.triage_row ->> 'plan_classification' IS DISTINCT FROM (SELECT value FROM b83d_state WHERE name = 'classification')
    OR v_row.triage_row ->> 'disposition' IS DISTINCT FROM 'route_to_engineering'
    OR v_row.submission_row #>> '{payload,schemaVersion}' IS DISTINCT FROM 'friction_signal_v1' THEN
    RAISE EXCEPTION 'signal source read returned the wrong rows';
  END IF;
  IF v_row.triage_row ? 'rationale' OR v_row.triage_row ? 'reviewer_actor_id'
    OR v_row.triage_row ? 'organization_id' OR v_row.submission_row ? 'organization_id'
    OR v_row.submission_row ? 'submitted_by' OR v_row.submission_row ? 'read_bounds'
    OR (v_row.triage_row::text || v_row.submission_row::text) LIKE '%RATIONALE MARKER%' THEN
    RAISE EXCEPTION 'signal source read exposed a non-allowlisted field';
  END IF;

  SELECT count(*) INTO v_count FROM public.read_workflow_repository_plan_generation_signal_source(
    (SELECT value::uuid FROM b83d_state WHERE name = 'stale_job'),
    (SELECT value::uuid FROM b83d_state WHERE name = 'stale_token'));
  IF v_count <> 0 THEN RAISE EXCEPTION 'superseded triage still readable as a planning source'; END IF;

  BEGIN
    PERFORM * FROM public.read_workflow_repository_plan_generation_signal_source(
      (SELECT value::uuid FROM b83d_state WHERE name = 'job'), gen_random_uuid());
    RAISE EXCEPTION 'signal source read without the claim token';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END
$b83d_signal_source$;
RESET ROLE;

-- An assessment job has no signal source.
DO $b83d_assessment_job_no_signal$
DECLARE
  v_job uuid;
  v_token uuid;
  v_count integer;
BEGIN
  SELECT id, claim_token INTO v_job, v_token FROM public.workflow_repository_plan_generation_jobs
  WHERE assessment_id IS NOT NULL AND status = 'claimed' LIMIT 1;
  IF v_job IS NULL THEN RAISE EXCEPTION 'no claimed assessment job fixture'; END IF;
  SET LOCAL ROLE forgewing_engineering_worker;
  SELECT count(*) INTO v_count FROM public.read_workflow_repository_plan_generation_signal_source(v_job, v_token);
  RESET ROLE;
  IF v_count <> 0 THEN RAISE EXCEPTION 'assessment job returned a signal source'; END IF;
END
$b83d_assessment_job_no_signal$;

-- 6. Plan V2 writer and job completion for a triaged-signal source.
CREATE FUNCTION pg_temp.b83d_plan(p_pin jsonb, OUT full_json text, OUT envelope_json text)
LANGUAGE plpgsql AS $$
DECLARE
  v_env jsonb;
  v_digest text;
BEGIN
  SELECT plan_v2_canonical_json::jsonb - 'digest' INTO STRICT v_env
  FROM public.workflow_repository_plan_v2_runs
  WHERE repository_commit_sha = repeat('a', 40) AND guidance_input_digest_sha256 = repeat('6', 64)
    AND assessment_id IS NOT NULL;
  v_env := jsonb_set(v_env, '{source,reviewPin}', p_pin);
  v_env := jsonb_set(v_env, '{guidance,classification}', to_jsonb((SELECT value FROM b83d_state WHERE name = 'classification')));
  v_env := jsonb_set(v_env, '{providerProvenance,callCount}', '0'::jsonb);
  v_env := jsonb_set(v_env, '{providerProvenance,rawOutputSha256}', 'null'::jsonb);
  v_env := jsonb_set(v_env, '{rawOutputSha256}', 'null'::jsonb);
  v_digest := encode(extensions.digest(convert_to(v_env::text, 'UTF8'), 'sha256'), 'hex');
  envelope_json := v_env::text;
  full_json := (v_env || jsonb_build_object('digest', jsonb_build_object('algorithm', 'sha256',
    'encoding', 'recursive-key-sorted-json-v1', 'value', v_digest)))::text;
END;
$$;

DO $b83d_plan_writer$
DECLARE
  v_good jsonb := '{"sourceKind":"triaged_improvement_signal","submissionId":"b8d00000-0000-4000-8000-0000000000b1","triageReviewId":"b8d00000-0000-4000-8000-0000000000c1","triageVersion":1}';
  v_bad jsonb;
  v_plan record;
  v_run uuid;
BEGIN
  FOREACH v_bad IN ARRAY ARRAY[
    v_good || '{"organizationId":"b8d00000-0000-4000-8000-000000000001"}'::jsonb,
    jsonb_set(v_good, '{sourceKind}', '"reviewed_workflow_assessment"'),
    jsonb_set(v_good, '{triageVersion}', '"1"'),
    jsonb_set(v_good, '{submissionId}', '"b8d00000-0000-4000-8000-0000000000b2"'),
    jsonb_set(v_good, '{triageReviewId}', '"b8d00000-0000-4000-8000-0000000000c3"') || '{"triageVersion":2,"submissionId":"b8d00000-0000-4000-8000-0000000000b2"}'::jsonb
  ] LOOP
    SELECT * INTO v_plan FROM pg_temp.b83d_plan(v_bad);
    BEGIN
      PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL, NULL, v_plan.full_json, v_plan.envelope_json);
      RAISE EXCEPTION 'invalid triaged-signal Plan V2 pin unexpectedly persisted: %', v_bad;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  SELECT * INTO v_plan FROM pg_temp.b83d_plan(v_good);
  SELECT plan_v2_run_id INTO STRICT v_run
  FROM public.record_workflow_repository_plan_v2_run(NULL, NULL, v_plan.full_json, v_plan.envelope_json);
  IF NOT EXISTS (SELECT 1 FROM public.workflow_repository_plan_v2_runs
      WHERE id = v_run AND assessment_id IS NULL AND assessment_version IS NULL
        AND review_id IS NULL AND review_version IS NULL
        AND triage_review_id = 'b8d00000-0000-4000-8000-0000000000c1' AND triage_version = 1) THEN
    RAISE EXCEPTION 'triaged-signal Plan V2 run did not persist its triage pin alone';
  END IF;
  INSERT INTO b83d_state VALUES ('run', v_run::text);

  -- Idempotent replay of the same plan returns the same run.
  IF (SELECT plan_v2_run_id FROM public.record_workflow_repository_plan_v2_run(
      NULL, NULL, v_plan.full_json, v_plan.envelope_json)) IS DISTINCT FROM v_run THEN
    RAISE EXCEPTION 'triaged-signal Plan V2 persistence is not idempotent';
  END IF;

  -- The table binding rejects a triage row whose plan JSON names no source kind.
  BEGIN
    INSERT INTO public.workflow_repository_plan_v2_runs (
      triage_review_id, triage_version, repository_commit_sha, effective_reviewed_specification_digest_sha256,
      implementation_plan_v1_digest_sha256, foundation_digest_sha256, content_bundle_digest_sha256,
      guidance_input_digest_sha256, plan_v2_digest_sha256, plan_v2_canonical_json, plan_v2_envelope_canonical_json)
    SELECT 'b8d00000-0000-4000-8000-0000000000c1', 1, repository_commit_sha,
      effective_reviewed_specification_digest_sha256, implementation_plan_v1_digest_sha256,
      foundation_digest_sha256, content_bundle_digest_sha256, guidance_input_digest_sha256,
      repeat('7', 64), plan_v2_canonical_json, plan_v2_envelope_canonical_json
    FROM public.workflow_repository_plan_v2_runs
    WHERE repository_commit_sha = repeat('a', 40) AND guidance_input_digest_sha256 = repeat('6', 64)
      AND assessment_id IS NOT NULL;
    RAISE EXCEPTION 'triage run bound to an assessment pin unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$b83d_plan_writer$;

INSERT INTO b83d_state
SELECT 'assessment_run', id::text FROM public.workflow_repository_plan_v2_runs
WHERE repository_commit_sha = repeat('a', 40) AND guidance_input_digest_sha256 = repeat('6', 64)
  AND assessment_id IS NOT NULL;

SET ROLE forgewing_engineering_worker;
DO $b83d_succeed$
DECLARE
  v_assessment_run uuid := (SELECT value::uuid FROM b83d_state WHERE name = 'assessment_run');
BEGIN
  -- An assessment run can never complete a triage job.
  BEGIN
    PERFORM public.succeed_workflow_repository_plan_generation_job(
      (SELECT value::uuid FROM b83d_state WHERE name = 'job'),
      (SELECT value::uuid FROM b83d_state WHERE name = 'token'), v_assessment_run);
    RAISE EXCEPTION 'assessment-sourced run completed a triage job';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  PERFORM public.succeed_workflow_repository_plan_generation_job(
    (SELECT value::uuid FROM b83d_state WHERE name = 'job'),
    (SELECT value::uuid FROM b83d_state WHERE name = 'token'),
    (SELECT value::uuid FROM b83d_state WHERE name = 'run'));
END
$b83d_succeed$;
RESET ROLE;

DO $b83d_succeeded$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_repository_plan_generation_jobs
      WHERE id = (SELECT value::uuid FROM b83d_state WHERE name = 'job') AND status = 'succeeded'
        AND plan_v2_run_id = (SELECT value::uuid FROM b83d_state WHERE name = 'run')) THEN
    RAISE EXCEPTION 'triage job did not complete with its own Plan V2 run';
  END IF;
  -- The approved-request path is unchanged: engineering review pins only to the run.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
      WHERE attrelid = 'public.workflow_repository_plan_recommendation_reviews'::regclass
        AND attname IN ('assessment_id', 'triage_review_id') AND NOT attisdropped) THEN
    RAISE EXCEPTION 'engineering review unexpectedly carries a source pin';
  END IF;
END
$b83d_succeeded$;

SELECT 'B8.3D TRIAGED SIGNAL PLAN SOURCE / XOR / HUMAN CLASSIFICATION / ALLOWLISTED SOURCE READ: PASS' AS result;
