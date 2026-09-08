\set ON_ERROR_STOP on

-- Disposable fixtures only. The replay harness owns and drops this database.
INSERT INTO auth.users (id,email) VALUES
  ('96000000-0000-4000-8000-000000000001','phase11e-b3-reviewer@example.invalid')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.user_profiles (id,display_name,role) VALUES
  ('96000000-0000-4000-8000-000000000001','Phase 11E B3 reviewer','member')
ON CONFLICT (id) DO NOTHING;

DO $engineering_review_catalog$
DECLARE
  v_function regprocedure :=
    'public.record_workflow_repository_plan_recommendation_review(uuid,text,text,uuid,text,text,text,jsonb,text)'::regprocedure;
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
      WHERE oid = 'public.workflow_repository_plan_recommendation_reviews'::regclass) THEN
    RAISE EXCEPTION 'engineering review RLS posture drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = v_function::oid AND procedure.prosecdef
      AND owner_role.rolname = 'postgres'
      AND procedure.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
      AND pg_catalog.pg_get_functiondef(procedure.oid) !~* 'EXECUTE[[:space:]]') THEN
    RAISE EXCEPTION 'engineering review SECURITY DEFINER posture drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure,
      LATERAL pg_catalog.aclexplode(coalesce(procedure.proacl,
        pg_catalog.acldefault('f',procedure.proowner))) AS acl
      WHERE procedure.oid=v_function::oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
    OR has_function_privilege('anon',v_function,'EXECUTE')
    OR has_function_privilege('authenticated',v_function,'EXECUTE')
    OR NOT has_function_privilege('service_role',v_function,'EXECUTE') THEN
    RAISE EXCEPTION 'engineering review RPC ACL drift';
  END IF;
  IF NOT has_table_privilege('service_role','public.workflow_repository_plan_recommendation_reviews','SELECT')
    OR has_table_privilege('service_role','public.workflow_repository_plan_recommendation_reviews','INSERT')
    OR has_table_privilege('service_role','public.workflow_repository_plan_recommendation_reviews','UPDATE')
    OR has_table_privilege('service_role','public.workflow_repository_plan_recommendation_reviews','DELETE')
    OR has_table_privilege('service_role','public.workflow_repository_plan_recommendation_reviews','TRUNCATE') THEN
    RAISE EXCEPTION 'engineering review table ACL drift';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger
      WHERE tgrelid='public.workflow_repository_plan_recommendation_reviews'::regclass
        AND tgname='workflow_repository_plan_recommendation_reviews_immutable' AND tgenabled='O') THEN
    RAISE EXCEPTION 'engineering review immutable trigger drift';
  END IF;
END
$engineering_review_catalog$;

SET ROLE anon;
DO $anon_review_denial$ BEGIN
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      gen_random_uuid(),repeat('1',64),'rec_'||repeat('1',64),gen_random_uuid(),
      'rejected',NULL,'denied',NULL,repeat('2',64));
    RAISE EXCEPTION 'anon unexpectedly executed engineering review RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $anon_review_denial$;
RESET ROLE;

SET ROLE authenticated;
DO $authenticated_review_denial$ BEGIN
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      gen_random_uuid(),repeat('1',64),'rec_'||repeat('1',64),gen_random_uuid(),
      'rejected',NULL,'denied',NULL,repeat('2',64));
    RAISE EXCEPTION 'authenticated unexpectedly executed engineering review RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $authenticated_review_denial$;
RESET ROLE;

-- With no JWT role setting, auth.role() is NULL in this replay. The call succeeds
-- because the real database barrier is the EXECUTE ACL plus SET ROLE service_role.
SET ROLE service_role;
DO $engineering_review_dispositions$
DECLARE
  v_plan record;
  v_accepted record;
  v_accepted_again record;
  v_modified record;
  v_rejected record;
  v_deferred record;
  v_scope jsonb := jsonb_build_object(
    'capabilitySummary','Human reviewed repository seam',
    'summary','Use the exact repository seam after human review.',
    'evidenceRefs',jsonb_build_array('ev_'||repeat('c',64)),
    'architectureRisks','[]'::jsonb,
    'regressionGates',jsonb_build_array(jsonb_build_object('gate','typecheck')),
    'stopConditions','[]'::jsonb,
    'unresolvedQuestions','[]'::jsonb);
