\set ON_ERROR_STOP on

DO $verify_repository_plan_v2$
DECLARE
  v_guidance_digest text := repeat('7', 64);
  v_input_digest text := repeat('6', 64);
  v_raw_output text := '{"classification":"RULE"}';
  v_raw_sha text;
  v_raw_envelope text;
  v_raw_full text;
  v_plan_envelope text;
  v_plan_full text;
  v_first record;
  v_second record;
BEGIN
  v_raw_sha := encode(extensions.digest(convert_to(v_raw_output, 'UTF8'), 'sha256'), 'hex');
  v_raw_envelope := jsonb_build_object(
    'domain', 'eightforge.repository-plan-provider-evidence', 'schemaVersion', 1,
    'authority', 'non_authoritative', 'trustedGuidance', false, 'executable', false,
    'grantsExecutionAuthority', false, 'requiresHumanReview', true,
    'sourceGuidanceInputDigestSha256', v_input_digest,
    'providerProvenance', jsonb_build_object('callCount', 1),
    'rawOutput', v_raw_output, 'rawOutputSha256', v_raw_sha
  )::text;
  v_raw_full := (v_raw_envelope::jsonb || jsonb_build_object('digest', jsonb_build_object(
    'algorithm', 'sha256', 'encoding', 'recursive-key-sorted-json-v1',
    'value', encode(extensions.digest(convert_to(v_raw_envelope, 'UTF8'), 'sha256'), 'hex'))))::text;

  v_plan_envelope := jsonb_build_object(
    'domain', 'eightforge.repository-aware-implementation-plan', 'schemaVersion', 2,
    'authority', 'non_authoritative', 'executable', false, 'grantsExecutionAuthority', false,
    'requiresHumanReview', true,
    'source', jsonb_build_object(
      'implementationPlanV1DigestSha256', repeat('1',64),
      'effectiveReviewedSpecificationDigestSha256', repeat('2',64),
      'foundationDigestSha256', repeat('3',64), 'contentBundleDigestSha256', repeat('4',64),
      'guidanceInputDigestSha256', v_input_digest,
      'reviewPin', jsonb_build_object('assessmentId','11111111-1111-4111-8111-111111111111',
        'assessmentVersion',2,'reviewId','22222222-2222-4222-8222-222222222222','reviewVersion',3),
      'repositorySnapshot', jsonb_build_object('commitSha', repeat('a',40))),
    'guidance', jsonb_build_object(
      'sourceGuidanceInputDigestSha256', v_input_digest,
      'sourceImplementationPlanV1DigestSha256', repeat('1',64),
      'recommendations', jsonb_build_array(jsonb_build_object(
        'recommendationId', 'rec_' || repeat('b',64),
        'capabilitySummary', 'Qualified repository seam',
        'summary', 'Use the exact qualified repository seam.',
        'evidenceRefs', jsonb_build_array('ev_' || repeat('c',64)),
        'architectureRisks', '[]'::jsonb,
        'regressionGates', jsonb_build_array(jsonb_build_object('gate','typecheck')),
        'stopConditions', '[]'::jsonb,
        'unresolvedQuestions', '[]'::jsonb)),
      'digest', jsonb_build_object('value', v_guidance_digest)),
    'providerProvenance', jsonb_build_object('callCount',1,'repositoryCommitSha',repeat('a',40),
      'foundationDigestSha256',repeat('3',64),'contentBundleDigestSha256',repeat('4',64),
      'guidanceInputDigestSha256',v_input_digest,'rawOutputSha256',v_raw_sha,
      'validatedOutputSha256',v_guidance_digest),
    'rawOutputSha256', v_raw_sha, 'validatedOutputSha256', v_guidance_digest
  )::text;
  v_plan_full := (v_plan_envelope::jsonb || jsonb_build_object('digest', jsonb_build_object(
    'algorithm', 'sha256', 'encoding', 'recursive-key-sorted-json-v1',
    'value', encode(extensions.digest(convert_to(v_plan_envelope, 'UTF8'), 'sha256'), 'hex'))))::text;

  SELECT * INTO v_first FROM public.record_workflow_repository_plan_v2_run(
    v_raw_full, v_raw_envelope, v_plan_full, v_plan_envelope);
  SELECT * INTO v_second FROM public.record_workflow_repository_plan_v2_run(
    v_raw_full, v_raw_envelope, v_plan_full, v_plan_envelope);
  IF NOT v_first.inserted OR v_second.inserted OR v_first.plan_v2_run_id IS DISTINCT FROM v_second.plan_v2_run_id
    OR v_first.raw_evidence_id IS NULL THEN
    RAISE EXCEPTION 'repository Plan V2 idempotency verification failed';
  END IF;

  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(
      v_raw_full, v_raw_envelope, ' ' || v_plan_full, v_plan_envelope);
    RAISE EXCEPTION 'same Plan V2 digest with conflicting bytes unexpectedly persisted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(
      ' ' || v_raw_full, v_raw_envelope, v_plan_full, v_plan_envelope);
    RAISE EXCEPTION 'same raw digest with conflicting bytes unexpectedly persisted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    UPDATE public.workflow_repository_plan_v2_runs SET authority = 'non_authoritative'
    WHERE id = v_first.plan_v2_run_id;
    RAISE EXCEPTION 'immutable Plan V2 update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    DELETE FROM public.workflow_repository_plan_v2_runs WHERE id = v_first.plan_v2_run_id;
    RAISE EXCEPTION 'immutable Plan V2 delete unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    UPDATE public.workflow_repository_plan_raw_evidence SET raw_output_sha256 = raw_output_sha256
    WHERE id = v_first.raw_evidence_id;
    RAISE EXCEPTION 'immutable raw evidence update unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    DELETE FROM public.workflow_repository_plan_raw_evidence WHERE id = v_first.raw_evidence_id;
    RAISE EXCEPTION 'immutable raw evidence delete unexpectedly succeeded';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;
  END;

  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(
      NULL, NULL, '{}', '{}');
    RAISE EXCEPTION 'invalid Plan V2 unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END
