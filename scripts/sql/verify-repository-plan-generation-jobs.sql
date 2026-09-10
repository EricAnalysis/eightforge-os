\set ON_ERROR_STOP on

CREATE TEMP TABLE repository_plan_job_verifier_state (
  name text PRIMARY KEY, job_id uuid, claim_token uuid, plan_v2_run_id uuid
);
GRANT ALL ON repository_plan_job_verifier_state TO service_role, forgewing_engineering_worker;

DO $catalog_posture$
DECLARE v_function regprocedure;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles
      WHERE rolname = 'forgewing_engineering_worker' AND NOT rolcanlogin AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'dedicated Forgewing worker role posture drift';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
      WHERE oid = 'public.workflow_repository_plan_generation_jobs'::regclass) THEN
    RAISE EXCEPTION 'repository plan generation job RLS missing';
  END IF;
  IF has_table_privilege('service_role','public.workflow_repository_plan_generation_jobs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('forgewing_engineering_worker','public.workflow_repository_plan_generation_jobs','SELECT,INSERT,UPDATE,DELETE,TRUNCATE') THEN
    RAISE EXCEPTION 'job table direct privilege drift';
  END IF;
  IF has_function_privilege('forgewing_engineering_worker',
      'public.create_workflow_repository_plan_generation_job(uuid,integer,uuid,integer,text,uuid,text)','EXECUTE')
    OR has_function_privilege('forgewing_engineering_worker',
      'public.read_workflow_repository_plan_generation_job(uuid)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.create_workflow_repository_plan_generation_job(uuid,integer,uuid,integer,text,uuid,text)','EXECUTE')
    OR NOT has_function_privilege('service_role',
      'public.read_workflow_repository_plan_generation_job(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'control-plane job RPC ACL drift';
  END IF;
  FOREACH v_function IN ARRAY ARRAY[
    'public.claim_workflow_repository_plan_generation_job()'::regprocedure,
    'public.read_workflow_repository_plan_generation_source(uuid,uuid)'::regprocedure,
    'public.begin_workflow_repository_plan_provider_call(uuid,uuid)'::regprocedure,
    'public.succeed_workflow_repository_plan_generation_job(uuid,uuid,uuid)'::regprocedure,
    'public.fail_workflow_repository_plan_generation_job(uuid,uuid,text)'::regprocedure
  ] LOOP
    IF has_function_privilege('service_role',v_function,'EXECUTE')
      OR has_function_privilege('authenticated',v_function,'EXECUTE')
      OR NOT has_function_privilege('forgewing_engineering_worker',v_function,'EXECUTE') THEN
      RAISE EXCEPTION 'worker job RPC ACL drift on %', v_function;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid = v_function::oid AND procedure.prosecdef
        AND owner_role.rolname = 'postgres'
        AND procedure.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]) THEN
      RAISE EXCEPTION 'worker job RPC catalog posture drift on %', v_function;
    END IF;
  END LOOP;
  IF NOT has_function_privilege('forgewing_engineering_worker',
      'public.record_workflow_repository_plan_v2_run(text,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'worker lost qualified B3 persistence capability';
  END IF;
END
$catalog_posture$;

SET ROLE authenticated;
DO $authenticated_denials$
BEGIN
  BEGIN
    PERFORM * FROM public.create_workflow_repository_plan_generation_job(
      '93000000-0000-4000-8000-000000000130',1,
      '00000000-0000-4000-8000-000000000001',1,'RULE',
      '93000000-0000-4000-8000-000000000001',repeat('a',64));
    RAISE EXCEPTION 'authenticated unexpectedly created a repository plan job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.claim_workflow_repository_plan_generation_job();
    RAISE EXCEPTION 'authenticated unexpectedly claimed a repository plan job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$authenticated_denials$;
RESET ROLE;

SET ROLE service_role;
DO $service_role_denials$
BEGIN
  BEGIN
    INSERT INTO public.workflow_repository_plan_generation_jobs(
      assessment_id,assessment_version,review_id,review_version,classification,
      requested_by_actor_id,implementation_plan_v1_digest_sha256)
    VALUES ('93000000-0000-4000-8000-000000000130',1,
      (SELECT id FROM public.workflow_assessment_reviews
       WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1),
      1,'RULE','93000000-0000-4000-8000-000000000001',repeat('a',64));
    RAISE EXCEPTION 'service_role direct job insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.claim_workflow_repository_plan_generation_job();
    RAISE EXCEPTION 'service_role unexpectedly claimed a worker job';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$service_role_denials$;

INSERT INTO repository_plan_job_verifier_state(name,job_id)
SELECT 'success', job_id FROM public.create_workflow_repository_plan_generation_job(
  '93000000-0000-4000-8000-000000000130',1,
  (SELECT id FROM public.workflow_assessment_reviews
   WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1),
  1,'RULE','93000000-0000-4000-8000-000000000001',repeat('a',64));
RESET ROLE;

SET ROLE forgewing_engineering_worker;
DO $worker_control_denial$
BEGIN
  BEGIN
    PERFORM * FROM public.read_workflow_repository_plan_generation_job(
      (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='success'));
    RAISE EXCEPTION 'worker unexpectedly executed control-plane read';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$worker_control_denial$;

WITH claimed AS (SELECT * FROM public.claim_workflow_repository_plan_generation_job())
UPDATE repository_plan_job_verifier_state AS state
SET claim_token = claimed.claim_token FROM claimed WHERE state.name='success';

DO $claimed_source$
DECLARE v_source record;
BEGIN
  SELECT * INTO STRICT v_source FROM public.read_workflow_repository_plan_generation_source(
    (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='success'),
    (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='success'));
  IF v_source.assessment_row->>'id' <> '93000000-0000-4000-8000-000000000130'
    OR v_source.review_row->>'id' IS NULL
    OR pg_catalog.jsonb_array_length(v_source.step_review_rows) = 0 THEN
    RAISE EXCEPTION 'claimed source read was not exact and complete';
  END IF;
END
$claimed_source$;
RESET ROLE;

CREATE TEMP TABLE repository_plan_job_verifier_plan(
  plan_canonical text, envelope_canonical text
);
GRANT SELECT ON repository_plan_job_verifier_plan TO forgewing_engineering_worker;
DO $build_zero_call_plan$
DECLARE v_base jsonb; v_env jsonb; v_full jsonb; v_digest text; v_review record;
BEGIN
  SELECT plan_v2_canonical_json::jsonb INTO STRICT v_base
  FROM public.workflow_repository_plan_v2_runs
  WHERE repository_commit_sha=repeat('a',40) AND guidance_input_digest_sha256=repeat('6',64);
  SELECT id,review_version INTO STRICT v_review FROM public.workflow_assessment_reviews
  WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1;
  v_env := v_base - 'digest';
  v_env := pg_catalog.jsonb_set(v_env,'{source,reviewPin,assessmentId}',
    pg_catalog.to_jsonb('93000000-0000-4000-8000-000000000130'::text));
  v_env := pg_catalog.jsonb_set(v_env,'{source,reviewPin,assessmentVersion}','1'::jsonb);
  v_env := pg_catalog.jsonb_set(v_env,'{source,reviewPin,reviewId}',pg_catalog.to_jsonb(v_review.id::text));
  v_env := pg_catalog.jsonb_set(v_env,'{source,reviewPin,reviewVersion}',pg_catalog.to_jsonb(v_review.review_version));
  v_env := pg_catalog.jsonb_set(v_env,'{source,implementationPlanV1DigestSha256}',pg_catalog.to_jsonb(repeat('a',64)));
  v_env := pg_catalog.jsonb_set(v_env,'{guidance,sourceImplementationPlanV1DigestSha256}',pg_catalog.to_jsonb(repeat('a',64)));
  v_env := pg_catalog.jsonb_set(v_env,'{source,guidanceInputDigestSha256}',pg_catalog.to_jsonb(repeat('f',64)));
  v_env := pg_catalog.jsonb_set(v_env,'{guidance,sourceGuidanceInputDigestSha256}',pg_catalog.to_jsonb(repeat('f',64)));
  v_env := pg_catalog.jsonb_set(v_env,'{providerProvenance,guidanceInputDigestSha256}',pg_catalog.to_jsonb(repeat('f',64)));
  v_env := pg_catalog.jsonb_set(v_env,'{providerProvenance,callCount}','0'::jsonb);
  v_env := pg_catalog.jsonb_set(v_env,'{providerProvenance,rawOutputSha256}','null'::jsonb);
  v_env := pg_catalog.jsonb_set(v_env,'{rawOutputSha256}','null'::jsonb);
  v_digest := pg_catalog.encode(extensions.digest(pg_catalog.convert_to(v_env::text,'UTF8'),'sha256'),'hex');
  v_full := v_env || pg_catalog.jsonb_build_object('digest',pg_catalog.jsonb_build_object(
    'algorithm','sha256','encoding','recursive-key-sorted-json-v1','value',v_digest));
  INSERT INTO repository_plan_job_verifier_plan VALUES(v_full::text,v_env::text);
END
$build_zero_call_plan$;

SET ROLE forgewing_engineering_worker;
WITH recorded AS (
  SELECT * FROM public.record_workflow_repository_plan_v2_run(NULL,NULL,
    (SELECT plan_canonical FROM repository_plan_job_verifier_plan),
    (SELECT envelope_canonical FROM repository_plan_job_verifier_plan))
)
UPDATE repository_plan_job_verifier_state AS state SET plan_v2_run_id=recorded.plan_v2_run_id
FROM recorded WHERE state.name='success';
SELECT public.succeed_workflow_repository_plan_generation_job(
  (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='success'),
  (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='success'),
  (SELECT plan_v2_run_id FROM repository_plan_job_verifier_state WHERE name='success'));
RESET ROLE;

SET ROLE service_role;
DO $success_read$
DECLARE v_read record;
BEGIN
  SELECT * INTO STRICT v_read FROM public.read_workflow_repository_plan_generation_job(
    (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='success'));
  IF v_read.job_status <> 'succeeded' OR v_read.plan_v2_run_id IS NULL
    OR v_read.plan_v2_digest_sha256 IS NULL OR v_read.repository_commit_sha <> repeat('a',40)
    OR v_read.provider_call_count <> 0 THEN
    RAISE EXCEPTION 'successful job result binding is incoherent';
  END IF;
END
$success_read$;

INSERT INTO repository_plan_job_verifier_state(name,job_id)
SELECT 'failure', job_id FROM public.create_workflow_repository_plan_generation_job(
  '93000000-0000-4000-8000-000000000130',1,
  (SELECT id FROM public.workflow_assessment_reviews
   WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1),
  1,'RULE','93000000-0000-4000-8000-000000000001',repeat('b',64));
RESET ROLE;

SET ROLE forgewing_engineering_worker;
WITH claimed AS (SELECT * FROM public.claim_workflow_repository_plan_generation_job())
UPDATE repository_plan_job_verifier_state AS state SET claim_token=claimed.claim_token
FROM claimed WHERE state.name='failure';
SELECT public.begin_workflow_repository_plan_provider_call(
  (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='failure'),
  (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='failure'));
DO $provider_once$
BEGIN
  BEGIN
    PERFORM public.begin_workflow_repository_plan_provider_call(
      (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='failure'),
      (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='failure'));
    RAISE EXCEPTION 'provider call marker unexpectedly advanced twice';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END
$provider_once$;
SELECT public.fail_workflow_repository_plan_generation_job(
  (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='failure'),
  (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='failure'),
  'provider_timeout');
DO $terminal_denials$
BEGIN
  BEGIN
    PERFORM public.fail_workflow_repository_plan_generation_job(
      (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='failure'),
      (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='failure'),
      'worker_failed');
    RAISE EXCEPTION 'failed job unexpectedly transitioned twice';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
END
$terminal_denials$;
RESET ROLE;

SET ROLE service_role;
INSERT INTO repository_plan_job_verifier_state(name,job_id)
SELECT 'recoverable', job_id FROM public.create_workflow_repository_plan_generation_job(
  '93000000-0000-4000-8000-000000000130',1,
  (SELECT id FROM public.workflow_assessment_reviews
   WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1),
  1,'RULE','93000000-0000-4000-8000-000000000001',repeat('c',64));
RESET ROLE;
SET ROLE forgewing_engineering_worker;
WITH claimed AS (SELECT * FROM public.claim_workflow_repository_plan_generation_job())
UPDATE repository_plan_job_verifier_state AS state SET claim_token=claimed.claim_token
FROM claimed WHERE state.name='recoverable';
RESET ROLE;
UPDATE public.workflow_repository_plan_generation_jobs
SET claimed_at=clock_timestamp()-interval '11 minutes'
WHERE id=(SELECT job_id FROM repository_plan_job_verifier_state WHERE name='recoverable');
SET ROLE forgewing_engineering_worker;
DO $pre_provider_recovery$
DECLARE v_old uuid; v_recovered record;
BEGIN
  SELECT claim_token INTO STRICT v_old FROM repository_plan_job_verifier_state WHERE name='recoverable';
  SELECT * INTO STRICT v_recovered FROM public.claim_workflow_repository_plan_generation_job();
  IF v_recovered.claim_status <> 'recovered_pre_provider'
    OR v_recovered.job_id <> (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='recoverable')
    OR v_recovered.claim_token IS NOT DISTINCT FROM v_old THEN
    RAISE EXCEPTION 'expired pre-provider claim did not recover with a new token';
  END IF;
  BEGIN
    PERFORM public.fail_workflow_repository_plan_generation_job(v_recovered.job_id,v_old,'stale_worker');
    RAISE EXCEPTION 'stale pre-provider token unexpectedly mutated recovered job';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  PERFORM public.fail_workflow_repository_plan_generation_job(
    v_recovered.job_id,v_recovered.claim_token,'worker_failed');
END
$pre_provider_recovery$;
RESET ROLE;

SET ROLE service_role;
INSERT INTO repository_plan_job_verifier_state(name,job_id)
SELECT 'ambiguous_provider', job_id FROM public.create_workflow_repository_plan_generation_job(
  '93000000-0000-4000-8000-000000000130',1,
  (SELECT id FROM public.workflow_assessment_reviews
   WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1),
  1,'RULE','93000000-0000-4000-8000-000000000001',repeat('e',64));
RESET ROLE;
SET ROLE forgewing_engineering_worker;
WITH claimed AS (SELECT * FROM public.claim_workflow_repository_plan_generation_job())
UPDATE repository_plan_job_verifier_state AS state SET claim_token=claimed.claim_token
FROM claimed WHERE state.name='ambiguous_provider';
SELECT public.begin_workflow_repository_plan_provider_call(
  (SELECT job_id FROM repository_plan_job_verifier_state WHERE name='ambiguous_provider'),
  (SELECT claim_token FROM repository_plan_job_verifier_state WHERE name='ambiguous_provider'));
RESET ROLE;
UPDATE public.workflow_repository_plan_generation_jobs
SET provider_call_started_at=clock_timestamp()-interval '11 minutes'
WHERE id=(SELECT job_id FROM repository_plan_job_verifier_state WHERE name='ambiguous_provider');
SET ROLE forgewing_engineering_worker;
DO $provider_expiry_no_retry$
DECLARE v_claim_count integer;
BEGIN
  SELECT count(*) INTO v_claim_count FROM public.claim_workflow_repository_plan_generation_job();
  IF v_claim_count <> 0 THEN RAISE EXCEPTION 'expired provider-started job was reclaimed'; END IF;
END
$provider_expiry_no_retry$;
RESET ROLE;
DO $provider_expiry_terminal$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workflow_repository_plan_generation_jobs
    WHERE id=(SELECT job_id FROM repository_plan_job_verifier_state WHERE name='ambiguous_provider')
      AND status='failed' AND failure_code='provider_claim_expired'
      AND provider_call_count=1 AND plan_v2_run_id IS NULL) THEN
    RAISE EXCEPTION 'expired provider-started job did not fail terminally';
  END IF;
END
$provider_expiry_terminal$;

SET ROLE service_role;
INSERT INTO repository_plan_job_verifier_state(name,job_id)
SELECT 'race', job_id FROM public.create_workflow_repository_plan_generation_job(
  '93000000-0000-4000-8000-000000000130',1,
  (SELECT id FROM public.workflow_assessment_reviews
   WHERE assessment_id='93000000-0000-4000-8000-000000000130' ORDER BY review_version LIMIT 1),
  1,'RULE','93000000-0000-4000-8000-000000000001',repeat('d',64));
RESET ROLE;

SELECT 'REPOSITORY PLAN GENERATION JOB DIRECT POSTGRESQL VERIFICATION: PASS' AS result;