BEGIN
  SELECT id,plan_v2_digest_sha256 INTO STRICT v_plan
  FROM public.workflow_repository_plan_v2_runs
  WHERE repository_commit_sha=repeat('a',40) AND guidance_input_digest_sha256=repeat('6',64);

  SELECT * INTO v_accepted FROM public.record_workflow_repository_plan_recommendation_review(
    v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
    '96000000-0000-4000-8000-000000000001','accepted','client_specific',
    'Accepted for backlog qualification.',NULL,repeat('1',64));
  SELECT * INTO v_accepted_again FROM public.record_workflow_repository_plan_recommendation_review(
    v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
    '96000000-0000-4000-8000-000000000001','accepted','client_specific',
    'Accepted for backlog qualification.',NULL,repeat('1',64));
  IF NOT v_accepted.inserted OR v_accepted_again.inserted
    OR v_accepted.review_id IS DISTINCT FROM v_accepted_again.review_id
    OR v_accepted.review_version <> 1 THEN
    RAISE EXCEPTION 'accepted review idempotency failed';
  END IF;

  SELECT * INTO v_modified FROM public.record_workflow_repository_plan_recommendation_review(
    v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
    '96000000-0000-4000-8000-000000000001','modified','workflow_specific',
    'Modified for backlog qualification.',v_scope,repeat('2',64));
  SELECT * INTO v_rejected FROM public.record_workflow_repository_plan_recommendation_review(
    v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
    '96000000-0000-4000-8000-000000000001','rejected',NULL,
    'Rejected for backlog qualification.',NULL,repeat('3',64));
  SELECT * INTO v_deferred FROM public.record_workflow_repository_plan_recommendation_review(
    v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
    '96000000-0000-4000-8000-000000000001','deferred',NULL,
    'Deferred for backlog qualification.',NULL,repeat('4',64));
  IF v_modified.review_version<>2 OR v_rejected.review_version<>3 OR v_deferred.review_version<>4
    OR (SELECT count(*) FROM public.workflow_repository_plan_recommendation_reviews
        WHERE plan_v2_run_id=v_plan.id AND recommendation_id='rec_'||repeat('b',64))<>4 THEN
    RAISE EXCEPTION 'engineering review disposition/version coherence failed';
  END IF;
  IF (SELECT modified_scope FROM public.workflow_repository_plan_recommendation_reviews
      WHERE id=v_modified.review_id) IS DISTINCT FROM v_scope THEN
    RAISE EXCEPTION 'human modified scope was not retained exactly';
  END IF;

  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
      '96000000-0000-4000-8000-000000000001','rejected',NULL,
      'Digest collision.',NULL,repeat('1',64));
    RAISE EXCEPTION 'conflicting review digest unexpectedly persisted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$engineering_review_dispositions$;

DO $engineering_review_invalid_matrix$
DECLARE
  v_plan record;
  v_bad jsonb;
  v_index integer := 0;
  v_valid_scope jsonb := jsonb_build_object(
    'capabilitySummary','Human reviewed repository seam',
    'summary','Use the exact repository seam after human review.',
    'evidenceRefs',jsonb_build_array('ev_'||repeat('c',64)),
    'architectureRisks','[]'::jsonb,
    'regressionGates',jsonb_build_array(jsonb_build_object('gate','typecheck')),
    'stopConditions','[]'::jsonb,
    'unresolvedQuestions','[]'::jsonb);