$verify_repository_plan_v2$;

DO $verify_repository_plan_v2_catalog$
DECLARE
  v_function regprocedure := 'public.record_workflow_repository_plan_v2_run(text,text,text,text)'::regprocedure;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE oid IN (
      'public.workflow_repository_plan_raw_evidence'::regclass,
      'public.workflow_repository_plan_v2_runs'::regclass) AND NOT relrowsecurity) THEN
    RAISE EXCEPTION 'repository Plan V2 RLS posture drift';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc AS procedure
    JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
    WHERE procedure.oid = v_function::oid AND procedure.prosecdef
      AND owner_role.rolname = 'postgres'
      AND procedure.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
      AND pg_catalog.pg_get_functiondef(procedure.oid) !~* 'EXECUTE[[:space:]]') THEN
    RAISE EXCEPTION 'repository Plan V2 SECURITY DEFINER posture drift';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc AS procedure,
      LATERAL pg_catalog.aclexplode(coalesce(procedure.proacl,
        pg_catalog.acldefault('f',procedure.proowner))) AS acl
      WHERE procedure.oid=v_function::oid AND acl.grantee=0 AND acl.privilege_type='EXECUTE')
    OR has_function_privilege('anon', v_function, 'EXECUTE')
    OR has_function_privilege('authenticated', v_function, 'EXECUTE')
    OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
    RAISE EXCEPTION 'repository Plan V2 RPC ACL drift';
  END IF;
  IF has_table_privilege('service_role','public.workflow_repository_plan_raw_evidence','SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    OR has_table_privilege('service_role','public.workflow_repository_plan_v2_runs','INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT has_table_privilege('service_role','public.workflow_repository_plan_v2_runs','SELECT') THEN
    RAISE EXCEPTION 'repository Plan V2 table ACL drift';
  END IF;
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid IN (
      'public.workflow_repository_plan_raw_evidence'::regclass,
      'public.workflow_repository_plan_v2_runs'::regclass)
      AND tgname LIKE 'workflow_repository_plan_%_immutable' AND tgenabled = 'O') <> 2 THEN
    RAISE EXCEPTION 'repository Plan V2 immutable trigger drift';
  END IF;
END
$verify_repository_plan_v2_catalog$;

DO $verify_repository_plan_v2_acl$
BEGIN
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL, NULL, '{}', '{}');
    RESET ROLE;
    RAISE EXCEPTION 'anon unexpectedly executed Plan V2 writer';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL, NULL, '{}', '{}');
    RESET ROLE;
    RAISE EXCEPTION 'authenticated unexpectedly executed Plan V2 writer';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
  BEGIN
    SET LOCAL ROLE service_role;
    INSERT INTO public.workflow_repository_plan_v2_runs (
      assessment_id, assessment_version, review_id, review_version, repository_commit_sha,
      effective_reviewed_specification_digest_sha256, implementation_plan_v1_digest_sha256,
      foundation_digest_sha256, content_bundle_digest_sha256, guidance_input_digest_sha256,
      plan_v2_digest_sha256, plan_v2_canonical_json, plan_v2_envelope_canonical_json
    ) VALUES ('11111111-1111-4111-8111-111111111111',1,'22222222-2222-4222-8222-222222222222',1,
      repeat('a',40),repeat('1',64),repeat('2',64),repeat('3',64),repeat('4',64),repeat('5',64),
      repeat('6',64),'{}','{}');
    RESET ROLE;
    RAISE EXCEPTION 'service_role direct Plan V2 insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN RESET ROLE;
  END;
END
$verify_repository_plan_v2_acl$;

