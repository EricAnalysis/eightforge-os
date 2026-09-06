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
    'guidance', jsonb_build_object('sourceGuidanceInputDigestSha256', v_input_digest,
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
    UPDATE public.workflow_repository_plan_v2_runs SET authority = 'non_authoritative'
    WHERE id = v_first.plan_v2_run_id;
    RAISE EXCEPTION 'immutable Plan V2 update unexpectedly succeeded';
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

DO $verify_repository_plan_v2_acl$
BEGIN
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