BEGIN
  SELECT id,plan_v2_digest_sha256 INTO STRICT v_plan
  FROM public.workflow_repository_plan_v2_runs
  WHERE repository_commit_sha=repeat('a',40) AND guidance_input_digest_sha256=repeat('6',64);

  FOREACH v_bad IN ARRAY ARRAY[
    '{}'::jsonb,
    'null'::jsonb,
    jsonb_build_object('operatorDecision','source_document_taxonomy'),
    jsonb_build_object('operatorDecision','recovery_vocabulary_unresolved'),
    v_valid_scope || jsonb_build_object('source_document_taxonomy','unauthorized'),
    v_valid_scope || jsonb_build_object('recovery_vocabulary_unresolved','unauthorized'),
    v_valid_scope || jsonb_build_object('operatorDecisions',jsonb_build_object(
      'source_document_taxonomy','unauthorized'))
  ] LOOP
    v_index := v_index + 1;
    BEGIN
      PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
        v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
        '96000000-0000-4000-8000-000000000001','modified','workflow_specific',
        'Invalid modified scope.',v_bad,repeat('a',63)||v_index::text);
      RAISE EXCEPTION 'invalid/operator-decision modified scope unexpectedly persisted: %',v_bad;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
      '96000000-0000-4000-8000-000000000001','accepted',NULL,'Missing scope.',NULL,repeat('5',64));
    RAISE EXCEPTION 'accepted review without capability scope unexpectedly persisted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
      '96000000-0000-4000-8000-000000000001','rejected','workflow_specific','Invalid scope.',NULL,repeat('6',64));
    RAISE EXCEPTION 'rejected review with capability scope unexpectedly persisted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('b',64),
      '96000000-0000-4000-8000-000000000001','unknown',NULL,'Unknown disposition.',NULL,repeat('7',64));
    RAISE EXCEPTION 'unknown disposition unexpectedly persisted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      v_plan.id,v_plan.plan_v2_digest_sha256,'rec_'||repeat('d',64),
      '96000000-0000-4000-8000-000000000001','rejected',NULL,'Wrong recommendation.',NULL,repeat('8',64));
    RAISE EXCEPTION 'cross-run/missing recommendation unexpectedly persisted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      v_plan.id,repeat('f',64),'rec_'||repeat('b',64),
      '96000000-0000-4000-8000-000000000001','rejected',NULL,'Wrong plan digest.',NULL,repeat('9',64));
    RAISE EXCEPTION 'Plan V2 digest mismatch unexpectedly persisted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END
$engineering_review_invalid_matrix$;

DO $service_role_direct_review_dml_denial$ BEGIN
  BEGIN
    UPDATE public.workflow_repository_plan_recommendation_reviews SET reviewer_rationale=reviewer_rationale WHERE false;
    RAISE EXCEPTION 'service_role direct review update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.workflow_repository_plan_recommendation_reviews WHERE false;
    RAISE EXCEPTION 'service_role direct review delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $service_role_direct_review_dml_denial$;
RESET ROLE;

SET ROLE service_role;
SET request.jwt.claim.role='authenticated';
DO $explicit_non_service_claim_denial$ BEGIN
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_recommendation_review(
      gen_random_uuid(),repeat('1',64),'rec_'||repeat('1',64),
      '96000000-0000-4000-8000-000000000001','rejected',NULL,'Denied.',NULL,repeat('a',64));
    RAISE EXCEPTION 'explicit non-service claim unexpectedly passed review RPC';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $explicit_non_service_claim_denial$;
RESET ROLE;
RESET request.jwt.claim.role;

DO $engineering_review_owner_immutability$
DECLARE v_id uuid;
BEGIN
  SELECT id INTO STRICT v_id FROM public.workflow_repository_plan_recommendation_reviews
  WHERE review_request_digest_sha256=repeat('1',64);
  BEGIN
    UPDATE public.workflow_repository_plan_recommendation_reviews SET reviewer_rationale=reviewer_rationale WHERE id=v_id;
    RAISE EXCEPTION 'immutable review update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
  BEGIN
    DELETE FROM public.workflow_repository_plan_recommendation_reviews WHERE id=v_id;
    RAISE EXCEPTION 'immutable review delete unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;
END
$engineering_review_owner_immutability$;

SELECT 'PHASE 11E B3B DIRECT POSTGRESQL VERIFICATION: PASS' AS result;