DO $verify_repository_plan_v2_source_negatives$
DECLARE
  v_base jsonb;
  v_plan jsonb;
  v_envelope jsonb;
  v_digest text;
  v_raw_full text;
  v_raw_envelope text;
BEGIN
  SELECT plan.plan_v2_canonical_json::jsonb,raw.raw_artifact_canonical_json,raw.raw_envelope_canonical_json
  INTO STRICT v_base,v_raw_full,v_raw_envelope
  FROM public.workflow_repository_plan_v2_runs AS plan
  JOIN public.workflow_repository_plan_raw_evidence AS raw ON raw.id=plan.raw_evidence_id
  WHERE plan.repository_commit_sha = repeat('a',40) AND plan.guidance_input_digest_sha256 = repeat('6',64);
  v_base := jsonb_set(v_base,'{providerProvenance,callCount}','0'::jsonb);
  v_base := jsonb_set(v_base,'{providerProvenance,rawOutputSha256}','null'::jsonb);
  v_base := jsonb_set(v_base,'{rawOutputSha256}','null'::jsonb);
  v_envelope := v_base - 'digest';
  v_envelope := jsonb_set(v_envelope, '{guidance,sourceImplementationPlanV1DigestSha256}', to_jsonb(repeat('9',64)));
  v_digest := encode(extensions.digest(convert_to(v_envelope::text,'UTF8'),'sha256'),'hex');
  v_plan := v_envelope || jsonb_build_object('digest',jsonb_build_object(
    'algorithm','sha256','encoding','recursive-key-sorted-json-v1','value',v_digest));
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL,NULL,v_plan::text,v_envelope::text);
    RAISE EXCEPTION 'Plan V1 cross-binding unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  v_envelope := (v_base - 'digest') #- '{guidance,sourceImplementationPlanV1DigestSha256}';
  v_digest := encode(extensions.digest(convert_to(v_envelope::text,'UTF8'),'sha256'),'hex');
  v_plan := v_envelope || jsonb_build_object('digest',jsonb_build_object(
    'algorithm','sha256','encoding','recursive-key-sorted-json-v1','value',v_digest));
  BEGIN
    PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL,NULL,v_plan::text,v_envelope::text);
    RAISE EXCEPTION 'missing guidance Plan V1 source digest unexpectedly persisted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  FOREACH v_envelope IN ARRAY ARRAY[
    jsonb_set((v_base-'digest'),'{authority}',to_jsonb('authoritative'::text)),
    jsonb_set((v_base-'digest'),'{executable}','true'::jsonb),
    jsonb_set((v_base-'digest'),'{grantsExecutionAuthority}','true'::jsonb),
    jsonb_set((v_base-'digest'),'{requiresHumanReview}','false'::jsonb)
  ] LOOP
    v_digest := encode(extensions.digest(convert_to(v_envelope::text,'UTF8'),'sha256'),'hex');
    v_plan := v_envelope || jsonb_build_object('digest',jsonb_build_object(
      'algorithm','sha256','encoding','recursive-key-sorted-json-v1','value',v_digest));
    BEGIN
      PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL,NULL,v_plan::text,v_envelope::text);
      RAISE EXCEPTION 'invalid Plan V2 authority literal unexpectedly persisted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  FOREACH v_envelope IN ARRAY ARRAY[
    jsonb_set((v_base-'digest'),'{providerProvenance,repositoryCommitSha}',to_jsonb(repeat('b',40))),
    jsonb_set((v_base-'digest'),'{providerProvenance,foundationDigestSha256}',to_jsonb(repeat('8',64))),
    jsonb_set((v_base-'digest'),'{providerProvenance,contentBundleDigestSha256}',to_jsonb(repeat('8',64))),
    jsonb_set((v_base-'digest'),'{providerProvenance,guidanceInputDigestSha256}',to_jsonb(repeat('8',64))),
    jsonb_set((v_base-'digest'),'{guidance,sourceGuidanceInputDigestSha256}',to_jsonb(repeat('8',64))),
    jsonb_set((v_base-'digest'),'{validatedOutputSha256}',to_jsonb(repeat('8',64)))
  ] LOOP
    v_digest := encode(extensions.digest(convert_to(v_envelope::text,'UTF8'),'sha256'),'hex');
    v_plan := v_envelope || jsonb_build_object('digest',jsonb_build_object(
      'algorithm','sha256','encoding','recursive-key-sorted-json-v1','value',v_digest));
    BEGIN
      PERFORM * FROM public.record_workflow_repository_plan_v2_run(NULL,NULL,v_plan::text,v_envelope::text);
      RAISE EXCEPTION 'mismatched Plan V2 immutable source identity unexpectedly persisted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;
END
$verify_repository_plan_v2_source_negatives$;

SELECT 'PHASE 11E B3A DIRECT POSTGRESQL VERIFICATION: PASS' AS result;
