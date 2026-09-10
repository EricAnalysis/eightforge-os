\set ON_ERROR_STOP on

-- Disposable fixtures only. The migration replay job owns and drops the DB.
CREATE TEMP TABLE linear_projection_verifier_state (
  name text PRIMARY KEY,
  correlation_id uuid,
  claim_token uuid
);
GRANT ALL ON TABLE linear_projection_verifier_state TO service_role;

INSERT INTO public.workflow_repository_plan_recommendation_reviews (
  id, plan_v2_run_id, plan_v2_digest_sha256, recommendation_id,
  review_version, reviewer_actor_id, disposition, capability_scope,
  reviewer_rationale, modified_scope, review_request_digest_sha256,
  repository_commit_sha
)
SELECT
  '94000000-0000-4000-8000-000000000001', plan.id,
  plan.plan_v2_digest_sha256, 'rec_' || repeat('b', 64), 99,
  '93000000-0000-4000-8000-000000000001', 'accepted',
  'workflow_specific', 'Linear projection database verifier.', NULL,
  repeat('d', 64), plan.repository_commit_sha
FROM public.workflow_repository_plan_v2_runs AS plan
WHERE plan.repository_commit_sha = repeat('a', 40)
  AND plan.guidance_input_digest_sha256 = repeat('6', 64);

DO $linear_projection_catalog_acl$
DECLARE
  v_function regprocedure;
BEGIN
  IF (SELECT count(*) FROM public.workflow_repository_plan_recommendation_reviews
      WHERE id = '94000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'Linear projection verifier prerequisite review was not isolated';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_catalog.pg_class
          WHERE oid = 'public.linear_projection_correlations'::regclass) THEN
    RAISE EXCEPTION 'Linear projection correlations lost RLS';
  END IF;
  IF has_table_privilege('service_role', 'public.linear_projection_correlations',
      'INSERT,UPDATE,DELETE,TRUNCATE')
    OR NOT has_table_privilege('service_role', 'public.linear_projection_correlations', 'SELECT') THEN
    RAISE EXCEPTION 'service_role Linear correlation table privilege drift';
  END IF;
  FOREACH v_function IN ARRAY ARRAY[
    'public.claim_linear_projection_delivery(text,text,uuid,uuid,text,text,text)'::regprocedure,
    'public.confirm_linear_projection_delivery(uuid,uuid,text,text)'::regprocedure,
    'public.fail_linear_projection_delivery(uuid,uuid,text)'::regprocedure,
    'public.withdraw_linear_projection_delivery(uuid,text,text)'::regprocedure
  ] LOOP
    IF has_function_privilege('authenticated', v_function, 'EXECUTE')
      OR NOT has_function_privilege('service_role', v_function, 'EXECUTE') THEN
      RAISE EXCEPTION 'Linear projection RPC privilege drift on %', v_function;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_roles AS owner_role ON owner_role.oid = procedure.proowner
      WHERE procedure.oid = v_function::oid
        AND procedure.prosecdef
        AND owner_role.rolname = 'postgres'
        AND procedure.proconfig IS NOT DISTINCT FROM ARRAY['search_path=""']::text[]
    ) THEN
      RAISE EXCEPTION 'Linear projection RPC catalog posture drift on %', v_function;
    END IF;
  END LOOP;
END
$linear_projection_catalog_acl$;

SET ROLE authenticated;
DO $linear_projection_authenticated_denials$
BEGIN
  BEGIN
    PERFORM * FROM public.claim_linear_projection_delivery(
      repeat('e',64), repeat('f',64),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier');
    RAISE EXCEPTION 'authenticated unexpectedly executed Linear claim';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.confirm_linear_projection_delivery(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002', 'issue', 'EF-1');
    RAISE EXCEPTION 'authenticated unexpectedly executed Linear confirmation';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.fail_linear_projection_delivery(
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002', 'failure');
    RAISE EXCEPTION 'authenticated unexpectedly executed Linear failure';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM public.withdraw_linear_projection_delivery(
      '00000000-0000-4000-8000-000000000001', repeat('e',64), 'rationale');
    RAISE EXCEPTION 'authenticated unexpectedly executed Linear withdrawal';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$linear_projection_authenticated_denials$;
RESET ROLE;

SET ROLE service_role;
DO $linear_projection_direct_dml_denials$
BEGIN
  BEGIN
    INSERT INTO public.linear_projection_correlations (
      engineering_request_digest_sha256, projection_digest_sha256, idempotency_key,
      plan_v2_run_id, review_id, recommendation_id, repository_commit_sha,
      linear_project_id, status, claim_token
    ) VALUES (
      repeat('1',64), repeat('2',64), 'linear-projection:' || repeat('1',64),
      '00000000-0000-4000-8000-000000000001',
      '00000000-0000-4000-8000-000000000002',
      'rec_' || repeat('3',64), repeat('4',40), 'forbidden', 'claimed',
      '00000000-0000-4000-8000-000000000003');
    RAISE EXCEPTION 'service_role direct Linear insert unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE public.linear_projection_correlations SET claimed_at = claimed_at WHERE false;
    RAISE EXCEPTION 'service_role direct Linear update unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.linear_projection_correlations WHERE false;
    RAISE EXCEPTION 'service_role direct Linear delete unexpectedly succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$linear_projection_direct_dml_denials$;

DO $linear_projection_claims$
DECLARE
  v_plan_id uuid;
  v_first record;
  v_second record;
BEGIN
  SELECT plan_v2_run_id INTO STRICT v_plan_id
  FROM public.workflow_repository_plan_recommendation_reviews
  WHERE id = '94000000-0000-4000-8000-000000000001';

  SELECT * INTO v_first FROM public.claim_linear_projection_delivery(
    repeat('e',64), repeat('f',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_first.claim_status <> 'acquired' OR v_first.correlation_id IS NULL
    OR v_first.claim_token IS NULL OR v_first.linear_issue_id IS NOT NULL
    OR v_first.linear_issue_identifier IS NOT NULL THEN
    RAISE EXCEPTION 'first Linear projection claim did not acquire coherently';
  END IF;
  INSERT INTO linear_projection_verifier_state(name, correlation_id, claim_token)
  VALUES ('original', v_first.correlation_id, v_first.claim_token);

  BEGIN
    PERFORM * FROM public.claim_linear_projection_delivery(
      repeat('8',64), repeat('7',64), v_plan_id,
      '94000000-0000-4000-8000-000000000001',
      'rec_' || repeat('c',64), repeat('a',40), 'linear-verifier-project');
    RAISE EXCEPTION 'incoherent initial Linear projection source unexpectedly claimed';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;

  SELECT * INTO v_second FROM public.claim_linear_projection_delivery(
    repeat('e',64), repeat('f',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_second.claim_status <> 'busy'
    OR v_second.correlation_id IS DISTINCT FROM v_first.correlation_id
    OR v_second.claim_token IS NOT NULL THEN
    RAISE EXCEPTION 'identical active Linear projection claim did not converge as busy';
  END IF;

  BEGIN
    PERFORM * FROM public.claim_linear_projection_delivery(
      repeat('e',64), repeat('0',64), v_plan_id,
      '94000000-0000-4000-8000-000000000001',
      'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
    RAISE EXCEPTION 'conflicting active Linear projection identity unexpectedly claimed';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$linear_projection_claims$;
RESET ROLE;

-- Age only the disposable claimed fixture so the effective recovery path runs.
UPDATE public.linear_projection_correlations
SET claimed_at = clock_timestamp() - interval '6 minutes'
WHERE id = (SELECT correlation_id FROM linear_projection_verifier_state WHERE name = 'original');

SET ROLE service_role;
DO $linear_projection_recovery_and_confirmation$
DECLARE
  v_plan_id uuid;
  v_original record;
  v_recovered record;
  v_projected record;
BEGIN
  SELECT * INTO STRICT v_original FROM linear_projection_verifier_state WHERE name = 'original';
  SELECT plan_v2_run_id INTO STRICT v_plan_id
  FROM public.workflow_repository_plan_recommendation_reviews
  WHERE id = '94000000-0000-4000-8000-000000000001';
  SELECT * INTO v_recovered FROM public.claim_linear_projection_delivery(
    repeat('e',64), repeat('f',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_recovered.claim_status <> 'recovered'
    OR v_recovered.correlation_id IS DISTINCT FROM v_original.correlation_id
    OR v_recovered.claim_token IS NOT DISTINCT FROM v_original.claim_token THEN
    RAISE EXCEPTION 'expired Linear claim did not recover with a new token';
  END IF;
  UPDATE linear_projection_verifier_state
  SET claim_token = v_recovered.claim_token WHERE name = 'original';

  BEGIN
    PERFORM public.confirm_linear_projection_delivery(
      v_original.correlation_id, v_original.claim_token, 'linear-issue-id', 'EF-VERIFY');
    RAISE EXCEPTION 'stale Linear token unexpectedly confirmed';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;
  BEGIN
    PERFORM public.fail_linear_projection_delivery(
      v_original.correlation_id, v_original.claim_token, 'stale_failure');
    RAISE EXCEPTION 'stale Linear token unexpectedly failed the claim';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  PERFORM public.confirm_linear_projection_delivery(
    v_recovered.correlation_id, v_recovered.claim_token,
    'linear-issue-id', 'EF-VERIFY');
  SELECT * INTO v_projected FROM public.claim_linear_projection_delivery(
    repeat('e',64), repeat('f',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_projected.claim_status <> 'existing_projected'
    OR v_projected.correlation_id IS DISTINCT FROM v_original.correlation_id
    OR v_projected.claim_token IS NOT NULL
    OR v_projected.linear_issue_id IS DISTINCT FROM 'linear-issue-id'
    OR v_projected.linear_issue_identifier IS DISTINCT FROM 'EF-VERIFY' THEN
    RAISE EXCEPTION 'identical projected Linear claim did not return the exact record';
  END IF;
END
$linear_projection_recovery_and_confirmation$;
RESET ROLE;

SET ROLE service_role;
DO $linear_projection_failed_recovery$
DECLARE
  v_plan_id uuid;
  v_first record;
  v_recovered record;
BEGIN
  SELECT plan_v2_run_id INTO STRICT v_plan_id
  FROM public.workflow_repository_plan_recommendation_reviews
  WHERE id = '94000000-0000-4000-8000-000000000001';
  SELECT * INTO v_first FROM public.claim_linear_projection_delivery(
    repeat('9',64), repeat('7',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  PERFORM public.fail_linear_projection_delivery(
    v_first.correlation_id, v_first.claim_token, 'provider_unavailable');
  SELECT * INTO v_recovered FROM public.claim_linear_projection_delivery(
    repeat('9',64), repeat('7',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_recovered.claim_status <> 'recovered'
    OR v_recovered.claim_token IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM public.linear_projection_correlations
      WHERE id = v_recovered.correlation_id AND status = 'claimed'
        AND claim_generation = 2 AND failure_count = 1
        AND last_failure_code IS NULL) THEN
    RAISE EXCEPTION 'failed Linear claim did not recover coherently';
  END IF;
  PERFORM public.confirm_linear_projection_delivery(
    v_recovered.correlation_id, v_recovered.claim_token,
    'linear-issue-failed-recovery', 'EF-RECOVERED');
END
$linear_projection_failed_recovery$;
RESET ROLE;

DO $linear_projection_projected_terminal$
DECLARE
  v_id uuid := (SELECT correlation_id FROM linear_projection_verifier_state WHERE name = 'original');
BEGIN
  BEGIN
    UPDATE public.linear_projection_correlations
    SET status = 'failed', linear_issue_id = NULL, linear_issue_identifier = NULL,
        projected_at = NULL, last_failure_code = 'forbidden'
    WHERE id = v_id;
    RAISE EXCEPTION 'projected Linear correlation escaped its terminal guard';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Projected Linear correlation permits withdrawal only' THEN RAISE; END IF;
  END;
END
$linear_projection_projected_terminal$;

SET ROLE service_role;
DO $linear_projection_withdrawal$
DECLARE
  v_id uuid := (SELECT correlation_id FROM linear_projection_verifier_state WHERE name = 'original');
BEGIN
  BEGIN
    PERFORM public.withdraw_linear_projection_delivery(v_id, repeat('0',64), 'Wrong digest.');
    RAISE EXCEPTION 'wrong request digest unexpectedly withdrew Linear projection';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
  BEGIN
    PERFORM public.withdraw_linear_projection_delivery(v_id, repeat('e',64), '   ');
    RAISE EXCEPTION 'blank withdrawal rationale unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  BEGIN
    PERFORM public.withdraw_linear_projection_delivery(v_id, repeat('e',64), repeat('x',4001));
    RAISE EXCEPTION 'oversize withdrawal rationale unexpectedly accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  PERFORM public.withdraw_linear_projection_delivery(
    v_id, repeat('e',64), 'Verifier-authorized withdrawal.');
  BEGIN
    PERFORM public.withdraw_linear_projection_delivery(
      v_id, repeat('e',64), 'Second withdrawal.');
    RAISE EXCEPTION 'withdrawn Linear row unexpectedly transitioned again';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END
$linear_projection_withdrawal$;
RESET ROLE;

DO $linear_projection_withdrawn_terminal$
DECLARE
  v_id uuid := (SELECT correlation_id FROM linear_projection_verifier_state WHERE name = 'original');
BEGIN
  BEGIN
    UPDATE public.linear_projection_correlations SET status = 'projected' WHERE id = v_id;
    RAISE EXCEPTION 'withdrawn Linear correlation escaped its terminal guard';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Withdrawn Linear correlation is terminal' THEN RAISE; END IF;
  END;
  BEGIN
    DELETE FROM public.linear_projection_correlations WHERE id = v_id;
    RAISE EXCEPTION 'withdrawn Linear correlation was deleted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'Linear projection correlations are not deletable' THEN RAISE; END IF;
  END;
END
$linear_projection_withdrawn_terminal$;

SET ROLE service_role;
DO $linear_projection_reprojection$
DECLARE
  v_plan_id uuid;
  v_original record;
  v_new record;
  v_existing record;
BEGIN
  SELECT * INTO STRICT v_original FROM linear_projection_verifier_state WHERE name = 'original';
  SELECT plan_v2_run_id INTO STRICT v_plan_id
  FROM public.workflow_repository_plan_recommendation_reviews
  WHERE id = '94000000-0000-4000-8000-000000000001';

  BEGIN
    PERFORM * FROM public.claim_linear_projection_delivery(
      repeat('e',64), repeat('0',64), v_plan_id,
      '94000000-0000-4000-8000-000000000001',
      'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
    RAISE EXCEPTION 'withdrawn Linear history allowed immutable identity rebinding';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  SELECT * INTO v_new FROM public.claim_linear_projection_delivery(
    repeat('e',64), repeat('f',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_new.claim_status <> 'acquired'
    OR v_new.correlation_id IS NOT DISTINCT FROM v_original.correlation_id THEN
    RAISE EXCEPTION 'withdrawn Linear projection did not create a distinct controlled claim';
  END IF;
  INSERT INTO linear_projection_verifier_state(name, correlation_id, claim_token)
  VALUES ('replacement', v_new.correlation_id, v_new.claim_token);
  PERFORM public.confirm_linear_projection_delivery(
    v_new.correlation_id, v_new.claim_token, 'linear-issue-id', 'EF-VERIFY');
  SELECT * INTO v_existing FROM public.claim_linear_projection_delivery(
    repeat('e',64), repeat('f',64), v_plan_id,
    '94000000-0000-4000-8000-000000000001',
    'rec_' || repeat('b',64), repeat('a',40), 'linear-verifier-project');
  IF v_existing.claim_status <> 'existing_projected'
    OR v_existing.correlation_id IS DISTINCT FROM v_new.correlation_id
    OR v_existing.claim_token IS NOT NULL
    OR v_existing.linear_issue_id IS DISTINCT FROM 'linear-issue-id'
    OR v_existing.linear_issue_identifier IS DISTINCT FROM 'EF-VERIFY' THEN
    RAISE EXCEPTION 'replacement Linear projection did not converge exactly';
  END IF;
END
$linear_projection_reprojection$;
RESET ROLE;

DO $linear_projection_final_coherence$
DECLARE
  v_original uuid := (SELECT correlation_id FROM linear_projection_verifier_state WHERE name = 'original');
  v_replacement uuid := (SELECT correlation_id FROM linear_projection_verifier_state WHERE name = 'replacement');
BEGIN
  IF (SELECT count(*) FROM public.linear_projection_correlations
      WHERE engineering_request_digest_sha256 = repeat('e',64)) <> 2
    OR (SELECT count(*) FROM public.linear_projection_correlations
        WHERE engineering_request_digest_sha256 = repeat('e',64)
          AND status = 'projected') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM public.linear_projection_correlations
      WHERE id = v_original AND status = 'withdrawn'
        AND projection_digest_sha256 = repeat('f',64)
        AND idempotency_key = 'linear-projection:' || repeat('e',64)
        AND claim_generation = 2
        AND linear_issue_id = 'linear-issue-id'
        AND linear_issue_identifier = 'EF-VERIFY'
        AND projected_at IS NOT NULL AND withdrawn_at IS NOT NULL
        AND withdrawal_rationale = 'Verifier-authorized withdrawal.'
        AND last_failure_code IS NULL AND failure_count = 0)
    OR NOT EXISTS (
      SELECT 1 FROM public.linear_projection_correlations
      WHERE id = v_replacement AND status = 'projected'
        AND projection_digest_sha256 = repeat('f',64)
        AND idempotency_key = 'linear-projection:' || repeat('e',64)
        AND claim_generation = 1
        AND linear_issue_id = 'linear-issue-id'
        AND linear_issue_identifier = 'EF-VERIFY'
        AND projected_at IS NOT NULL AND withdrawn_at IS NULL
        AND withdrawal_rationale IS NULL
        AND last_failure_code IS NULL AND failure_count = 0)
    OR EXISTS (
      SELECT 1 FROM public.linear_projection_correlations
      WHERE engineering_request_digest_sha256 = repeat('e',64)
        AND (plan_v2_run_id <> (
              SELECT plan_v2_run_id
              FROM public.workflow_repository_plan_recommendation_reviews
              WHERE id = '94000000-0000-4000-8000-000000000001')
          OR review_id <> '94000000-0000-4000-8000-000000000001'
          OR recommendation_id <> 'rec_' || repeat('b',64)
          OR repository_commit_sha <> repeat('a',40)
          OR linear_project_id <> 'linear-verifier-project')) THEN
    RAISE EXCEPTION 'Linear projection persisted state is incoherent';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.linear_projection_correlations
    WHERE engineering_request_digest_sha256 = repeat('9',64)
      AND status = 'projected' AND claim_generation = 2
      AND failure_count = 1 AND last_failure_code IS NULL
      AND linear_issue_id = 'linear-issue-failed-recovery'
      AND linear_issue_identifier = 'EF-RECOVERED'
      AND projected_at IS NOT NULL) THEN
    RAISE EXCEPTION 'recovered failed Linear projection state is incoherent';
  END IF;
END
$linear_projection_final_coherence$;

SELECT 'LINEAR PROJECTION DIRECT POSTGRESQL VERIFICATION: PASS' AS result;
